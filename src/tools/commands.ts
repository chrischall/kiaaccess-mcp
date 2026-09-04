/**
 * Door + climate command tools — the four endpoints that were exercised against
 * a live vehicle on 2026-07-27 and confirmed by re-reading `cmm/gvi`
 * (`docs/KIA-API.md`).
 *
 * Three rules shape every tool in this file:
 *
 *  1. **Confirm-gated.** Without `confirm: true` a tool makes NO network call at
 *     all — not even the baseline read — and returns a dry-run preview of the
 *     exact request that would be sent. These commands move a two-tonne object
 *     in the physical world; a hallucinated call must not fire silently.
 *  2. **Accepted ≠ confirmed.** Kia answering `statusCode: 0` only means the
 *     request was accepted. The ONLY proof a command took effect is re-reading
 *     `cmm/gvi` and diffing the proof field, so every result reports
 *     `commandAccepted` and `stateConfirmed` as separate booleans and never
 *     conflates them. `cmm/gts` is never polled: it returns global flags that
 *     never change per action, so a client that waits on it waits forever.
 *  3. **Registration is the gate.** `KIA_WRITE_MODE` decides which tools exist
 *     at all (see {@link getKiaWriteMode}). An unregistered tool cannot be
 *     invoked by any host permission setting or injected instruction.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { McpToolError, SafePathSegment, minifiedResult, readEnvVar, schemaConfirm, toolAnnotations } from '@chrischall/mcp-utils';
import { z } from 'zod';
import {
  type KiaClient,
  type KiaCommandResult,
  type KiaVehicleStatus,
  type StartClimateOptions,
  buildStartClimateBody,
  extractVehicleStatus,
} from '../client.js';
import { BASE_URL, COMMAND_SPECS, type CommandSpec, type KiaCommandName } from '../protocol.js';

/**
 * The slice of {@link KiaClient} these tools use. Structural, so a real client
 * satisfies it and a test can stand in a fake without touching the network.
 */
export type KiaCommandsClient = Pick<
  KiaClient,
  'getVehicleStatus' | 'lockDoors' | 'unlockDoors' | 'startClimate' | 'stopClimate' | 'verifyCommand'
>;

// ---------------------------------------------------------------------------
// KIA_WRITE_MODE
// ---------------------------------------------------------------------------

/** Deployment-wide ceiling on which vehicle commands are registered at all. */
export type KiaWriteMode = 'none' | 'comfort' | 'all';

/**
 * Read the command-registration gate, at registration time (startup).
 *
 *   none     No command tools are registered — the server is read-only.
 *   comfort  Climate (and charging) only. The car cannot be unlocked. Default.
 *   all      Also registers door lock/unlock.
 *
 * An unrecognised value fails CLOSED to `none`: this is a safety control, so a
 * typo must never silently grant the ability to unlock a car.
 */
export function getKiaWriteMode(): KiaWriteMode {
  const raw = readEnvVar('KIA_WRITE_MODE');
  if (raw === undefined) return 'comfort';
  const mode = raw.toLowerCase();
  if (mode === 'none' || mode === 'comfort' || mode === 'all') return mode;
  // stdio transport: stderr only — stdout is reserved for JSON-RPC.
  console.error(
    `[kiaaccess-mcp] Unrecognized KIA_WRITE_MODE "${raw}" — failing closed to "none" ` +
      '(no vehicle command tools registered). Valid values: none, comfort, all.',
  );
  return 'none';
}

// ---------------------------------------------------------------------------
// Shared argument atoms
// ---------------------------------------------------------------------------

const vinKeyArg = SafePathSegment.describe(
  'The vehicle key (`vehicleKey` from the vehicle-list tool), used as the `vinkey` header. Not the VIN.',
);

const waitSecondsArg = z
  .number()
  .int()
  .min(0)
  .max(300)
  .default(60)
  .describe(
    'How long to keep re-reading cmm/gvi for proof the command landed (default 60). Observed changes took ' +
      '30–60s. 0 checks once and returns immediately — the command may still land afterwards.',
  );

/** Every command tool takes the same three arguments plus its own options. */
const baseArgs = { vinKey: vinKeyArg, waitSeconds: waitSecondsArg, confirm: schemaConfirm };

/** Inclusive °F bounds Kia's own app offers for a remote climate start. */
export const CLIMATE_TEMP_MIN_F = 62;
export const CLIMATE_TEMP_MAX_F = 82;

/** The two out-of-range values Kia accepts in `airTemp.value` instead of a number. */
export const CLIMATE_TEMP_SENTINELS = ['LOW', 'HIGH'] as const;

const fahrenheit = z.number().int().min(CLIMATE_TEMP_MIN_F).max(CLIMATE_TEMP_MAX_F);

/**
 * Target cabin temperature: a number, a `LOW`/`HIGH` sentinel — or a
 * **string-encoded** number.
 *
 * That third branch is not decoration. This is the only argument in the server
 * whose JSON Schema is a `number | string` union, and hosts filling it were
 * observed to emit the number quoted (`"72"`). That matched neither of the first
 * two branches, so the MCP SDK rejected every plain integer with a bare
 * "Invalid input at temperature" while `LOW`/`HIGH` — already strings — worked,
 * making the parameter look like it only accepted its own sentinels.
 *
 * Accepting the quoted form and normalising it to a number keeps ONE downstream
 * shape (`airTempF: number | 'LOW' | 'HIGH'`), so nothing past this point has to
 * know the wire ever carried a string. The bounds still apply: `"55"` is
 * rejected exactly like `55`.
 */
const temperatureArg = z
  .union([
    fahrenheit,
    z.enum(CLIMATE_TEMP_SENTINELS),
    z
      .string()
      .regex(/^\d+$/, 'must be a whole number of °F, or "LOW"/"HIGH"')
      .transform(Number)
      .pipe(fahrenheit),
  ])
  .describe(
    `Target cabin temperature in °F, ${CLIMATE_TEMP_MIN_F}–${CLIMATE_TEMP_MAX_F}, or the sentinel "LOW"/"HIGH" for ` +
      'the ends of the range (default 70). A quoted whole number ("72") is accepted and treated as the number. ' +
      'BEST-EFFORT / UNCONFIRMED — see docs/KIA-API.md.',
  )
  .optional();

const NO_GTS_NOTE =
  'Proof comes from re-reading cmm/gvi and diffing the field (syncDate excluded — it advances on every read). ' +
  'cmm/gts is never polled: it reports global flags, never per-command completion.';

// ---------------------------------------------------------------------------
// Proof-field plumbing
// ---------------------------------------------------------------------------

/** Resolve a dotted path (e.g. `climate.airCtrl`) inside a vehicle status. */
function readPath(status: KiaVehicleStatus | null, path: string): unknown {
  let current: unknown = status;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * The values of every field the spec says proves this command, for reporting.
 * Missing fields become `null` rather than `undefined` so they survive JSON
 * serialisation — "we looked and it wasn't there" must not read as "we didn't
 * look". (`climate` is absent entirely unless cmm/gvi is asked for it.)
 */
function observeProof(status: KiaVehicleStatus | null, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, readPath(status, field) ?? null]));
}

/** What each command must read back for the state change to count as observed. */
type ProofExpectation = Record<string, boolean>;

/** One command tool's wire + verification plan. */
interface CommandPlan {
  command: KiaCommandName;
  /** Human-readable summary of the action, echoed in the dry-run preview. */
  action: string;
  /** The GATING check: every entry must match on the re-read. */
  expect: ProofExpectation;
  /** Request body, when the endpoint takes one. */
  body?: unknown;
}

// ---------------------------------------------------------------------------
// Dry run + execution
// ---------------------------------------------------------------------------

/**
 * The no-network branch. Renders exactly what would be sent, straight from
 * `COMMAND_SPECS` and the same body builder the real call uses, so the preview
 * can't drift from the request.
 */
function previewCommand(plan: CommandPlan, vinKey: string): CallToolResult {
  // Widened to `CommandSpec`: the `as const` literal type drops `note` from the
  // entries that don't carry one.
  const spec: CommandSpec = COMMAND_SPECS[plan.command];
  return minifiedResult({
    dryRun: true,
    action: plan.action,
    command: plan.command,
    method: spec.method,
    path: spec.path,
    url: `${BASE_URL}${spec.path}`,
    vinKey,
    ...(plan.body === undefined ? {} : { willSend: plan.body }),
    headers: 'The full static Kia header set plus `sid`, `vinkey` and the mandatory RFC 1123 `date`, added by the client.',
    endpointVerified: spec.verified,
    ...(spec.note === undefined ? {} : { endpointNote: spec.note }),
    proof: { expected: plan.expect, willAlsoReport: spec.proofFields, method: NO_GTS_NOTE },
    note: 'NO network call was made and the vehicle was not touched. Re-run with confirm: true to execute.',
  });
}

/**
 * The confirmed branch: baseline read → command → re-read until the proof field
 * flips (or the wait budget runs out).
 */
async function runCommand(
  client: KiaCommandsClient,
  plan: CommandPlan,
  args: { vinKey: string; waitSeconds: number },
  invoke: () => Promise<KiaCommandResult>,
): Promise<CallToolResult> {
  const spec = COMMAND_SPECS[plan.command];
  const { vinKey, waitSeconds } = args;

  // Baseline first: it is both the diff reference and a cheap check that this
  // vinKey exists — better to fail here than to fire a command at nothing.
  const baselineInfo = await client.getVehicleStatus(vinKey, { includeClimate: true });
  if (baselineInfo === null) {
    throw new McpToolError(`Kia returned no vehicle record for vinKey "${vinKey}" — no command was sent.`, {
      hint: 'Use the vehicle-list tool and pass its `vehicleKey` (not the VIN) as vinKey.',
    });
  }
  const baseline = extractVehicleStatus(baselineInfo);

  const result = await invoke();

  const verification = await client.verifyCommand<KiaVehicleStatus | null>(
    async () => extractVehicleStatus(await client.getVehicleStatus(vinKey, { includeClimate: true })),
    (snapshot) => Object.entries(plan.expect).every(([field, want]) => readPath(snapshot, field) === want),
    { baseline, timeoutMs: waitSeconds * 1000 },
  );

  return minifiedResult({
    action: plan.action,
    command: plan.command,
    method: result.method,
    path: result.path,
    vinKey,
    endpointVerified: result.verified,
    /** Kia accepted the request (`status.statusCode === 0`). Nothing more. */
    commandAccepted: true,
    xid: result.xid,
    /** The re-read actually showed the expected state. This is the real proof. */
    stateConfirmed: verification.verified,
    expected: plan.expect,
    observed: observeProof(verification.snapshot, spec.proofFields),
    baselineObserved: observeProof(baseline, spec.proofFields),
    changedFields: verification.changedFields,
    attempts: verification.attempts,
    elapsedSeconds: Math.round(verification.elapsedMs / 100) / 10,
    verificationMethod: NO_GTS_NOTE,
    note: verification.verified
      ? `Kia accepted the command AND the re-read confirms it: ${describeExpectation(plan.expect)}.`
      : `Kia ACCEPTED the command, but the expected state (${describeExpectation(plan.expect)}) was NOT observed ` +
        `within ${waitSeconds}s. Changes were observed to take 30–60s, so it may still land — re-read the vehicle ` +
        'status before saying anything about the car. Do not report this as done.',
  });
}

function describeExpectation(expect: ProofExpectation): string {
  return Object.entries(expect)
    .map(([field, want]) => `${field} === ${want}`)
    .join(' and ');
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

/**
 * Register the confirm-gated door + climate commands, subject to
 * `KIA_WRITE_MODE`. Door locks require `all`; climate requires `comfort` or
 * `all`; `none` (and any unrecognised value) registers nothing.
 */
export function registerCommandsTools(server: McpServer, client: KiaCommandsClient): void {
  const writeMode = getKiaWriteMode();
  if (writeMode === 'none') return;

  if (writeMode === 'all') {
    registerDoorTool(server, client, {
      name: 'kia_lock_doors',
      title: 'Lock doors',
      plan: (vinKey) => ({ command: 'lock', action: `Lock the doors of vehicle ${vinKey}`, expect: { doorLock: true } }),
      invoke: (vinKey) => client.lockDoors(vinKey),
      destructive: false,
      description:
        'Lock the vehicle doors (Kia `rems/door/lock`, live-verified). Without confirm:true this makes NO network ' +
        'call and returns a dry-run preview of the exact request; with confirm:true it sends the command and then ' +
        're-reads cmm/gvi until `doorLock` reads true. The result reports `commandAccepted` (Kia took the request) ' +
        'and `stateConfirmed` (the car actually reads locked) separately — only `stateConfirmed: true` means the ' +
        'doors are locked. State changes were observed to take 30–60s.',
    });

    registerDoorTool(server, client, {
      name: 'kia_unlock_doors',
      title: 'Unlock doors',
      plan: (vinKey) => ({
        command: 'unlock',
        action: `Unlock the doors of vehicle ${vinKey}`,
        expect: { doorLock: false },
      }),
      invoke: (vinKey) => client.unlockDoors(vinKey),
      // Unlocking is the one command here that REDUCES the car's security and
      // leaves it that way until someone acts — treat it as destructive.
      destructive: true,
      description:
        'UNLOCK the vehicle doors (Kia `rems/door/unlock`, live-verified). This leaves the car physically ' +
        'unsecured until it is locked again — only run it when the user has explicitly asked to unlock this ' +
        'vehicle. Without confirm:true this makes NO network call and returns a dry-run preview; with ' +
        'confirm:true it sends the command and re-reads cmm/gvi until `doorLock` reads false. `commandAccepted` ' +
        '(Kia took the request) and `stateConfirmed` (the car actually reads unlocked) are reported separately. ' +
        'State changes were observed to take 30–60s.',
    });
  }

  // Climate registers under `comfort` and `all`.
  server.registerTool(
    'kia_start_climate',
    {
      description:
        'Start remote climate control / preconditioning (Kia `rems/start`, live-verified). Without confirm:true ' +
        'this makes NO network call and returns a dry-run preview of the exact body; with confirm:true it sends ' +
        'the command and re-reads cmm/gvi until the NESTED `climate.airCtrl` reads true (there is no flat ' +
        '`airCtrlOn` field). On an EV `engine` stays false while climate runs — `ign3` is the ignition proxy and ' +
        'is reported alongside. `commandAccepted` (Kia took the request) and `stateConfirmed` (the car actually ' +
        'reads running) are separate; state changes were observed to take 30–60s. ' +
        'TEMPERATURE IS BEST-EFFORT AND UNCONFIRMED: per docs/KIA-API.md a start requesting 70°F still read back ' +
        '72°F, so the car may report its own last-set target rather than the requested one — do not promise the ' +
        'user a specific cabin temperature. Seat and steering-wheel/rear-window heating are not sent at all: the ' +
        'request body deliberately omits `heatVentSeat` (Kia validates seat capability per car) and leaves every ' +
        '`heatingAccessory` field at 0.',
      annotations: { ...toolAnnotations({ title: 'Start climate', readOnly: false, idempotent: true, openWorld: true }), destructiveHint: false },
      inputSchema: {
        ...baseArgs,
        temperature: temperatureArg,
        durationMinutes: z
          .number()
          .int()
          .min(1)
          .max(30)
          .default(5)
          .describe('Minutes the ignition stays on (default 5).'),
        defrost: z.boolean().default(false).describe('Run front defrost (default false).'),
      },
    },
    async ({ vinKey, waitSeconds, confirm, temperature, durationMinutes, defrost }) => {
      const options: StartClimateOptions = {
        // `airTempF` is typed `number`, but the builder stringifies it and Kia's
        // `airTemp.value` is a STRING whose domain includes the "LOW"/"HIGH"
        // sentinels outside 62–82°F. Passing the sentinel through therefore
        // produces exactly the wire value the app sends; the cast is the narrow,
        // deliberate price of not widening the frozen core type.
        airTempF: temperature as number | undefined,
        durationMinutes,
        defrost,
      };
      const plan: CommandPlan = {
        command: 'start',
        action: `Start climate on vehicle ${vinKey} (${temperature ?? 70}°F, ${durationMinutes} min${defrost ? ', defrost' : ''})`,
        expect: { 'climate.airCtrl': true },
        body: buildStartClimateBody(options),
      };
      if (confirm !== true) return previewCommand(plan, vinKey);
      return runCommand(client, plan, { vinKey, waitSeconds }, () => client.startClimate(vinKey, options));
    },
  );

  server.registerTool(
    'kia_stop_climate',
    {
      description:
        'Stop remote climate control (Kia `rems/stop`, live-verified). Without confirm:true this makes NO network ' +
        'call and returns a dry-run preview; with confirm:true it sends the command and re-reads cmm/gvi until the ' +
        'NESTED `climate.airCtrl` reads false (there is no flat `airCtrlOn` field); `ign3` — the EV ignition proxy ' +
        '— is reported alongside. `commandAccepted` (Kia took the request) and `stateConfirmed` (the car actually ' +
        'reads stopped) are separate. State changes were observed to take 30–60s.',
      annotations: { ...toolAnnotations({ title: 'Stop climate', readOnly: false, idempotent: true, openWorld: true }), destructiveHint: false },
      inputSchema: baseArgs,
    },
    async ({ vinKey, waitSeconds, confirm }) => {
      const plan: CommandPlan = {
        command: 'stop',
        action: `Stop climate on vehicle ${vinKey}`,
        expect: { 'climate.airCtrl': false },
      };
      if (confirm !== true) return previewCommand(plan, vinKey);
      return runCommand(client, plan, { vinKey, waitSeconds }, () => client.stopClimate(vinKey));
    },
  );
}

/** The two door tools differ only in their plan, invocation and risk posture. */
function registerDoorTool(
  server: McpServer,
  client: KiaCommandsClient,
  tool: {
    name: string;
    title: string;
    description: string;
    destructive: boolean;
    plan: (vinKey: string) => CommandPlan;
    invoke: (vinKey: string) => Promise<KiaCommandResult>;
  },
): void {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      annotations: {
        ...toolAnnotations({ title: tool.title, readOnly: false, idempotent: true, openWorld: true }),
        destructiveHint: tool.destructive,
      },
      inputSchema: baseArgs,
    },
    async ({ vinKey, waitSeconds, confirm }) => {
      const plan = tool.plan(vinKey);
      if (confirm !== true) return previewCommand(plan, vinKey);
      return runCommand(client, plan, { vinKey, waitSeconds }, () => tool.invoke(vinKey));
    },
  );
}

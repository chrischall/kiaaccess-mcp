/**
 * EV charging tools — `evc/gts` (read) plus the three `evc/*` commands.
 *
 * Read `docs/KIA-API.md` before changing anything here. Two facts drive the
 * whole shape of this file:
 *
 *  1. **Only `evc/gts` was verified live.** `evc/charge`, `evc/cancel` and
 *     `evc/sts` were never exercised against a real vehicle — their request
 *     shapes are inferred from the app's endpoint list. Every tool that touches
 *     one says so in its description AND in its result, so a caller can never
 *     mistake "the API returned success" for "the car did the thing".
 *  2. **`cmm/gts` is not a per-action poll.** It returns global flags that never
 *     change per command, so nothing here waits on it. The only proof a command
 *     landed is re-reading state — which for charging means `evc/gts`, and that
 *     endpoint reports only the target state of charge. So the charge-limit tool
 *     can verify itself, and start/stop charge structurally cannot.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { McpToolError, jsonResult, schemaConfirm, toolAnnotations } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { KiaChargeTarget, KiaClient, KiaCommandResult } from '../client.js';
import { BASE_URL, COMMAND_SPECS, type CommandSpec, ENDPOINTS, type KiaCommandName } from '../protocol.js';
import { getKiaWriteMode } from './commands.js';

// ---------------------------------------------------------------------------
// Schema atoms
// ---------------------------------------------------------------------------

/**
 * The vehicle key (`vehicleKey` from the vehicle list) that every vehicle-scoped
 * call sends as the `vinkey` HEADER. Constrained to printable ASCII (`!`–`~`,
 * i.e. no space, no control characters) so a caller-supplied value can never
 * smuggle a CRLF into the header block.
 */
const schemaVinKey = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[!-~]+$/, 'vinKey must be printable ASCII with no whitespace or control characters')
  .describe('Vehicle key (the `vehicleKey` from the vehicle-list tool). Not the VIN.');

/**
 * Lower bound on a target state of charge. Kia's own app offers 50–100% in 10%
 * steps; 10 is a deliberately loose floor that still rejects nonsense (a `0` or
 * a mistyped `8` meaning `80`) on an endpoint nobody has ever seen respond.
 */
const MIN_TARGET_SOC = 10;

const schemaChargeTarget = z.object({
  plugType: z
    .number()
    .int()
    .min(0)
    .max(1)
    .describe(
      'Plug type, 0 or 1 — one entry per plug type (AC and DC). Which number is which is NOT verified: ' +
        'read the current targets first and mirror the plugType values it returns.',
    ),
  targetSOClevel: z
    .number()
    .int()
    .min(MIN_TARGET_SOC)
    .max(100)
    .describe(`Target state of charge as a percentage, ${MIN_TARGET_SOC}–100 (Kia's app offers 50–100 in 10% steps).`),
});

// ---------------------------------------------------------------------------
// Shared rendering
// ---------------------------------------------------------------------------

/** The standing warning attached to every unverified endpoint's result. */
const UNVERIFIED_HINT =
  'This endpoint has never been exercised against a real vehicle, so a success status proves only that ' +
  'Kia accepted the request — not that the car acted on it. Check the car or the Kia app.';

/**
 * Confirm-gate for a mutating tool. Without `confirm: true` NO network call is
 * made and the caller gets a preview of exactly what would be sent; with it,
 * `null` is returned so the handler proceeds.
 */
function previewUnlessConfirmed(
  confirm: boolean | undefined,
  command: KiaCommandName,
  args: { vinKey: string; action: string; body?: unknown; verification: string },
): CallToolResult | null {
  if (confirm === true) return null;
  // Widened to `CommandSpec` so the optional `note` is readable across the union.
  const spec: CommandSpec = COMMAND_SPECS[command];
  return jsonResult({
    dryRun: true,
    action: args.action,
    command,
    method: spec.method,
    endpoint: spec.path,
    url: `${BASE_URL}${spec.path}`,
    vinKey: args.vinKey,
    // Dropped from the JSON when the command has no body (a GET).
    willSend: args.body,
    endpointVerified: spec.verified,
    note: spec.note,
    verification: args.verification,
    hint: 'No request was made. Re-run with confirm: true to execute.',
  });
}

/** The common result fields for an executed command. */
function describeCommand(result: KiaCommandResult): Record<string, unknown> {
  const spec: CommandSpec = COMMAND_SPECS[result.command];
  return {
    command: result.command,
    endpoint: result.path,
    method: result.method,
    endpointVerified: result.verified,
    /** Kia's action id. It is NOT pollable — `cmm/gts` never reports per-action completion. */
    xid: result.xid,
    status: result.raw.status,
    note: spec.note,
  };
}

/** Why start/stop charge cannot be proven by this server. */
const NO_VERIFICATION_POSSIBLE =
  'Not attempted: the only EV read endpoint here is evc/gts, which reports the target state of charge — ' +
  'not whether the car is charging. Nothing in this server can confirm this command took effect.';

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export function registerChargingTools(server: McpServer, client: KiaClient): void {
  // Charging commands register under `comfort` and `all`; the read below always
  // registers. The gate itself lives in `./commands.js` — one copy, shared by
  // every registrar, because two copies of a safety control drift.
  const commandsAllowed = getKiaWriteMode() !== 'none';

  server.registerTool(
    'kia_charge_targets',
    {
      description:
        `Read the EV charge targets (\`${ENDPOINTS.chargeTargets}\`): the target state of charge per plug type ` +
        '(one entry for AC, one for DC). Verified live against a real vehicle. Read-only — makes no changes.',
      annotations: toolAnnotations({ title: 'Kia EV charge targets', openWorld: true }),
      inputSchema: { vinKey: schemaVinKey },
    },
    async ({ vinKey }) => {
      const targets = await client.getChargeTargets(vinKey);
      return jsonResult({
        vinKey,
        endpoint: ENDPOINTS.chargeTargets,
        targets,
        note: 'targetSOClevel is a percentage. Which plugType is AC and which is DC is not documented by Kia.',
      });
    },
  );

  if (!commandsAllowed) return;

  server.registerTool(
    'kia_start_charge',
    {
      description:
        `Ask the vehicle to start charging (\`${COMMAND_SPECS.charge.path}\`). ` +
        'UNVERIFIED ENDPOINT: this was never exercised against a real vehicle (see docs/KIA-API.md) — the request ' +
        'shape is inferred from the Kia app, and the command may do nothing. Worse, it cannot be checked: the only ' +
        'EV read endpoint available (evc/gts) reports the target state of charge, not whether the car is charging, ' +
        'so this server cannot confirm the outcome either way. ' +
        'Without confirm:true it makes NO network call and returns a dry-run preview of exactly what would be sent.',
      annotations: toolAnnotations({
        title: 'Start Kia EV charging (unverified)',
        readOnly: false,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: {
        vinKey: schemaVinKey,
        chargeRatio: z
          .number()
          .int()
          .min(MIN_TARGET_SOC)
          .max(100)
          .describe(`Charge up to this percentage, ${MIN_TARGET_SOC}–100. Defaults to 100.`)
          .optional(),
        confirm: schemaConfirm,
      },
    },
    async ({ vinKey, chargeRatio, confirm }) => {
      const ratio = chargeRatio ?? 100;
      const gate = previewUnlessConfirmed(confirm, 'charge', {
        vinKey,
        action: `Start charging vehicle ${vinKey} to ${ratio}%`,
        body: { chargeRatio: ratio },
        verification: NO_VERIFICATION_POSSIBLE,
      });
      if (gate) return gate;

      const result = await client.startCharge(vinKey, ratio);
      return jsonResult({
        ...describeCommand(result),
        chargeRatio: ratio,
        verification: { attempted: false, reason: NO_VERIFICATION_POSSIBLE },
        hint: UNVERIFIED_HINT,
      });
    },
  );

  server.registerTool(
    'kia_stop_charge',
    {
      description:
        `Ask the vehicle to stop charging (\`${COMMAND_SPECS.cancelCharge.path}\`). ` +
        'UNVERIFIED ENDPOINT: this was never exercised against a real vehicle (see docs/KIA-API.md) — it may do ' +
        'nothing, and this server cannot confirm the outcome (evc/gts reports target state of charge, not charging ' +
        'state). Do not rely on it to stop a charge that matters. ' +
        'Without confirm:true it makes NO network call and returns a dry-run preview of exactly what would be sent.',
      annotations: toolAnnotations({
        title: 'Stop Kia EV charging (unverified)',
        readOnly: false,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: { vinKey: schemaVinKey, confirm: schemaConfirm },
    },
    async ({ vinKey, confirm }) => {
      const gate = previewUnlessConfirmed(confirm, 'cancelCharge', {
        vinKey,
        action: `Stop charging vehicle ${vinKey}`,
        verification: NO_VERIFICATION_POSSIBLE,
      });
      if (gate) return gate;

      const result = await client.cancelCharge(vinKey);
      return jsonResult({
        ...describeCommand(result),
        verification: { attempted: false, reason: NO_VERIFICATION_POSSIBLE },
        hint: UNVERIFIED_HINT,
      });
    },
  );

  server.registerTool(
    'kia_set_charge_limits',
    {
      description:
        `Set the target state of charge per plug type (\`${COMMAND_SPECS.setChargeTargets.path}\`). ` +
        'UNVERIFIED ENDPOINT: this was never exercised against a real vehicle (see docs/KIA-API.md) — the request ' +
        'shape is inferred from the Kia app. Unlike the other charge commands this one CAN be checked, and is: ' +
        'after the write the targets are re-read from evc/gts and compared, and the result reports whether the ' +
        'change actually landed. ' +
        'Without confirm:true it makes NO network call (not even the baseline read) and returns a dry-run preview ' +
        'of exactly what would be sent.',
      annotations: toolAnnotations({
        title: 'Set Kia EV charge limits (unverified)',
        readOnly: false,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: {
        vinKey: schemaVinKey,
        targets: z
          .array(schemaChargeTarget)
          .min(1)
          .max(2)
          .describe('One entry per plug type. Read the current targets first and change only what you mean to.'),
        verify: z
          .boolean()
          .describe('Re-read evc/gts afterwards to check the change landed. Defaults to true.')
          .optional(),
        confirm: schemaConfirm,
      },
    },
    async ({ vinKey, targets, verify, confirm }) => {
      const duplicate = targets.find((t, i) => targets.findIndex((o) => o.plugType === t.plugType) !== i);
      if (duplicate !== undefined) {
        throw new McpToolError(`Duplicate plugType ${duplicate.plugType} in targets — each plug type may appear once.`, {
          hint: 'Send at most one entry per plugType. Read the current charge targets to see which plug types exist.',
        });
      }

      const gate = previewUnlessConfirmed(confirm, 'setChargeTargets', {
        vinKey,
        action: `Set charge targets on vehicle ${vinKey} to ${targets.map((t) => `plug ${t.plugType} → ${t.targetSOClevel}%`).join(', ')}`,
        body: { targetSOClist: targets },
        verification: 'After the write, evc/gts is re-read and the targets compared (unless verify:false).',
      });
      if (gate) return gate;

      if (verify === false) {
        const unchecked = await client.setChargeTargets(vinKey, targets);
        return jsonResult({
          ...describeCommand(unchecked),
          requested: targets,
          verification: { attempted: false, reason: 'Caller passed verify:false, so evc/gts was not re-read.' },
          hint: UNVERIFIED_HINT,
        });
      }

      // Baseline BEFORE the write, so the change diff means something.
      const baseline = await client.getChargeTargets(vinKey);
      const result = await client.setChargeTargets(vinKey, targets);
      const check = await client.verifyCommand<KiaChargeTarget[]>(
        () => client.getChargeTargets(vinKey),
        (snapshot) =>
          targets.every((t) =>
            snapshot.some((c) => c.plugType === t.plugType && c.targetSOClevel === t.targetSOClevel),
          ),
        { baseline, timeoutMs: 30_000, intervalMs: 5_000 },
      );

      return jsonResult({
        ...describeCommand(result),
        requested: targets,
        verification: {
          attempted: true,
          verified: check.verified,
          attempts: check.attempts,
          elapsedMs: check.elapsedMs,
          changedFields: check.changedFields,
          targets: check.snapshot,
          hint: check.verified
            ? 'Confirmed by re-reading evc/gts — the requested targets are what the car reports.'
            : `Kia accepted the request but evc/gts still does not report the requested targets. ${UNVERIFIED_HINT}`,
        },
      });
    },
  );
}

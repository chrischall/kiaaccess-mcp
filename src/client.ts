/**
 * `KiaClient` — the one place that talks to the Kia Owners API.
 *
 * Shape rules this file exists to enforce (each was a live-verified trap; see
 * `docs/KIA-API.md`):
 *
 *  - **Deferred config error.** The constructor never throws and never does
 *    I/O, so the server boots (and answers `tools/list`) with no credentials
 *    configured; the error surfaces on the first request instead. The
 *    constructor is also PURE — no fetch, no randomness, no timers — because
 *    the Cloudflare Workers runtime forbids those in global scope, where a
 *    module-level singleton is constructed.
 *  - **One read path, one write path.** Every read goes through the private
 *    `request()` and every mutation through the private `command()`, so
 *    headers, the session-expiry replay and the success check can never drift
 *    apart between endpoints.
 *  - **`command()` never polls `cmm/gts`.** That endpoint returns global flags
 *    and never reports per-action completion — a client that waits on it waits
 *    forever. The only proof a command landed is re-reading `cmm/gvi` and
 *    diffing the field, which is what {@link KiaClient.verifyCommand} does.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpToolError, loadDotenvSafely, readEnvVar } from '@chrischall/mcp-utils';
import {
  type KiaCredentials,
  type OtpNotifyType,
  type SendOtpResult,
  type StartLoginResult,
  refreshSession,
  sendOtp,
  startLogin,
  verifyOtp,
} from './auth.js';
import { resolveDeviceId } from './device.js';
import {
  COMMAND_SPECS,
  ENDPOINTS,
  type FetchLike,
  type KiaCommandName,
  type KiaEnvelope,
  type KiaRawResponse,
  type KiaStatus,
  assertKiaSuccess,
  buildHeaders,
  isInvalidVehicleForSessionStatus,
  isSessionExpiredStatus,
  sendKiaRequest,
} from './protocol.js';
import { type KiaSessionIO, SidManager, diskSessionIO } from './session.js';

// Load `.env` for local dev. The try/catch guards a non-Node
// runtime, where `import.meta.url` is undefined and `fileURLToPath(undefined)`
// would throw during startup validation — there is no filesystem or `.env`
// there anyway.
try {
  await loadDotenvSafely({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });
} catch {
  /* v8 ignore next -- only reached in a non-Node runtime (Workers): no .env to load */
}

// ---------------------------------------------------------------------------
// Response shapes (only the fields this server relies on are named; everything
// else stays reachable through the index signatures).
// ---------------------------------------------------------------------------

/** An entry of `ownr/gvl`'s `payload.vehicleSummary[]`. */
export interface KiaVehicleSummary {
  /** The `vinkey` every vehicle-scoped call needs. */
  vehicleKey: string;
  vin: string;
  nickName?: string;
  modelName?: string;
  modelYear?: string;
  trim?: string;
  colorName?: string;
  mileage?: string;
  /** Used for EV detection. */
  fuelType?: number;
  telematicsUnit?: number;
  enrollmentStatus?: number;
  generation?: number;
  [key: string]: unknown;
}

/**
 * One seat's heat/vent state, inside {@link KiaClimateStatus.heatVentSeat}.
 *
 * **The encoding is UNVERIFIED.** `docs/KIA-API.md` records a single observed
 * sample (`{ heatVentType: 0, heatVentLevel: 1 }`), which pins down neither
 * which `heatVentType` means heating rather than ventilation nor which
 * `heatVentLevel` means off. Both values are therefore passed through as
 * numbers and never translated into words — see `registerVehiclesTools`.
 */
export interface KiaSeatHeatVent {
  heatVentType?: number;
  heatVentLevel?: number;
  [key: string]: unknown;
}

/**
 * The nested climate block. There is **no flat `airCtrlOn` field** — reading one
 * yields `undefined`, which compares equal across a command and looks like "no
 * change". The whole `climate` object is ABSENT unless `cmm/gvi` is called with
 * `vehicleConfigReq.airTempRange: "1"` and `seatHeatCoolOption: "1"`.
 */
export interface KiaClimateStatus {
  airCtrl?: boolean;
  defrost?: boolean;
  airTemp?: { value?: string; unit?: number };
  /**
   * Per-seat heat/vent state, keyed by seat position (`driverSeat`,
   * `passengerSeat`, …). Gated on the same `seatHeatCoolOption: "1"` flag as the
   * rest of this block, so it arrives on every climate-bearing read.
   *
   * Absent does NOT mean the car has no heated seats: that is a *capability*
   * question, and capability lives in `cmm/gvi`'s `vehicleFeature` block, which
   * this server does not currently request.
   */
  heatVentSeat?: Record<string, KiaSeatHeatVent>;
  [key: string]: unknown;
}

/** `lastVehicleInfo.vehicleStatusRpt.vehicleStatus`. */
export interface KiaVehicleStatus {
  doorLock?: boolean;
  /** The ignition proxy. On an EV `engine` stays false with climate running. */
  ign3?: boolean;
  engine?: boolean;
  climate?: KiaClimateStatus;
  /** Advances on EVERY read — never include it in change detection. */
  syncDate?: unknown;
  [key: string]: unknown;
}

/** An entry of `cmm/gvi`'s `payload.vehicleInfoList[]`. */
export interface KiaVehicleInfo {
  vinKey: string;
  vehicleConfig?: Record<string, unknown>;
  lastVehicleInfo?: {
    vehicleNickName?: string;
    vehicleStatusRpt?: { vehicleStatus?: KiaVehicleStatus; [key: string]: unknown };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** An entry of `evc/gts`'s `payload.targetSOClist[]`. */
export interface KiaChargeTarget {
  plugType: number;
  targetSOClevel: number;
}

/** What every mutation returns. `xid` is the `Xid` RESPONSE header. */
export interface KiaCommandResult {
  command: KiaCommandName;
  path: string;
  method: 'GET' | 'POST';
  /** Whether this endpoint was exercised against a live vehicle. */
  verified: boolean;
  /** Kia's action id, or `null` when the header was absent. */
  xid: string | null;
  /** The raw success envelope. Kia's body carries no result detail. */
  raw: KiaEnvelope;
}

// ---------------------------------------------------------------------------
// Body builders (exported so tool registrars can render an accurate dry-run
// preview of exactly what would be sent).
// ---------------------------------------------------------------------------

/**
 * `cmm/gvi` request body. `drivingActivty` is misspelled **in the API itself**;
 * correcting it silently drops the field.
 */
export function buildVehicleStatusBody(vinKey: string, opts?: { includeClimate?: boolean }): unknown {
  const climate = opts?.includeClimate === false ? '0' : '1';
  return {
    vehicleConfigReq: {
      airTempRange: climate,
      maintenance: '1',
      seatHeatCoolOption: climate,
      vehicle: '1',
      vehicleFeature: '0',
    },
    vehicleInfoReq: {
      drivingActivty: '0',
      dtc: '1',
      enrollment: '1',
      functionalCards: '0',
      location: '1',
      vehicleStatus: '1',
      weather: '0',
    },
    vinKey: [vinKey],
  };
}

/** Options for {@link buildStartClimateBody} / {@link KiaClient.startClimate}. */
export interface StartClimateOptions {
  /**
   * Target temperature in °F (default 70). **Best-effort:** a start requesting
   * 70 still read back 72, so the car may be reporting its own last-set target.
   */
  airTempF?: number;
  defrost?: boolean;
  /** Minutes the ignition stays on (default 5). */
  durationMinutes?: number;
}

/**
 * `rems/start` request body. Seat settings are deliberately omitted — Kia
 * validates seat capability per car and accepts the key being absent.
 */
export function buildStartClimateBody(opts: StartClimateOptions = {}): unknown {
  return {
    remoteClimate: {
      airTemp: { unit: 1, value: String(opts.airTempF ?? 70) },
      airCtrl: true,
      defrost: opts.defrost ?? false,
      heatingAccessory: { rearWindow: 0, sideMirror: 0, steeringWheel: 0, steeringWheelStep: 0 },
      ignitionOnDuration: { unit: 4, value: opts.durationMinutes ?? 5 },
    },
  };
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

/**
 * Keys excluded from before/after comparison at every depth. `syncDate`
 * advances on EVERY read whether or not anything happened — including it makes
 * *every* command report success.
 */
export const CHANGE_DETECTION_EXCLUDED_KEYS: readonly string[] = ['syncDate'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectDiff(before: unknown, after: unknown, path: string, out: string[]): void {
  if (isRecord(before) && isRecord(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (CHANGE_DETECTION_EXCLUDED_KEYS.includes(key)) continue;
      collectDiff(before[key], after[key], path ? `${path}.${key}` : key, out);
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    before.forEach((item, index) => collectDiff(item, after[index], `${path}[${index}]`, out));
    return;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) out.push(path || '(root)');
}

/**
 * Dotted paths of every field that differs between two snapshots, ignoring
 * {@link CHANGE_DETECTION_EXCLUDED_KEYS}. This diff — not `cmm/gts` — is the
 * only proof a command took effect.
 */
export function diffIgnoringSyncDate(before: unknown, after: unknown): string[] {
  const out: string[] = [];
  collectDiff(before, after, '', out);
  return out;
}

/** Dig the nested `vehicleStatus` out of a `cmm/gvi` record. */
export function extractVehicleStatus(info: KiaVehicleInfo | null): KiaVehicleStatus | null {
  return info?.lastVehicleInfo?.vehicleStatusRpt?.vehicleStatus ?? null;
}

/** Options for {@link KiaClient.verifyCommand}. */
export interface VerifyCommandOptions<T> {
  /**
   * Snapshot taken BEFORE the command, used for the change diff. Defaults to
   * the first post-command read.
   */
  baseline?: T;
  /** Give up after this long (default 60s — observed changes land in 30–60s). */
  timeoutMs?: number;
  /** Delay between re-reads (default 5s). */
  intervalMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for tests. */
  now?: () => number;
}

/** Outcome of a re-read-and-diff verification. */
export interface VerifyCommandResult<T> {
  verified: boolean;
  /** Number of re-reads performed. */
  attempts: number;
  elapsedMs: number;
  /** The last snapshot read. */
  snapshot: T;
  /** Fields that changed vs. the baseline, `syncDate` excluded. */
  changedFields: string[];
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Constructor options. Every field is optional so `new KiaClient()` is valid. */
export interface KiaClientOptions {
  /** Overrides `KIA_USERNAME`. */
  username?: string;
  /** Overrides `KIA_PASSWORD`. */
  password?: string;
  /** Pre-bootstrapped remember-me token; skips the session store entirely. */
  rmtoken?: string;
  /** Overrides the persisted/`KIA_DEVICE_ID` device uuid. */
  deviceId?: string;
  /** Fetch seam for tests. */
  fetchImpl?: FetchLike;
  /** Persistence seam — {@link diskSessionIO} by default. */
  sessionIO?: KiaSessionIO;
  /** Override the assumed `sid` lifetime. */
  sidTtlMs?: number;
}

/** One outbound Kia call, as {@link KiaClient.dispatch} takes it. */
interface KiaRequestOptions {
  method: 'GET' | 'POST';
  body?: unknown;
  /** Sent as the `vinkey` header; also enables the rotated-key recovery. */
  vinKey?: string;
  /**
   * Builds the body from the key actually being sent, for an endpoint that
   * carries the key IN the body as well as the header — `cmm/gvi` is the only
   * one. Such an endpoint supplies this INSTEAD of `body`, so a remapped header
   * can never end up over a body naming a different vehicle.
   */
  bodyForVinKey?: (vinKey: string) => unknown;
}

export class KiaClient {
  private readonly opts: KiaClientOptions;
  private readonly sessionIO: KiaSessionIO;

  // Lazily-resolved state. NOTHING is computed in the constructor: the module
  // singleton is built in Workers global scope, where I/O, randomness and
  // timers are forbidden.
  private credentialsResolved = false;
  private configError: McpToolError | undefined;
  private credentials: KiaCredentials | undefined;
  private cachedDeviceId: string | undefined;
  private cachedRmToken: string | null | undefined;
  private cachedSids: SidManager | undefined;

  // Session-scoped vinkey state — see `resolveSessionVinKey`. `vinByVehicleKey`
  // is NOT session-scoped on purpose: it is how a key from a dead session is
  // traced back to the car it named, so it must outlive that session.
  private readonly vinByVehicleKey = new Map<string, string>();
  private vinKeyRemap = new Map<string, string>();
  private vinKeyRemapGeneration = -1;

  constructor(opts: KiaClientOptions = {}) {
    this.opts = opts;
    this.sessionIO = opts.sessionIO ?? diskSessionIO;
  }

  // -- configuration --------------------------------------------------------

  /**
   * Resolve credentials once, storing (not throwing) a config error when they
   * are absent. The stored error is rethrown by {@link requireCredentials} at
   * request time.
   */
  private resolveCredentials(): void {
    if (this.credentialsResolved) return;
    this.credentialsResolved = true;
    const username = this.opts.username ?? readEnvVar('KIA_USERNAME');
    const password = this.opts.password ?? readEnvVar('KIA_PASSWORD');
    const missing = [
      ...(username ? [] : ['KIA_USERNAME']),
      ...(password ? [] : ['KIA_PASSWORD']),
    ];
    if (missing.length > 0) {
      this.configError = new McpToolError(
        `kiaaccess-mcp is not configured: ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set.`,
        {
          hint:
            'Copy .env.example to .env and fill in your Kia Owners credentials. Double-check them first: ' +
            'Kia counts failed logins and escalates to reCAPTCHA, which breaks this server permanently.',
        },
      );
      return;
    }
    this.credentials = { username: username as string, password: password as string };
  }

  /** Credentials, or the deferred config error. */
  private requireCredentials(): KiaCredentials {
    this.resolveCredentials();
    if (this.configError) throw this.configError;
    return this.credentials as KiaCredentials;
  }

  /** Whether credentials are present, without throwing. */
  isConfigured(): boolean {
    this.resolveCredentials();
    return this.configError === undefined;
  }

  /** Kia account id (the login email), lowercased. Throws if unconfigured. */
  private get accountId(): string {
    return this.requireCredentials().username.trim().toLowerCase();
  }

  /** Device uuid — resolved (and possibly persisted) on first use, never at construction. */
  private get deviceId(): string {
    return (this.cachedDeviceId ??= this.opts.deviceId ?? resolveDeviceId());
  }

  /** Non-throwing config snapshot for a healthcheck / diagnostics tool. */
  describeConfig(): { accountId: string | null; deviceId: string; configured: boolean; hasSession: boolean } {
    const configured = this.isConfigured();
    return {
      accountId: configured ? this.accountId : null,
      deviceId: this.deviceId,
      configured,
      hasSession: this.hasSession(),
    };
  }

  // -- session --------------------------------------------------------------

  private loadRmToken(): string | null {
    if (this.cachedRmToken === undefined) {
      this.cachedRmToken = this.opts.rmtoken ?? this.sessionIO.load(this.accountId)?.rmtoken ?? null;
    }
    return this.cachedRmToken;
  }

  private requireRmToken(): string {
    const rmtoken = this.loadRmToken();
    if (!rmtoken) {
      throw new McpToolError(
        'No Kia session: this account has never completed the one-time MFA bootstrap on this device.',
        {
          hint:
            'Run the login bootstrap once (start login → send OTP → verify OTP). The resulting remember-me ' +
            'token is stored locally and re-used indefinitely, so MFA is not needed again.',
        },
      );
    }
    return rmtoken;
  }

  /** Whether a remember-me token is available (no MFA bootstrap needed). */
  hasSession(): boolean {
    if (!this.isConfigured()) return false;
    return this.loadRmToken() !== null;
  }

  /**
   * The remember-me token, for a caller that must persist it elsewhere (a
   * hosted deployment stores it with the user's other credentials).
   *
   * **Secret.** Never return this from an MCP tool — it is a full MFA bypass.
   */
  exportRmToken(): string | null {
    if (!this.isConfigured()) return null;
    return this.loadRmToken();
  }

  /** Forget the stored session; the next call needs a fresh MFA bootstrap. */
  forgetSession(): void {
    if (!this.isConfigured()) return;
    this.sessionIO.clear(this.accountId);
    this.cachedRmToken = null;
    this.cachedSids = undefined;
  }

  private adoptRmToken(rmtoken: string): void {
    if (rmtoken === this.cachedRmToken) return;
    this.cachedRmToken = rmtoken;
    this.sessionIO.save({
      accountId: this.accountId,
      rmtoken,
      deviceId: this.deviceId,
      updatedAt: new Date().toISOString(),
    });
  }

  /** Single-flight `sid` minting, built on first use. */
  private get sids(): SidManager {
    return (this.cachedSids ??= new SidManager({
      ttlMs: this.opts.sidTtlMs,
      mint: async () => {
        const credentials = this.requireCredentials();
        const rmtoken = this.requireRmToken();
        const result = await refreshSession(rmtoken, credentials, this.deviceId, { fetchImpl: this.opts.fetchImpl });
        this.adoptRmToken(result.rmtoken);
        return result.sid;
      },
    }));
  }

  // -- MFA bootstrap --------------------------------------------------------

  /** Step 1 of the one-time bootstrap. Returns the `otpKey` and `xid`. */
  beginLogin(): Promise<StartLoginResult> {
    return startLogin(this.requireCredentials(), this.deviceId, { fetchImpl: this.opts.fetchImpl });
  }

  /** Step 2 — deliver the passcode by SMS or email. */
  sendLoginOtp(args: { otpKey: string; xid: string; notifyType: OtpNotifyType }): Promise<SendOtpResult> {
    this.requireCredentials();
    return sendOtp(args, this.deviceId, { fetchImpl: this.opts.fetchImpl });
  }

  /**
   * Step 3 — verify the passcode and persist the resulting remember-me token.
   *
   * Deliberately returns NO secret: the `sid` and `rmtoken` stay inside the
   * client so a tool cannot echo them into a transcript.
   */
  async completeLogin(args: { otpKey: string; xid: string; otp: string }): Promise<{
    accountId: string;
    deviceId: string;
    persisted: boolean;
  }> {
    this.requireCredentials();
    const { rmtoken } = await verifyOtp(args, this.deviceId, { fetchImpl: this.opts.fetchImpl });
    this.adoptRmToken(rmtoken);
    // Drop any SidManager built against the previous token.
    this.cachedSids = undefined;
    return { accountId: this.accountId, deviceId: this.deviceId, persisted: true };
  }

  // -- transport ------------------------------------------------------------

  /**
   * One authenticated round-trip: fresh headers (including the mandatory
   * `date`), the `sid` from {@link SidManager}, and one reactive re-mint +
   * replay if the body reports an expired session. Success is NOT asserted here
   * — {@link dispatch} needs to inspect a failing body first.
   */
  private send(path: string, opts: KiaRequestOptions): Promise<KiaRawResponse> {
    return this.sids.withSid(
      (sid) =>
        sendKiaRequest(path, {
          method: opts.method,
          headers: buildHeaders(this.deviceId, { sid, vinkey: opts.vinKey }),
          body: opts.body,
          fetchImpl: this.opts.fetchImpl,
        }),
      (response) => isSessionExpiredStatus(statusOf(response.body)),
    );
  }

  /**
   * The authenticated round-trip plus the two recoveries, then the body-level
   * success check (`status.statusCode === 0`, never the HTTP status).
   *
   * The second recovery is the vinkey one. Kia rotates every `vehicleKey`
   * whenever a `sid` is minted, so a key the caller read from `ownr/gvl` under
   * an earlier session comes back `Invalid vehicle for current session`
   * (errorCode 1005). We re-resolve the key against a fresh `ownr/gvl` under the
   * CURRENT session and replay exactly once.
   *
   * What must NOT happen here is a re-authentication: that mints a new session,
   * which rotates the keys again, so the "fix" would destroy the very key it
   * just fetched. That was the original bug — 1005's message contains the word
   * "session", so the expiry heuristic above swallowed it and every attempt made
   * the account's `vehicleKey` change again. `isSessionExpiredStatus` now
   * excludes 1005 explicitly, and this is what handles it instead.
   */
  private async dispatch<T>(
    path: string,
    opts: KiaRequestOptions,
  ): Promise<{ envelope: KiaEnvelope<T>; xid: string | null }> {
    // Surface the deferred config error before anything else happens.
    this.requireCredentials();

    const raw =
      opts.vinKey === undefined ? await this.send(path, opts) : await this.sendVehicleScoped(path, opts, opts.vinKey);

    return { envelope: assertKiaSuccess<T>(raw.body, path), xid: raw.headers.get('xid') };
  }

  /**
   * A call carrying a `vinkey`, with the rotated-key recovery described on
   * {@link dispatch}.
   *
   * The body is derived from whichever key is actually being sent, at BOTH the
   * initial send and the replay. `cmm/gvi` repeats the key inside its body, and
   * a request whose header and body name different vehicles is exactly the
   * failure this recovery exists to prevent — so there is deliberately no path
   * that sends a caller-built body alongside a key the caller did not supply.
   */
  private async sendVehicleScoped(path: string, opts: KiaRequestOptions, requested: string): Promise<KiaRawResponse> {
    const bodyFor = (key: string): unknown => (opts.bodyForVinKey === undefined ? opts.body : opts.bodyForVinKey(key));

    const vinKey = this.currentVinKey(requested);
    const raw = await this.send(path, { ...opts, vinKey, body: bodyFor(vinKey) });
    if (!isInvalidVehicleForSessionStatus(statusOf(raw.body))) return raw;

    const fresh = await this.resolveSessionVinKey(vinKey);
    if (fresh === null) return raw;

    // Cached under the CALLER's key rather than the one that was rejected, so
    // their key keeps resolving in a single hop instead of growing a chain.
    this.rememberRemap(requested, fresh);
    return this.send(path, { ...opts, vinKey: fresh, body: bodyFor(fresh) });
  }

  /** Every READ goes through here. */
  private async request<T>(path: string, opts: KiaRequestOptions): Promise<KiaEnvelope<T>> {
    return (await this.dispatch<T>(path, opts)).envelope;
  }

  /**
   * Every MUTATION goes through here.
   *
   * Note what is absent: no `cmm/gts` poll. That endpoint returns global flags
   * that never change per action, so gating a command's result on it waits
   * forever. Callers prove the effect with {@link verifyCommand} instead.
   */
  private async command(name: KiaCommandName, opts: { vinKey: string; body?: unknown }): Promise<KiaCommandResult> {
    const spec = COMMAND_SPECS[name];
    const { envelope, xid } = await this.dispatch(spec.path, {
      method: spec.method,
      body: opts.body,
      vinKey: opts.vinKey,
    });
    return { command: name, path: spec.path, method: spec.method, verified: spec.verified, xid, raw: envelope };
  }

  // -- vinkey rotation ------------------------------------------------------

  /**
   * Note the `vehicleKey` → `vin` pairing of every vehicle a list read returned.
   *
   * The VIN is the only stable identity Kia exposes: `vehicleKey` rotates with
   * the session, so this map is what lets a key from a dead session be traced to
   * the car it named and re-pointed at that car's current key.
   */
  private rememberVehicleKeys(vehicles: readonly KiaVehicleSummary[]): void {
    for (const vehicle of vehicles) {
      if (vehicle.vehicleKey && vehicle.vin) this.vinByVehicleKey.set(vehicle.vehicleKey, vehicle.vin);
    }
  }

  /**
   * Drop the remap if the `sid` has changed since it was learned.
   *
   * That is exactly when Kia rotates the keys, so a remap from the previous
   * session points at a key which is now just as dead as the one it replaced.
   */
  private syncRemapGeneration(): void {
    const generation = this.sids.generation;
    if (generation === this.vinKeyRemapGeneration) return;
    this.vinKeyRemap = new Map();
    this.vinKeyRemapGeneration = generation;
  }

  /** The key to actually send for a caller-supplied one, after any remap. */
  private currentVinKey(vinKey: string): string {
    this.syncRemapGeneration();
    return this.vinKeyRemap.get(vinKey) ?? vinKey;
  }

  /** Cache a resolved key for the rest of this session. */
  private rememberRemap(requested: string, resolved: string): void {
    // The list read that produced `resolved` may itself have re-minted the sid,
    // so re-check the generation before caching against it.
    this.syncRemapGeneration();
    this.vinKeyRemap.set(requested, resolved);
  }

  /**
   * Re-resolve a rejected `vinkey` against a fresh `ownr/gvl`, or `null` when no
   * unambiguous answer exists (in which case the caller lets Kia's own error
   * stand rather than guessing at which car was meant).
   *
   * Pure lookup — caching is the caller's business, because the useful cache key
   * is the one the CALLER supplied, not the (possibly already remapped) one that
   * was rejected here.
   *
   * The list read runs on the current `sid` and carries no `vinkey` of its own,
   * so it cannot re-enter this path.
   */
  private async resolveSessionVinKey(rejected: string): Promise<string | null> {
    const vehicles = await this.listVehicles();

    // Still listed: the key is current, so 1005 means something else entirely
    // and a replay would just fail the same way.
    if (vehicles.some((vehicle) => vehicle.vehicleKey === rejected)) return null;

    const vin = this.vinByVehicleKey.get(rejected);
    const match = vin === undefined ? undefined : vehicles.find((vehicle) => vehicle.vin === vin);
    // With exactly one enrolled car there is nothing to disambiguate, which
    // covers a key supplied from outside this process (a transcript, a restart)
    // that was never seen in a list read here.
    return match?.vehicleKey ?? (vehicles.length === 1 ? vehicles[0].vehicleKey : null);
  }

  // -- reads ----------------------------------------------------------------

  /**
   * `ownr/gvl` — the enrolled vehicles. `vehicleKey` is the `vinkey`.
   *
   * **The returned `vehicleKey`s are only valid for the current session.** Kia
   * rotates them whenever a `sid` is minted; {@link rememberVehicleKeys} records
   * the VIN behind each one so a key that outlives its session can still be
   * re-pointed at the right car instead of failing.
   */
  async listVehicles(): Promise<KiaVehicleSummary[]> {
    const envelope = await this.request<{ vehicleSummary?: KiaVehicleSummary[] }>(ENDPOINTS.vehicleList, {
      method: 'GET',
    });
    const vehicles = envelope.payload?.vehicleSummary ?? [];
    this.rememberVehicleKeys(vehicles);
    return vehicles;
  }

  /**
   * `cmm/gvi` — the cached vehicle status. Requested with the climate-bearing
   * config flags by default; without them the whole `climate` object is absent.
   */
  async getVehicleStatus(vinKey: string, opts?: { includeClimate?: boolean }): Promise<KiaVehicleInfo | null> {
    const envelope = await this.request<{ vehicleInfoList?: KiaVehicleInfo[] }>(ENDPOINTS.vehicleStatus, {
      method: 'POST',
      // This endpoint repeats the key inside its body, so the body is built from
      // whichever key is actually sent rather than passed in ready-made. There
      // is deliberately no `body` here to fall out of sync with the header once
      // a remap is in play (see KiaRequestOptions.bodyForVinKey).
      bodyForVinKey: (key) => buildVehicleStatusBody(key, opts),
      vinKey,
    });
    return envelope.payload?.vehicleInfoList?.[0] ?? null;
  }

  /** `rems/rvs` — wake the telematics unit for a fresh (slower) read. */
  async forceVehicleRefresh(vinKey: string): Promise<KiaEnvelope> {
    return this.request(ENDPOINTS.forceRefresh, { method: 'POST', body: { requestType: 0 }, vinKey });
  }

  /** `evc/gts` — the per-plug-type target state of charge. */
  async getChargeTargets(vinKey: string): Promise<KiaChargeTarget[]> {
    const envelope = await this.request<{ targetSOClist?: KiaChargeTarget[] }>(ENDPOINTS.chargeTargets, {
      method: 'GET',
      vinKey,
    });
    return envelope.payload?.targetSOClist ?? [];
  }

  // -- commands (verified) --------------------------------------------------

  /** Lock the doors. Proven by `doorLock` going `false` → `true`. */
  lockDoors(vinKey: string): Promise<KiaCommandResult> {
    return this.command('lock', { vinKey });
  }

  /** Unlock the doors. Proven by `doorLock` going `true` → `false`. */
  unlockDoors(vinKey: string): Promise<KiaCommandResult> {
    return this.command('unlock', { vinKey });
  }

  /** Start remote climate. Proven by `climate.airCtrl` and `ign3` going true. */
  startClimate(vinKey: string, opts: StartClimateOptions = {}): Promise<KiaCommandResult> {
    return this.command('start', { vinKey, body: buildStartClimateBody(opts) });
  }

  /** Stop remote climate. Proven by `climate.airCtrl` and `ign3` going false. */
  stopClimate(vinKey: string): Promise<KiaCommandResult> {
    return this.command('stop', { vinKey });
  }

  // -- EV charge commands (verified 2026-07-28 against a plugged-in vehicle) --

  /**
   * Start charging to `chargeRatio` percent.
   *
   * Requires the car to be plugged in: unplugged, Kia still answers
   * `statusCode: 0` and nothing happens. Confirm via `evStatus.batteryCharge`
   * in a subsequent `getVehicleStatus` — not via `evc/gts`, which reports the
   * TARGET state of charge rather than whether the car is charging.
   */
  startCharge(vinKey: string, chargeRatio = 100): Promise<KiaCommandResult> {
    return this.command('charge', { vinKey, body: { chargeRatio } });
  }

  /**
   * Cancel charging. Confirm via `evStatus.batteryCharge` going false.
   */
  cancelCharge(vinKey: string): Promise<KiaCommandResult> {
    return this.command('cancelCharge', { vinKey });
  }

  /**
   * Set the per-plug-type target state of charge.
   *
   * REPLACES the stored list — pass an entry for every plug type you want to
   * keep, or the omitted one is dropped. Verifiable by re-reading `evc/gts`.
   */
  setChargeTargets(vinKey: string, targetSOClist: KiaChargeTarget[]): Promise<KiaCommandResult> {
    return this.command('setChargeTargets', { vinKey, body: { targetSOClist } });
  }

  // -- verification ---------------------------------------------------------

  /**
   * Prove a command took effect by re-reading and diffing — the ONLY reliable
   * proof, since `cmm/gts` never reports per-action completion.
   *
   * `syncDate` is excluded from the diff at every depth: it advances on every
   * read, so including it makes every command falsely report success.
   */
  async verifyCommand<T>(
    readFn: () => Promise<T>,
    predicate: (snapshot: T) => boolean,
    opts: VerifyCommandOptions<T> = {},
  ): Promise<VerifyCommandResult<T>> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const intervalMs = opts.intervalMs ?? 5_000;
    const sleep = opts.sleep ?? defaultSleep;
    const now = opts.now ?? Date.now;
    const started = now();

    let snapshot = await readFn();
    let attempts = 1;
    const baseline = opts.baseline ?? snapshot;
    let verified = predicate(snapshot);

    while (!verified && now() - started + intervalMs <= timeoutMs) {
      await sleep(intervalMs);
      snapshot = await readFn();
      attempts += 1;
      verified = predicate(snapshot);
    }

    return {
      verified,
      attempts,
      elapsedMs: now() - started,
      snapshot,
      changedFields: diffIgnoringSyncDate(baseline, snapshot),
    };
  }
}

/** Read the `status` block off an unvalidated body, defaulting to "success". */
function statusOf(body: unknown): KiaStatus {
  const status = (body as { status?: KiaStatus } | null | undefined)?.status;
  return typeof status?.statusCode === 'number' ? status : { statusCode: 0 };
}

/**
 * Module-level singleton for the stdio server. Construction is side-effect-free
 * (see the class docs), so importing this is safe in any runtime.
 */
export const client = new KiaClient();

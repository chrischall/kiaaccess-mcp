/**
 * Wire-level constants and helpers for the Kia Owners API
 * (`api.owners.kia.com/apigw/v1/`) — the undocumented API behind the Kia Access
 * iOS app. Every shape here was verified live against a 2024 EV9 — reads, auth
 * and the door/climate commands on 2026-07-27, the EV charge commands on
 * 2026-07-28; see `docs/KIA-API.md`, which is the ground truth for this file.
 *
 * Kept as a leaf module (no imports from `client.ts` / `auth.ts`) so both the
 * authentication bootstrap and the authenticated client can share it without an
 * import cycle.
 */

import { McpToolError, truncateErrorMessage } from '@chrischall/mcp-utils';

/** API root. Ends in `/` so endpoint paths concatenate directly. */
export const BASE_URL = 'https://api.owners.kia.com/apigw/v1/';

/**
 * Sent on **every** call, authenticated or not. These are the current iOS
 * client's values, accepted as of 2026-07-27. `secretkey` is a static app key
 * baked into the shipped app — it is not a user secret.
 *
 * Not included here because they are computed per request: `date`, `offset`,
 * `deviceid`, `clientuuid` (see {@link buildHeaders}).
 */
export const KIA_STATIC_HEADERS = {
  'content-type': 'application/json;charset=utf-8',
  accept: 'application/json',
  'accept-language': 'en-US,en;q=0.9',
  'accept-charset': 'utf-8',
  apptype: 'L',
  appversion: '7.22.0',
  clientid: 'SPACL716-APL',
  from: 'SPA',
  host: 'api.owners.kia.com',
  language: '0',
  ostype: 'iOS',
  osversion: '15.8.5',
  phonebrand: 'iPhone',
  secretkey: 'sydnat-9kykci-Kuhtep-h5nK',
  to: 'APIGW',
  tokentype: 'A',
  'user-agent': 'KIAPrimo_iOS/37 CFNetwork/1335.0.3.4 Darwin/21.6.0',
} as const;

/** Omitting the mandatory `date` header fails every call with this code. */
export const KIA_ERROR_MISSING_HEADER_DATA = 9200;

/**
 * Wrong password. `payload.loginAttempt` increments on each one and
 * `payload.enforceRecaptcha` flips once the count is exceeded — at which point
 * server-side login is permanently broken. NEVER auto-retry this.
 */
export const KIA_ERROR_INVALID_CREDENTIALS = 1001;

/** Email rejected on format/domain before the credentials are even checked. */
export const KIA_ERROR_INVALID_EMAIL = 1037;

/** The error codes that mean "Kia rejected these credentials" — never retried. */
export const CREDENTIAL_REJECTION_ERROR_CODES: readonly number[] = [
  KIA_ERROR_INVALID_CREDENTIALS,
  KIA_ERROR_INVALID_EMAIL,
];

/**
 * The `status` block every response carries. **Success is
 * `statusCode === 0` in the BODY** — the HTTP status is 200 even on failure, so
 * nothing may gate on `response.ok` alone.
 */
export interface KiaStatus {
  statusCode: number;
  errorType?: number;
  errorCode?: number;
  errorMessage?: string;
}

/** Standard response envelope: a `status` block plus an optional `payload`. */
export interface KiaEnvelope<T = unknown> {
  status: KiaStatus;
  payload?: T;
}

/** Endpoint paths used by this server, relative to {@link BASE_URL}. */
export const ENDPOINTS = {
  authUser: 'prof/authUser',
  sendOtp: 'cmm/sendOTP',
  verifyOtp: 'cmm/verifyOTP',
  vehicleList: 'ownr/gvl',
  vehicleStatus: 'cmm/gvi',
  forceRefresh: 'rems/rvs',
  chargeTargets: 'evc/gts',
} as const;

/** A mutating endpoint plus how its effect is proven. */
export interface CommandSpec {
  path: string;
  method: 'GET' | 'POST';
  /**
   * `true` only for commands exercised against the live vehicle and confirmed
   * by re-reading their {@link CommandSpec.proofFields}. Unverified commands
   * must say so in their tool descriptions. Every command here is now verified
   * (doors + climate 2026-07-27, charging 2026-07-28 against a plugged-in car),
   * but the flag stays: a future endpoint added from documentation rather than
   * from a live run must be able to declare itself unproven.
   */
  verified: boolean;
  /**
   * Fields inside `lastVehicleInfo.vehicleStatusRpt.vehicleStatus` whose change
   * proves the command landed. `cmm/gts` is NOT a per-action poll and never
   * reports completion — re-reading `cmm/gvi` is the only proof.
   */
  proofFields: readonly string[];
  /** Human-readable note surfaced in tool descriptions / dry-run previews. */
  note?: string;
}

/**
 * Every mutating endpoint this server can call. Exported so tool registrars can
 * render an accurate dry-run preview (path + method + verification status)
 * without duplicating wire knowledge.
 */
export const COMMAND_SPECS = {
  lock: {
    path: 'rems/door/lock',
    method: 'GET',
    verified: true,
    proofFields: ['doorLock'],
  },
  unlock: {
    path: 'rems/door/unlock',
    method: 'GET',
    verified: true,
    proofFields: ['doorLock'],
  },
  start: {
    path: 'rems/start',
    method: 'POST',
    verified: true,
    // On an EV `engine` stays false with climate running — `ign3` is the
    // ignition proxy. Climate state is NESTED under `climate.airCtrl`; there is
    // no flat `airCtrlOn` field.
    proofFields: ['climate.airCtrl', 'ign3'],
    note: 'Temperature is best-effort: a start requesting 70 still read back 72.',
  },
  stop: {
    path: 'rems/stop',
    method: 'GET',
    verified: true,
    proofFields: ['climate.airCtrl', 'ign3'],
  },
  charge: {
    path: 'evc/charge',
    method: 'POST',
    verified: true,
    // Charging state is NOT in evc/gts (that reports the target state of
    // charge). It is `evStatus.batteryCharge` inside the same cmm/gvi read
    // every other command proves itself with.
    proofFields: ['evStatus.batteryCharge'],
    note: 'Requires the car to be plugged in — unplugged, Kia returns success and nothing happens.',
  },
  cancelCharge: {
    path: 'evc/cancel',
    method: 'GET',
    verified: true,
    proofFields: ['evStatus.batteryCharge'],
  },
  setChargeTargets: {
    path: 'evc/sts',
    method: 'POST',
    verified: true,
    // Proven by re-reading evc/gts rather than cmm/gvi — the targets live
    // there, so this one spec's proof is checked by the tool itself.
    proofFields: [],
    note: 'Replaces the whole target list — send an entry for BOTH plug types or the omitted one is dropped.',
  },
} as const satisfies Record<string, CommandSpec>;

/** Names of the commands in {@link COMMAND_SPECS}. */
export type KiaCommandName = keyof typeof COMMAND_SPECS;

/** Format a date as an RFC 1123 GMT string, e.g. `Mon, 27 Jul 2026 19:04:05 GMT`. */
export function rfc1123(date: Date): string {
  return date.toUTCString();
}

/**
 * The local GMT offset in hours (`-4`, `1`, …) as the app sends it. Zones with
 * a fractional offset are rounded to the nearest hour because the header is
 * whole-hours only.
 */
export function gmtOffsetHours(date: Date): string {
  return String(Math.round(-date.getTimezoneOffset() / 60));
}

/**
 * Build the full header set for a call. `date` is regenerated on **every**
 * invocation — a stale or missing `date` fails the request with errorCode
 * {@link KIA_ERROR_MISSING_HEADER_DATA} and an error message that does not name
 * the culprit, which is the single easiest way to break this client.
 *
 * `extra` carries the per-call headers (`sid`, `vinkey`, `otpkey`, `xid`,
 * `rmtoken`, `notifytype`); keys are lowercased and `undefined` values dropped
 * so callers can pass optional values inline.
 */
export function buildHeaders(
  deviceId: string,
  extra?: Record<string, string | undefined>,
  opts?: { now?: Date },
): Record<string, string> {
  // One clock read, so `date` and `offset` can never straddle a boundary.
  const now = opts?.now ?? new Date();
  const headers: Record<string, string> = {
    ...KIA_STATIC_HEADERS,
    deviceid: deviceId,
    clientuuid: deviceId,
    date: rfc1123(now),
    offset: gmtOffsetHours(now),
  };
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value !== undefined) headers[key.toLowerCase()] = value;
  }
  return headers;
}

/**
 * A non-zero `status.statusCode` from the Kia API. Shaped around the four
 * fields the API actually returns so callers can branch on `errorCode` without
 * string-matching messages.
 */
export class KiaApiError extends McpToolError {
  readonly statusCode: number;
  readonly errorType?: number;
  readonly errorCode?: number;
  readonly errorMessage?: string;
  /** Endpoint path the failure came from, for diagnostics. */
  readonly path: string;

  constructor(status: KiaStatus, path: string, opts?: { hint?: string; cause?: unknown }) {
    const detail = status.errorMessage ?? 'no error message';
    super(
      `Kia API error on ${path}: ${detail} (statusCode=${status.statusCode}` +
        `${status.errorCode === undefined ? '' : `, errorCode=${status.errorCode}`}` +
        `${status.errorType === undefined ? '' : `, errorType=${status.errorType}`})`,
      {
        hint:
          opts?.hint ??
          (status.errorCode === KIA_ERROR_MISSING_HEADER_DATA
            ? 'Kia rejects any request missing the mandatory RFC 1123 `date` header — check buildHeaders().'
            : undefined),
        cause: opts?.cause,
      },
    );
    this.name = 'KiaApiError';
    this.statusCode = status.statusCode;
    this.errorType = status.errorType;
    this.errorCode = status.errorCode;
    this.errorMessage = status.errorMessage;
    this.path = path;
  }
}

/** Narrow an unknown JSON body to a {@link KiaEnvelope}. */
function isEnvelope(body: unknown): body is KiaEnvelope {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { status?: unknown }).status === 'object' &&
    (body as { status: unknown }).status !== null &&
    typeof (body as { status: { statusCode?: unknown } }).status.statusCode === 'number'
  );
}

/**
 * Validate a parsed response body. Throws {@link KiaApiError} unless
 * `status.statusCode === 0`. **This, not the HTTP status, is the success
 * signal** — every failure below still arrives as HTTP 200.
 */
export function assertKiaSuccess<T = unknown>(body: unknown, path: string): KiaEnvelope<T> {
  if (!isEnvelope(body)) {
    throw new KiaApiError(
      { statusCode: -1, errorMessage: 'unrecognized response body (no status.statusCode)' },
      path,
      { hint: 'The upstream returned something that is not a Kia API envelope — an outage or a gateway page.' },
    );
  }
  if (body.status.statusCode !== 0) throw new KiaApiError(body.status, path);
  return body as KiaEnvelope<T>;
}

/** Init accepted by {@link FetchLike} — a deliberately small subset of `RequestInit`. */
export interface KiaRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Injectable fetch. Note the call site in {@link defaultFetch}: `fetch` must be
 * invoked as a method of `globalThis`, never stored detached — a detached
 * `globalThis.fetch` throws `Illegal invocation` in the Cloudflare Workers
 * runtime while passing every Node test.
 */
export type FetchLike = (url: string, init: KiaRequestInit) => Promise<Response>;

const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

/** A raw (not yet success-checked) Kia response: parsed body plus headers. */
export interface KiaRawResponse {
  /** Parsed JSON body — NOT validated; run it through {@link assertKiaSuccess}. */
  body: unknown;
  /** Response headers. `xid`, `sid` and `rmtoken` arrive here, not in the body. */
  headers: Headers;
  httpStatus: number;
}

/**
 * Perform one Kia API call and parse the JSON body. Success is deliberately NOT
 * asserted here: the auth bootstrap needs to inspect credential rejections and
 * the client needs the session-expiry heuristic before deciding what a
 * non-zero `statusCode` means.
 */
export async function sendKiaRequest(
  path: string,
  opts: {
    method: string;
    headers: Record<string, string>;
    body?: unknown;
    fetchImpl?: FetchLike;
  },
): Promise<KiaRawResponse> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const response = await fetchImpl(`${BASE_URL}${path}`, {
    method: opts.method,
    headers: opts.headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await response.text();
  try {
    return { body: JSON.parse(text) as unknown, headers: response.headers, httpStatus: response.status };
  } catch {
    throw new McpToolError(
      `Kia API returned a non-JSON response for ${path} (HTTP ${response.status}): ` +
        truncateErrorMessage(text || '<empty body>'),
      { hint: 'Usually an upstream outage or a gateway error page rather than a client bug.' },
    );
  }
}

/**
 * Whether a status is Kia rejecting the credentials. Callers MUST NOT retry:
 * each rejection increments `loginAttempt`, and enough of them set
 * `enforceRecaptcha`, which would break server-side login permanently.
 */
export function isCredentialRejection(status: KiaStatus): boolean {
  return status.statusCode !== 0 && status.errorCode !== undefined
    && CREDENTIAL_REJECTION_ERROR_CODES.includes(status.errorCode);
}

/**
 * Heuristic: does this failure mean the `sid` went stale and a silent refresh
 * should be attempted?
 *
 * **UNVERIFIED.** The live capture never observed an expired session, so no
 * error code for it is known. This matches on the message shape instead and is
 * deliberately conservative: a credential rejection is explicitly excluded so a
 * wrong password can never be laundered into a retry loop.
 */
export function isSessionExpiredStatus(status: KiaStatus): boolean {
  if (status.statusCode === 0) return false;
  if (isCredentialRejection(status)) return false;
  const message = status.errorMessage?.toLowerCase() ?? '';
  return /session|re-?login|expired/.test(message);
}

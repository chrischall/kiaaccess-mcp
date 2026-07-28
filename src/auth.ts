/**
 * Kia's three-step MFA bootstrap and the silent refresh that follows it.
 *
 * ```
 *   prof/authUser (creds)  ->  MFA_REQUIRED + payload.otpKey + `xid` RESPONSE header
 *   cmm/sendOTP   (otpkey, xid, notifytype=SMS|EMAIL)
 *   cmm/verifyOTP (otpkey, xid, {otp})  ->  `sid` + `rmtoken` RESPONSE headers
 *   prof/authUser (rmtoken header + creds)  ->  fresh `sid`, no MFA
 * ```
 *
 * The `rmtoken` is NOT rotated by the refresh, which is what makes MFA a
 * one-time bootstrap: persist it once and mint `sid`s from it indefinitely.
 *
 * Three things this module is deliberately strict about:
 *  - `xid` / `sid` / `rmtoken` live in RESPONSE HEADERS, never the body.
 *  - success is `status.statusCode === 0` in the body; HTTP is 200 even on
 *    failure, so nothing gates on the HTTP status.
 *  - a credential rejection (errorCode 1001 / 1037) is NEVER retried — see
 *    {@link KiaCredentialError}.
 */

import {
  ENDPOINTS,
  type FetchLike,
  KiaApiError,
  type KiaStatus,
  assertKiaSuccess,
  buildHeaders,
  isCredentialRejection,
  sendKiaRequest,
} from './protocol.js';

/** Kia Owners account credentials. */
export interface KiaCredentials {
  username: string;
  password: string;
}

/** Shared per-call options — the fetch seam tests inject. */
export interface AuthOptions {
  fetchImpl?: FetchLike;
}

/**
 * Kia rejected the credentials (errorCode 1001 or 1037).
 *
 * **This is never retried.** Every rejection increments `payload.loginAttempt`,
 * and once the count is exceeded Kia sets `payload.enforceRecaptcha`, at which
 * point server-side login is permanently impossible — no amount of correcting
 * the password afterwards helps this client. So a wrong password must surface
 * to the user immediately rather than being retried by any layer.
 */
export class KiaCredentialError extends KiaApiError {
  /** Always `false`. Present so callers can assert the no-retry contract. */
  readonly retryable = false;
  /** Kia's running count of failed attempts, when reported. */
  readonly loginAttempt?: number;
  /** Whether Kia has already escalated this account to reCAPTCHA. */
  readonly enforceRecaptcha?: boolean;

  constructor(status: KiaStatus, path: string, payload?: LoginAttemptPayload) {
    const escalated = payload?.enforceRecaptcha === true;
    super(status, path, {
      hint:
        'Do NOT retry with a guessed password. Fix KIA_USERNAME / KIA_PASSWORD ' +
        '(verify them in the Kia Access app first) before trying again.',
    });
    this.name = 'KiaCredentialError';
    this.loginAttempt = payload?.loginAttempt;
    this.enforceRecaptcha = payload?.enforceRecaptcha;
    this.message =
      `${this.message} — credentials rejected` +
      (payload?.loginAttempt === undefined ? '' : ` (failed attempt ${payload.loginAttempt})`) +
      '. This is NOT retried: repeated failures make Kia enforce reCAPTCHA, which breaks ' +
      'server-side login permanently' +
      (escalated ? ' — and Kia reports reCAPTCHA is already enforced on this account.' : '.');
  }
}

interface LoginAttemptPayload {
  loginAttempt?: number;
  enforceRecaptcha?: boolean;
}

/** Result of step 1, {@link startLogin}. */
export interface StartLoginResult {
  /** Opaque key threading the OTP send/verify calls together. */
  otpKey: string;
  /** Taken from the `xid` RESPONSE header — required by both following calls. */
  xid: string;
  /** `MFA_REQUIRED` in every observed live response. */
  nextAction?: string;
  /** Convenience: whether Kia is challenging for an OTP. */
  mfaRequired: boolean;
  hasEmail?: boolean;
  hasPhone?: boolean;
  /** Kia-masked destinations, safe to show the user when choosing a channel. */
  maskedEmail?: string;
  maskedPhone?: string;
}

/** Delivery channel for the one-time passcode. */
export type OtpNotifyType = 'SMS' | 'EMAIL';

/** Result of step 2, {@link sendOtp}. */
export interface SendOtpResult {
  message?: string;
  maskedPhone?: string;
  /** Epoch-ms expiry. The observed window was about two minutes. */
  expiresIn?: number;
}

/** Result of step 3, {@link verifyOtp} — both values are RESPONSE headers. */
export interface VerifyOtpResult {
  /** Short-lived session id sent as the `sid` header on authenticated calls. */
  sid: string;
  /** Long-lived remember-me token. Persist this; it is the MFA bypass. */
  rmtoken: string;
}

/** Result of {@link refreshSession}. */
export interface RefreshSessionResult {
  sid: string;
  /**
   * Echoed back for the caller to persist. Kia does NOT rotate it, so this is
   * normally the same token that was passed in; a rotated value is adopted if
   * one ever appears.
   */
  rmtoken: string;
}

interface AuthPayload extends LoginAttemptPayload {
  otpKey?: string;
  nextAction?: string;
  hasEmail?: boolean;
  hasPhone?: boolean;
  email?: string;
  phone?: string;
}

/**
 * Check an auth response and convert a credential rejection into the
 * non-retryable {@link KiaCredentialError} before the generic success check.
 */
function assertAuthSuccess(raw: { body: unknown }, path: string): { payload?: AuthPayload } {
  const status = (raw.body as { status?: KiaStatus } | null)?.status;
  if (status && isCredentialRejection(status)) {
    throw new KiaCredentialError(status, path, (raw.body as { payload?: LoginAttemptPayload }).payload);
  }
  return assertKiaSuccess<AuthPayload>(raw.body, path);
}

function requireHeader(headers: Headers, name: string, path: string): string {
  const value = headers.get(name);
  if (!value) {
    throw new KiaApiError(
      { statusCode: -1, errorMessage: `${path} succeeded but returned no \`${name}\` response header` },
      path,
      { hint: `Kia returns \`${name}\` as a RESPONSE HEADER, not in the body — check the header casing.` },
    );
  }
  return value;
}

/**
 * Step 1 — POST `prof/authUser` with the credentials. Returns the `otpKey` from
 * the payload and the `xid` from the response headers.
 *
 * Throws {@link KiaCredentialError} (never retried) if Kia rejects the
 * credentials.
 */
export async function startLogin(
  credentials: KiaCredentials,
  deviceId: string,
  opts: AuthOptions = {},
): Promise<StartLoginResult> {
  const path = ENDPOINTS.authUser;
  const raw = await sendKiaRequest(path, {
    method: 'POST',
    headers: buildHeaders(deviceId),
    body: {
      deviceKey: '',
      deviceType: 2,
      userCredential: { userId: credentials.username, password: credentials.password },
      tncFlag: 1,
    },
    fetchImpl: opts.fetchImpl,
  });

  const { payload } = assertAuthSuccess(raw, path);
  const xid = requireHeader(raw.headers, 'xid', path);
  if (!payload?.otpKey) {
    throw new KiaApiError({ statusCode: -1, errorMessage: 'no otpKey in the authUser payload' }, path, {
      hint: 'Kia changed the MFA bootstrap shape — re-verify prof/authUser against a live account.',
    });
  }

  return {
    otpKey: payload.otpKey,
    xid,
    nextAction: payload.nextAction,
    mfaRequired: payload.nextAction === 'MFA_REQUIRED',
    hasEmail: payload.hasEmail,
    hasPhone: payload.hasPhone,
    maskedEmail: payload.email,
    maskedPhone: payload.phone,
  };
}

/** Step 2 — POST `cmm/sendOTP`, delivering the passcode by SMS or email. */
export async function sendOtp(
  args: { otpKey: string; xid: string; notifyType: OtpNotifyType },
  deviceId: string,
  opts: AuthOptions = {},
): Promise<SendOtpResult> {
  const path = ENDPOINTS.sendOtp;
  const raw = await sendKiaRequest(path, {
    method: 'POST',
    headers: buildHeaders(deviceId, { otpkey: args.otpKey, xid: args.xid, notifytype: args.notifyType }),
    body: {},
    fetchImpl: opts.fetchImpl,
  });

  const envelope = assertKiaSuccess<{ phone?: string; message?: string; expiresIn?: number }>(raw.body, path);
  return {
    message: envelope.payload?.message,
    maskedPhone: envelope.payload?.phone,
    expiresIn: envelope.payload?.expiresIn,
  };
}

/**
 * Step 3 — POST `cmm/verifyOTP`. Both returned values arrive as RESPONSE
 * HEADERS; the body carries nothing useful.
 */
export async function verifyOtp(
  args: { otpKey: string; xid: string; otp: string },
  deviceId: string,
  opts: AuthOptions = {},
): Promise<VerifyOtpResult> {
  const path = ENDPOINTS.verifyOtp;
  const raw = await sendKiaRequest(path, {
    method: 'POST',
    headers: buildHeaders(deviceId, { otpkey: args.otpKey, xid: args.xid }),
    body: { otp: args.otp },
    fetchImpl: opts.fetchImpl,
  });

  assertKiaSuccess(raw.body, path);
  return {
    sid: requireHeader(raw.headers, 'sid', path),
    rmtoken: requireHeader(raw.headers, 'rmtoken', path),
  };
}

/**
 * Step 4 — mint a fresh `sid` from a persisted `rmtoken`. Same credential body
 * as step 1 minus `tncFlag`, with `deviceKey` set to the device uuid, plus the
 * `rmtoken` header. No MFA challenge, and `rmtoken` is not rotated.
 *
 * Like {@link startLogin} this never retries a credential rejection.
 */
export async function refreshSession(
  rmtoken: string,
  credentials: KiaCredentials,
  deviceId: string,
  opts: AuthOptions = {},
): Promise<RefreshSessionResult> {
  const path = ENDPOINTS.authUser;
  const raw = await sendKiaRequest(path, {
    method: 'POST',
    headers: buildHeaders(deviceId, { rmtoken }),
    body: {
      deviceKey: deviceId,
      deviceType: 2,
      userCredential: { userId: credentials.username, password: credentials.password },
    },
    fetchImpl: opts.fetchImpl,
  });

  assertAuthSuccess(raw, path);
  return {
    sid: requireHeader(raw.headers, 'sid', path),
    rmtoken: raw.headers.get('rmtoken') ?? rmtoken,
  };
}

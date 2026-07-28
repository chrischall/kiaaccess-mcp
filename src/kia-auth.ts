/**
 * `ConnectorAuth` for the hosted Cloudflare connector (claude.ai remote MCP).
 *
 * ## Why this service can be hosted at all
 *
 * Kia enforces MFA on password login, and an MFA challenge cannot be completed
 * inside a Worker: the passcode arrives by SMS/email minutes later, on a
 * different device, with no place to put it. What makes the hosted connector
 * possible is the `rmtoken` refresh (docs/KIA-API.md §4): `prof/authUser` with
 * an `rmtoken` header returns a fresh `sid` with **no MFA challenge**, and the
 * `rmtoken` is not rotated. So the MFA bootstrap runs ONCE on the user's local
 * stdio server, and the resulting token is pasted into this login page —
 * that is what the stdio server's `kia_export_refresh_token` tool exists for.
 *
 * ## Why all three fields are stored
 *
 * The refresh call sends the `rmtoken` **and** the full credential body
 * (`userId`/`password`) — the token alone does not mint a session. A silent
 * re-auth therefore needs the email and password too, so all three go into the
 * OAuth props. They are encrypted at rest in `OAUTH_KV` by
 * `@cloudflare/workers-oauth-provider`. `privacyNote` says exactly this rather
 * than implying the password is only used once: it is not.
 *
 * The type import is deliberately `import type` — nothing at runtime pulls in
 * `@chrischall/mcp-connector` (which imports `agents/mcp` and
 * `cloudflare:workers`), so this module still loads under plain Node and can be
 * unit-tested in the normal vitest pool alongside the rest of `src/`.
 */

import { truncateErrorMessage } from '@chrischall/mcp-utils';
import type { ConnectorAuth } from '@chrischall/mcp-connector';
import { KiaClient } from './client.js';
import { sendOtp, startLogin, verifyOtp } from './auth.js';
import { nullSessionIO } from './session.js';

/**
 * OAuth props stored per user by the connector's OAuth provider.
 *
 * The index signature satisfies `createConnector`'s
 * `Props extends Record<string, unknown>` constraint.
 */
export interface KiaProps {
  /** Kia Owners account email. Also the OAuth `userId`. */
  username: string;
  /** Kia account password — needed on EVERY session refresh, not just once. */
  password: string;
  /** The remember-me token exported from the user's local stdio server. */
  rmtoken: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Device id
// ---------------------------------------------------------------------------

/**
 * A Worker has no filesystem, so `resolveDeviceId()`'s generate-and-cache path
 * is unavailable — and a per-isolate random uuid would be worse than useless:
 * `deviceid`/`clientuuid` are supposed to be *stable per install*, and a value
 * that changed on every cold start would present the account as a new device on
 * every request. Instead the id is DERIVED from the account email, so it is
 * identical in every isolate, every deployment, and forever, with no storage
 * and no randomness (which Workers forbid at module scope anyway).
 *
 * **Uncertainty kept visible:** the live capture never tested whether Kia binds
 * an `rmtoken` to the `deviceid` it was minted against. If it does, this derived
 * id will not match the one the user's local stdio server generated and the
 * refresh will fail — which is precisely why {@link kiaAuth.login} performs a
 * real refresh at login time instead of trusting the paste. See the hint in
 * {@link describeLoginFailure}.
 */
export function hostedDeviceId(accountId: string): string {
  const seed = accountId.trim().toLowerCase();
  // Four independently-seeded FNV-1a passes → 128 bits of digest. FNV is not a
  // security primitive and does not need to be: this is a stable identifier,
  // not a secret, and `crypto.subtle` is async (unusable from a getter).
  const words = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b].map((offset) => fnv1a(seed, offset));
  const hex = words.map((word) => word.toString(16).padStart(8, '0')).join('');
  // Stamp the RFC 4122 version (4) and variant nibbles so the value is shaped
  // like the `identifierForVendor` uuid Kia's iOS client sends.
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  const v4 = `${hex.slice(0, 12)}4${hex.slice(13, 16)}${variant}${hex.slice(17, 32)}`;
  return `${v4.slice(0, 8)}-${v4.slice(8, 12)}-${v4.slice(12, 16)}-${v4.slice(16, 20)}-${v4.slice(20, 32)}`;
}

/** FNV-1a, 32-bit, with a caller-supplied offset basis. */
function fnv1a(text: string, offsetBasis: number): number {
  let hash = offsetBasis >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// Client construction
// ---------------------------------------------------------------------------

/**
 * Build the per-user {@link KiaClient} for a hosted session.
 *
 * Shared by {@link kiaAuth.login} (which verifies the credentials by using it)
 * and `worker.ts`'s `buildClient`, so the client that gets verified at login is
 * configured exactly like the one that serves tool calls.
 *
 * Two Worker-specific settings:
 *  - `sessionIO: nullSessionIO` — there is no filesystem; the `rmtoken` comes
 *    from the OAuth props and any refreshed value is simply held in memory.
 *  - `deviceId` — derived, see {@link hostedDeviceId}.
 *
 * Credentials are passed explicitly rather than read from `process.env`: the
 * Worker serves many users from one isolate, so an env fallback could hand one
 * user another's session.
 */
export function buildHostedKiaClient(props: KiaProps): KiaClient {
  return new KiaClient({
    username: props.username,
    password: props.password,
    rmtoken: props.rmtoken,
    deviceId: hostedDeviceId(props.username),
    sessionIO: nullSessionIO,
  });
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/**
 * Turn a verification failure into something a human staring at the login page
 * can act on. The underlying message is redacted + length-capped
 * (`truncateErrorMessage`) before it is shown, because Kia error bodies are
 * echoed verbatim and the request that produced them carried a password.
 */
function describeLoginFailure(err: unknown, ...secrets: string[]): Error {
  let raw = err instanceof Error ? err.message : String(err);
  // `truncateErrorMessage` redacts known secret SHAPES (Bearer, JWT, sk-…). A
  // password is not a recognisable shape, and Kia's error bodies can echo the
  // request that carried it — so scrub the literal values we know we just sent
  // before any of this reaches the login page. Belt and braces: the generic
  // redactor still runs afterwards for anything token-shaped.
  for (const secret of secrets) {
    // Guard, not decoration: `split('')` on an empty needle splits EVERY
    // character, which would splice the placeholder through the whole message.
    // Unreachable from the current call sites (all four pass values already
    // validated non-empty), but load-bearing the moment one passes an optional.
    /* v8 ignore next */
    if (secret) raw = raw.split(secret).join('[redacted]');
  }
  return new Error(
    `Could not sign in to Kia: ${truncateErrorMessage(raw)} — check the email and password. If you were entering ` +
      'a texted code, it must be the most recent one; codes expire after about two minutes, so clear the code box ' +
      'and submit again to have a fresh one sent.',
  );
}

/**
 * The hosted connector's login: the MFA bootstrap runs HERE, so the user never
 * handles a remember-me token.
 *
 * Kia challenges every password login with an OTP, and a one-shot form cannot
 * both request a code and collect it. So this is a TWO-SUBMISSION flow, with
 * the short-lived handles parked in `OAUTH_KV` between them:
 *
 *   submit 1 (code box empty) — `prof/authUser` + `cmm/sendOTP`, stash
 *     {otpKey, xid} under a 10-minute key, then THROW a message telling the
 *     user a code was sent. The harness renders a thrown error on the login
 *     page, which is what turns "failure" into "step 2 of 2".
 *   submit 2 (code filled in) — read the stash, `cmm/verifyOTP`, and keep the
 *     `rmtoken` Kia returns. That token is the MFA bypass, so every later
 *     session renewal is silent.
 *
 * The stash holds no credential: `otpKey`/`xid` are per-attempt handles, useless
 * without the password, and they expire with the code. The password is never
 * written to KV by this flow — only the harness's own encrypted props hold it.
 *
 * Either way the returned props are verified for real before they are stored:
 * the same client the connector will use performs a refresh + `ownr/gvl` read.
 *
 * Note the one thing this must NOT do: retry. A rejected credential increments
 * Kia's `loginAttempt` and eventually sets `enforceRecaptcha`, which would break
 * server-side auth for the account permanently. `KiaClient` never retries a
 * credential rejection, and neither does this.
 */
/** The slice of a Workers KV binding this flow uses. Typed locally so the file stays node-loadable. */
interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Prove the props actually work before the harness stores them: build the very
 * client the connector will use and force a refresh + a cheap `ownr/gvl` read.
 * Anything wrong surfaces on the login page instead of inside a later tool call.
 */
async function verifiedProps(props: KiaProps): Promise<KiaProps> {
  try {
    await buildHostedKiaClient(props).listVehicles();
  } catch (err) {
    throw describeLoginFailure(err, props.password, props.rmtoken);
  }
  return props;
}

export const kiaAuth: ConnectorAuth<KiaProps> = {
  service: 'Kia Access',
  accent: '#05141F',
  privacyNote:
    'Your Kia email and password are stored encrypted and used only to control your own vehicle. Signing in here ' +
    'completes Kia\'s one-time SMS verification and keeps the remember-me token it returns, so you are not asked ' +
    'for a code again. The password is kept because Kia requires it on every session renewal — the token alone ' +
    'cannot sign in.',
  fields: [
    { name: 'username', label: 'Kia Owners email' },
    { name: 'password', label: 'Kia Owners password', type: 'password' },
    {
      name: 'otp',
      label: 'Texted code — leave blank on your first sign-in, then submit again with the code',
    },
  ],
  async login(fields, env) {
    const username = (fields.username ?? '').trim();
    const password = fields.password ?? '';
    const otp = (fields.otp ?? '').trim();

    if (!username || !password) {
      throw new Error('Your Kia Owners email and password are both required.');
    }

    const deviceId = hostedDeviceId(username);
    const kv = (env as { OAUTH_KV?: KVLike } | undefined)?.OAUTH_KV;
    if (!kv) {
      throw new Error(
        'This connector is misconfigured: no OAUTH_KV binding, so the verification code cannot be carried ' +
          'between the two sign-in steps. Contact whoever deployed it.',
      );
    }
    const stashKey = `mfa:${username.toLowerCase()}`;

    // ---- Step 1: no code yet — authenticate and dispatch one. ----
    if (!otp) {
      // Wrapped individually, not as a block: the two deliberate throws below
      // are control flow ("code sent", "no challenge"), not failures, and must
      // reach the page verbatim. Only the API calls get sanitized — a rejected
      // password is the commonest failure here, and Kia's error body can echo
      // the request that carried it.
      let started;
      try {
        started = await startLogin({ username, password }, deviceId);
      } catch (err) {
        throw describeLoginFailure(err, password);
      }

      if (!started.mfaRequired) {
        // Never observed live — Kia challenged every password login during
        // development. Handled honestly rather than guessed at: a remember-me
        // token is only ever returned by cmm/verifyOTP, so with no challenge
        // there is nothing durable to store and no way to renew a session
        // later. Fail with something actionable instead of storing a session
        // that would silently die at the first refresh.
        throw new Error(
          'Kia accepted the password without asking for a verification code, which this connector cannot use: ' +
            'the remember-me token it needs is only issued as part of the code flow. Sign out of the Kia app and ' +
            'back in to re-arm verification, then try again.',
        );
      }

      let sent;
      try {
        sent = await sendOtp({ otpKey: started.otpKey, xid: started.xid, notifyType: 'SMS' }, deviceId);
      } catch (err) {
        throw describeLoginFailure(err, password);
      }
      await kv.put(stashKey, JSON.stringify({ otpKey: started.otpKey, xid: started.xid }), {
        expirationTtl: 600,
      });

      // Thrown, not returned: the harness renders this on the login page, which
      // is what makes "failure" read as step 2 of 2.
      throw new Error(
        `Kia texted a verification code to ${sent.maskedPhone ?? started.maskedPhone ?? 'your phone'}. ` +
          'Enter it in the code box and submit again — same email and password. The code expires in about two minutes.',
      );
    }

    // ---- Step 2: code supplied — verify it and keep the token. ----
    const stashed = await kv.get(stashKey);
    if (!stashed) {
      throw new Error(
        'That code has expired, or no code was requested for this account. Clear the code box and submit again ' +
          'to have a fresh one sent.',
      );
    }
    const { otpKey, xid } = JSON.parse(stashed) as { otpKey: string; xid: string };

    let rmtoken: string;
    try {
      ({ rmtoken } = await verifyOtp({ otpKey, xid, otp }, deviceId));
    } catch (err) {
      throw describeLoginFailure(err, password, otp);
    }
    // One-shot: a consumed code must not be replayable.
    await kv.delete(stashKey);

    return await verifiedProps({ username, password, rmtoken });
  },
};

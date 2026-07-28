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
function describeLoginFailure(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  return new Error(
    `Could not connect to Kia: ${truncateErrorMessage(raw)} — check the email, password, and remember-me ` +
      'token. The token must be the CURRENT value from the local kiaaccess-mcp server ' +
      '(kia_export_refresh_token), and it may be tied to the device it was created on, in which case it cannot ' +
      'be reused here.',
  );
}

/**
 * The hosted connector's login: three fields, verified for real.
 *
 * `login()` does not merely shape-check the paste — it constructs the same
 * client the connector will use and calls `listVehicles()`, which forces
 * (1) a full `prof/authUser` refresh from the pasted `rmtoken` and
 * (2) a cheap `ownr/gvl` read under the resulting `sid`. Anything wrong — bad
 * password, stale/foreign token, unenrolled account — throws here and is
 * rendered back on the login page, rather than surfacing later as an
 * inscrutable failure inside a tool call.
 *
 * Note the one thing this must NOT do: retry. A rejected credential increments
 * Kia's `loginAttempt` and eventually sets `enforceRecaptcha`, which would break
 * server-side auth for the account permanently. `KiaClient` never retries a
 * credential rejection, and neither does this.
 */
export const kiaAuth: ConnectorAuth<KiaProps> = {
  service: 'Kia Access',
  accent: '#05141F',
  privacyNote:
    'Your Kia email, password, and remember-me token are all stored encrypted and used only to control your own ' +
    'vehicle. The password and token are both kept because Kia requires both on every session renewal — the token ' +
    'alone cannot sign in.',
  fields: [
    { name: 'username', label: 'Kia Owners email' },
    { name: 'password', label: 'Kia Owners password', type: 'password' },
    {
      name: 'rmtoken',
      label: 'Kia remember-me token (from kia_export_refresh_token)',
      type: 'password',
    },
  ],
  async login(fields) {
    const username = (fields.username ?? '').trim();
    const password = fields.password ?? '';
    const rmtoken = (fields.rmtoken ?? '').trim();

    if (!username || !password || !rmtoken) {
      throw new Error(
        'Email, password, and remember-me token are all required. Get the token by running ' +
          'kia_export_refresh_token on your local kiaaccess-mcp server after completing the one-time MFA login ' +
          'there — MFA cannot be completed here.',
      );
    }

    const props: KiaProps = { username, password, rmtoken };
    try {
      // Verify for real: this refreshes the session from the token (prof/authUser
      // with the `rmtoken` header) and then reads the vehicle list. We discard
      // the result — the per-session client is rebuilt from the stored props.
      await buildHostedKiaClient(props).listVehicles();
    } catch (err) {
      throw describeLoginFailure(err);
    }

    return props;
  },
};

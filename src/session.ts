/**
 * Session persistence and `sid` lifecycle.
 *
 * Two concerns, both thin adapters over `@chrischall/mcp-utils/session`:
 *
 *  1. **Persistence** — the `rmtoken` (plus the device uuid it is bound to and
 *     the account it belongs to) survives restarts in a 0600 file inside a 0700
 *     directory, so the MFA bootstrap is a one-time cost. `sid`s are NOT
 *     persisted: they are short-lived and cheap to re-mint from the `rmtoken`.
 *  2. **Minting** — {@link SidManager} wraps `TokenManager` so a burst of
 *     concurrent tool calls coalesces onto ONE `prof/authUser` refresh, and a
 *     call that reports an expired session triggers exactly one re-mint and
 *     replay.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readEnvVar } from '@chrischall/mcp-utils';
import { SessionStore, TokenManager } from '@chrischall/mcp-utils/session';
import { DEVICE_DIR_NAME } from './device.js';

/** What we persist between runs. Never includes the password or a `sid`. */
export interface KiaStoredSession extends Record<string, unknown> {
  /** Kia account (the login email), lowercased when used as the store key. */
  accountId: string;
  /** The long-lived remember-me token — this is the MFA bypass. */
  rmtoken: string;
  /** Device uuid the token was minted against; a different one needs new MFA. */
  deviceId: string;
  /** ISO timestamp of the last write, for diagnostics. */
  updatedAt: string;
}

/** Where the session store lives. `KIA_SESSION_FILE` overrides it (tests do). */
export function sessionFilePath(): string {
  return readEnvVar('KIA_SESSION_FILE') ?? join(homedir(), DEVICE_DIR_NAME, 'session.json');
}

const normalizeAccountId = (key: string): string => key.trim().toLowerCase();

/**
 * Open the store. Constructed per call (it reads disk in its constructor) so
 * `KIA_SESSION_FILE` is honoured dynamically and a session written by another
 * process is picked up.
 */
export function openSessionStore(): SessionStore<KiaStoredSession> {
  return new SessionStore<KiaStoredSession>({
    filePath: sessionFilePath(),
    keyOf: (session) => session.accountId,
    // Accounts are emails, not origins — the default origin normalizer would
    // mangle them.
    normalizeKey: normalizeAccountId,
  });
}

/**
 * Storage seam for the persisted session. The stdio server uses
 * {@link diskSessionIO}; a hosted per-user runtime (no filesystem) passes
 * {@link nullSessionIO} and supplies the `rmtoken` directly.
 */
export interface KiaSessionIO {
  load(accountId: string): KiaStoredSession | null;
  save(session: KiaStoredSession): void;
  clear(accountId: string): void;
}

function warn(action: string, err: unknown): void {
  // stderr only — stdout is the JSON-RPC channel.
  console.error(
    `[kiaaccess-mcp] could not ${action} the saved Kia session (${(err as Error).message}); ` +
      'continuing without persistence — the MFA bootstrap may be needed again after a restart.',
  );
}

/**
 * Build a {@link KiaSessionIO} over a store factory. Every operation is
 * best-effort: persistence failing (read-only home, no filesystem at all) must
 * degrade to "no saved session", never crash a tool call. The factory is a
 * parameter so that failure path is testable without sabotaging a real disk.
 */
export function createSessionIO(openStore: () => SessionStore<KiaStoredSession>): KiaSessionIO {
  return {
    load(accountId) {
      try {
        const record = openStore().get(accountId);
        return record && typeof record.rmtoken === 'string' && record.rmtoken ? record : null;
      } catch (err) {
        warn('read', err);
        return null;
      }
    },
    save(session) {
      try {
        openStore().add({ ...session, accountId: normalizeAccountId(session.accountId) });
      } catch (err) {
        warn('save', err);
      }
    },
    clear(accountId) {
      try {
        openStore().remove(accountId);
      } catch (err) {
        warn('clear', err);
      }
    },
  };
}

/** Disk-backed session persistence (0600 file, 0700 dir). Never throws. */
export const diskSessionIO: KiaSessionIO = createSessionIO(openSessionStore);

/** No-op persistence for runtimes without a filesystem. */
export const nullSessionIO: KiaSessionIO = {
  load: () => null,
  save: () => {},
  clear: () => {},
};

/**
 * Assumed `sid` lifetime. **Unverified** — Kia does not publish one and the
 * live capture never saw a session expire. One hour is deliberately
 * conservative; a wrong guess costs at most one extra refresh, and the reactive
 * re-mint in {@link SidManager.withSid} covers an early expiry.
 */
export const SID_TTL_MS = 60 * 60 * 1000;

/** Re-mint this long before the assumed expiry so a call can't race it. */
export const SID_REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * Sentinel handed to `TokenManager` as its "refresh token". Kia has no
 * OAuth-style refresh token — every renewal re-runs `prof/authUser` with the
 * `rmtoken`. The manager only refuses to refresh when its refresh token is
 * `undefined`, so a non-empty placeholder keeps the single-flight path live;
 * the refresh callback ignores its argument.
 */
const SID_REFRESH_SENTINEL = 'kia';

export interface SidManagerOptions {
  /** Mint a fresh `sid` (i.e. `refreshSession(rmtoken, creds, deviceId)`). */
  mint: () => Promise<string>;
  /** Override the assumed sid lifetime (defaults to {@link SID_TTL_MS}). */
  ttlMs?: number;
  /** Override the proactive re-mint window (defaults to {@link SID_REFRESH_SKEW_MS}). */
  skewMs?: number;
}

/**
 * Single-flight `sid` minting.
 *
 * Kia's API answers HTTP 200 for everything, so `TokenManager.withAuth`'s
 * 401-based replay is useless here; {@link withSid} reimplements the same
 * discipline over a caller-supplied expiry predicate on the parsed body,
 * including the double-refresh guard (a late expiry from a request sent under
 * an already-rotated sid replays with the current one instead of minting again).
 */
export class SidManager {
  private readonly tokens: TokenManager;
  private readonly ttlMs: number;
  private mints = 0;

  constructor(opts: SidManagerOptions) {
    this.ttlMs = opts.ttlMs ?? SID_TTL_MS;
    this.tokens = new TokenManager({
      // Seeded already-expired so the first call mints, i.e. we log in lazily
      // on first use rather than at construction.
      initial: { accessToken: '', refreshToken: SID_REFRESH_SENTINEL, expiresAt: 0 },
      skewMs: opts.skewMs ?? SID_REFRESH_SKEW_MS,
      refresh: async () => {
        const accessToken = await opts.mint();
        this.mints += 1;
        return { accessToken, refreshToken: SID_REFRESH_SENTINEL, expiresAt: Date.now() + this.ttlMs };
      },
    });
  }

  /**
   * How many `sid`s this manager has minted — a monotonic id for the CURRENT
   * Kia session.
   *
   * Exposed because minting a `sid` also rotates every `vehicleKey` on the
   * account, so anything derived from the old session (see `KiaClient`'s vinkey
   * remap) has to be discarded when this changes. The `sid` itself is
   * deliberately not readable; a counter leaks nothing.
   */
  get generation(): number {
    return this.mints;
  }

  /**
   * A valid `sid`, minting one if none is cached or it is near expiry.
   *
   * The value is deliberately not mirrored anywhere on this class: a `sid` is a
   * credential, so nothing outside an authenticated request should be able to
   * read one back out (no diagnostics, no dry-run preview).
   */
  getSid(): Promise<string> {
    return this.tokens.getAccessToken();
  }

  /** Force a re-mint now. Concurrent callers share the one in-flight mint. */
  refreshNow(): Promise<void> {
    return this.tokens.refreshNow();
  }

  /**
   * Run an authenticated call with reactive re-auth. `call` receives a valid
   * `sid`; if `isExpired` says the parsed body reports a dead session, the sid
   * is re-minted (unless a concurrent caller already rotated it) and `call` runs
   * exactly once more. Never loops.
   */
  async withSid<T>(call: (sid: string) => Promise<T>, isExpired: (result: T) => boolean): Promise<T> {
    const usedSid = await this.getSid();
    const result = await call(usedSid);
    if (!isExpired(result)) return result;

    // Double-refresh guard: if another caller already rotated the sid while
    // this request was in flight, replay with theirs instead of minting again.
    if (await this.isStillCurrent(usedSid)) await this.refreshNow();
    return call(await this.getSid());
  }

  private async isStillCurrent(sid: string): Promise<boolean> {
    return (await this.tokens.getAccessToken()) === sid;
  }
}

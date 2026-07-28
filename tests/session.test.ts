import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SID_TTL_MS,
  SidManager,
  createSessionIO,
  diskSessionIO,
  type KiaStoredSession,
  nullSessionIO,
  sessionFilePath,
} from '../src/session.js';

const ACCOUNT = 'driver@example.test';

function record(overrides: Partial<KiaStoredSession> = {}): KiaStoredSession {
  return {
    accountId: ACCOUNT,
    rmtoken: 'fake-rmtoken',
    deviceId: 'FAKE-DEVICE-0000-1111',
    updatedAt: '2026-07-27T19:00:00.000Z',
    ...overrides,
  };
}

describe('sessionFilePath', () => {
  afterEach(() => {
    delete process.env.KIA_SESSION_FILE;
  });

  it('defaults to ~/.kiaaccess-mcp/session.json', () => {
    delete process.env.KIA_SESSION_FILE;
    expect(sessionFilePath()).toMatch(/\.kiaaccess-mcp\/session\.json$/);
  });

  it('honours KIA_SESSION_FILE', () => {
    process.env.KIA_SESSION_FILE = '/tmp/elsewhere/session.json';
    expect(sessionFilePath()).toBe('/tmp/elsewhere/session.json');
  });
});

describe('diskSessionIO', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kiaaccess-session-'));
    process.env.KIA_SESSION_FILE = join(dir, 'session.json');
  });

  afterEach(() => {
    delete process.env.KIA_SESSION_FILE;
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns null when nothing has been persisted', () => {
    expect(diskSessionIO.load(ACCOUNT)).toBeNull();
  });

  it('round-trips a session, keyed case-insensitively by account', () => {
    diskSessionIO.save(record());
    expect(diskSessionIO.load('DRIVER@Example.test')).toMatchObject({
      accountId: ACCOUNT,
      rmtoken: 'fake-rmtoken',
      deviceId: 'FAKE-DEVICE-0000-1111',
    });
  });

  it('persists with 0600 file perms', () => {
    diskSessionIO.save(record());
    const mode = statSync(process.env.KIA_SESSION_FILE!).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('replaces an existing record for the same account', () => {
    diskSessionIO.save(record());
    diskSessionIO.save(record({ rmtoken: 'fake-rmtoken-2' }));
    expect(diskSessionIO.load(ACCOUNT)?.rmtoken).toBe('fake-rmtoken-2');
  });

  it('clears a persisted session', () => {
    diskSessionIO.save(record());
    diskSessionIO.clear(ACCOUNT);
    expect(diskSessionIO.load(ACCOUNT)).toBeNull();
  });

  it('ignores a persisted record with no rmtoken', () => {
    diskSessionIO.save(record({ rmtoken: '' }));
    expect(diskSessionIO.load(ACCOUNT)).toBeNull();
  });

  it('degrades to "no session" when the store file is corrupt', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFileSync(process.env.KIA_SESSION_FILE!, 'not json at all', { mode: 0o600 });
    expect(diskSessionIO.load(ACCOUNT)).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('never throws when persistence fails (a hosted runtime has no filesystem)', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Persist once so `session.json` exists as a FILE, then point the store at a
    // path underneath it — every mkdir/write below it fails with ENOTDIR.
    diskSessionIO.save(record());
    process.env.KIA_SESSION_FILE = join(dir, 'session.json', 'nested.json');
    expect(() => diskSessionIO.save(record())).not.toThrow();
    expect(() => diskSessionIO.clear(ACCOUNT)).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});

describe('createSessionIO', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('degrades every operation to a warning when the store cannot be opened', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const io = createSessionIO(() => {
      throw new Error('no filesystem here');
    });

    expect(io.load(ACCOUNT)).toBeNull();
    expect(() => io.save(record())).not.toThrow();
    expect(() => io.clear(ACCOUNT)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringMatching(/could not read/),
      expect.stringMatching(/could not save/),
      expect.stringMatching(/could not clear/),
    ]);
  });
});

describe('nullSessionIO', () => {
  it('is a no-op store for runtimes without a filesystem', () => {
    expect(nullSessionIO.load(ACCOUNT)).toBeNull();
    expect(() => nullSessionIO.save(record())).not.toThrow();
    expect(() => nullSessionIO.clear(ACCOUNT)).not.toThrow();
  });
});

describe('SidManager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('mints a sid lazily on first use and reuses it', async () => {
    const mint = vi.fn().mockResolvedValue('fake-sid-1');
    const manager = new SidManager({ mint });

    expect(mint).not.toHaveBeenCalled();
    expect(await manager.getSid()).toBe('fake-sid-1');
    expect(await manager.getSid()).toBe('fake-sid-1');
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent callers onto ONE refresh (single-flight)', async () => {
    let resolveMint: ((sid: string) => void) | undefined;
    const mint = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveMint = resolve;
        }),
    );
    const manager = new SidManager({ mint });

    const all = Promise.all([manager.getSid(), manager.getSid(), manager.getSid(), manager.getSid()]);
    await Promise.resolve();
    resolveMint!('fake-sid-1');

    expect(await all).toEqual(['fake-sid-1', 'fake-sid-1', 'fake-sid-1', 'fake-sid-1']);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('re-mints proactively once the sid ages past its ttl', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-27T19:00:00Z'));
    const mint = vi.fn().mockResolvedValueOnce('fake-sid-1').mockResolvedValueOnce('fake-sid-2');
    const manager = new SidManager({ mint, ttlMs: 60_000, skewMs: 1_000 });

    expect(await manager.getSid()).toBe('fake-sid-1');
    vi.setSystemTime(new Date('2026-07-27T19:00:59.5Z'));
    expect(await manager.getSid()).toBe('fake-sid-2');
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('has a conservative default ttl (Kia does not publish one)', () => {
    expect(SID_TTL_MS).toBeGreaterThan(0);
  });

  it('re-mints and replays exactly once when a call reports an expired session', async () => {
    const mint = vi.fn().mockResolvedValueOnce('fake-sid-1').mockResolvedValueOnce('fake-sid-2');
    const manager = new SidManager({ mint });
    const seen: string[] = [];

    const result = await manager.withSid(
      async (sid) => {
        seen.push(sid);
        return sid === 'fake-sid-1' ? { expired: true } : { expired: false, ok: true };
      },
      (r) => r.expired,
    );

    expect(seen).toEqual(['fake-sid-1', 'fake-sid-2']);
    expect(result).toEqual({ expired: false, ok: true });
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('returns the second result even if it still looks expired (no infinite loop)', async () => {
    const mint = vi.fn().mockResolvedValueOnce('fake-sid-1').mockResolvedValueOnce('fake-sid-2');
    const manager = new SidManager({ mint });

    const result = await manager.withSid(
      async (sid) => ({ sid }),
      () => true,
    );

    expect(result).toEqual({ sid: 'fake-sid-2' });
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('does not double-mint when a concurrent caller already rotated the sid', async () => {
    const mint = vi
      .fn()
      .mockResolvedValueOnce('fake-sid-1')
      .mockResolvedValueOnce('fake-sid-2')
      .mockResolvedValueOnce('fake-sid-3');
    const manager = new SidManager({ mint });
    const seen: string[] = [];

    const result = await manager.withSid(
      async (sid) => {
        seen.push(sid);
        if (sid === 'fake-sid-1') {
          // Simulate another in-flight caller rotating the sid before we
          // notice our own response was an expiry.
          await manager.refreshNow();
          return { expired: true };
        }
        return { expired: false };
      },
      (r) => r.expired,
    );

    expect(seen).toEqual(['fake-sid-1', 'fake-sid-2']);
    expect(result).toEqual({ expired: false });
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('propagates a mint failure to every coalesced caller and can retry afterwards', async () => {
    const mint = vi.fn().mockRejectedValueOnce(new Error('bootstrap required')).mockResolvedValueOnce('fake-sid-1');
    const manager = new SidManager({ mint });

    await expect(manager.getSid()).rejects.toThrow('bootstrap required');
    expect(await manager.getSid()).toBe('fake-sid-1');
    expect(mint).toHaveBeenCalledTimes(2);
  });
});

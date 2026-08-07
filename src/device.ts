/**
 * Stable device UUID for the Kia app handshake.
 *
 * Kia's login is device-scoped: the `deviceid` / `clientuuid` headers identify
 * this "install", and the `rmtoken` minted during the MFA bootstrap is tied to
 * it. A device id that changes between runs would force a fresh MFA challenge
 * every time, so it is generated once and persisted under `~/.kiaaccess-mcp/`
 * with the same hardened perms the session store uses (0600 file, 0700 dir).
 *
 * Everything is injectable ({@link ResolveDeviceIdOptions}) so tests never touch
 * the real filesystem, and nothing here runs at module load — a sandboxed
 * runtime may have no filesystem and may forbid random-value generation in
 * global scope.
 */

import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readEnvVar } from '@chrischall/mcp-utils';

/** Directory under the user's home that holds the device id (and session). */
export const DEVICE_DIR_NAME = '.kiaaccess-mcp';
/** File within {@link DEVICE_DIR_NAME} holding the raw uuid. */
export const DEVICE_FILE_NAME = 'device-id';
/** Owner-only directory perms. */
export const DEVICE_DIR_MODE = 0o700;
/** Owner-only file perms. */
export const DEVICE_FILE_MODE = 0o600;

/** The slice of `node:fs` this module needs, so tests can substitute it. */
export interface DeviceIdFs {
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string, options: { mode: number }): void;
  mkdirSync(path: string, options: { recursive: boolean; mode: number }): void;
  chmodSync(path: string, mode: number): void;
}

/**
 * Real-filesystem implementation. Method references (not wrappers) so there is
 * no untestable indirection layer.
 */
export const defaultDeviceIdFs: DeviceIdFs = {
  readFileSync: nodeFs.readFileSync,
  writeFileSync: nodeFs.writeFileSync,
  mkdirSync: nodeFs.mkdirSync,
  chmodSync: nodeFs.chmodSync,
};

export interface ResolveDeviceIdOptions {
  /** Filesystem seam (defaults to `node:fs`). */
  fs?: DeviceIdFs;
  /** Home directory (defaults to `os.homedir()`). */
  homeDir?: string;
  /** UUID generator (defaults to `crypto.randomUUID()`, uppercased like the app). */
  generate?: () => string;
}

/** Absolute path of the persisted device id file. */
export function deviceIdFilePath(homeDir: string): string {
  return join(homeDir, DEVICE_DIR_NAME, DEVICE_FILE_NAME);
}

/**
 * Resolve the device uuid: `KIA_DEVICE_ID` if set, else the persisted one, else
 * a freshly generated uuid persisted for next time.
 *
 * If persistence fails (read-only home, sandbox), the generated id is still
 * returned so the process works — it just won't survive a restart, which costs
 * one extra MFA bootstrap. That is surfaced on stderr, never stdout (stdout is
 * the JSON-RPC channel).
 */
export function resolveDeviceId(opts: ResolveDeviceIdOptions = {}): string {
  const fromEnv = readEnvVar('KIA_DEVICE_ID');
  if (fromEnv) return fromEnv;

  const fs = opts.fs ?? defaultDeviceIdFs;
  const home = opts.homeDir ?? homedir();
  const dir = join(home, DEVICE_DIR_NAME);
  const file = deviceIdFilePath(home);

  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // No persisted id yet (or it is unreadable) — fall through and mint one.
  }

  const generated = opts.generate ? opts.generate() : randomUUID().toUpperCase();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: DEVICE_DIR_MODE });
    // mkdir/open modes are masked by the process umask, so re-assert them.
    fs.chmodSync(dir, DEVICE_DIR_MODE);
    fs.writeFileSync(file, `${generated}\n`, { mode: DEVICE_FILE_MODE });
    fs.chmodSync(file, DEVICE_FILE_MODE);
  } catch (err) {
    console.error(
      `[kiaaccess-mcp] could not persist the device id to ${file} (${(err as Error).message}); ` +
        'using an in-memory id for this run — set KIA_DEVICE_ID to make it stable.',
    );
  }
  return generated;
}

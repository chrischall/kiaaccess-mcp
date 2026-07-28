import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEVICE_DIR_MODE,
  DEVICE_FILE_MODE,
  type DeviceIdFs,
  deviceIdFilePath,
  resolveDeviceId,
} from '../src/device.js';

const HOME = '/fake/home';
const GENERATED = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';

interface Recorded {
  mkdir: Array<{ path: string; mode: number }>;
  write: Array<{ path: string; data: string; mode: number }>;
  chmod: Array<{ path: string; mode: number }>;
}

/** In-memory DeviceIdFs — the tests never touch the real filesystem. */
function fakeFs(files: Record<string, string> = {}, opts: { failWrite?: boolean } = {}) {
  const recorded: Recorded = { mkdir: [], write: [], chmod: [] };
  const fs: DeviceIdFs = {
    readFileSync(path) {
      const content = files[path];
      if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return content;
    },
    writeFileSync(path, data, options) {
      if (opts.failWrite) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      recorded.write.push({ path, data, mode: options.mode });
      files[path] = data;
    },
    mkdirSync(path, options) {
      recorded.mkdir.push({ path, mode: options.mode });
    },
    chmodSync(path, mode) {
      recorded.chmod.push({ path, mode });
    },
  };
  return { fs, files, recorded };
}

describe('deviceIdFilePath', () => {
  it('lives under ~/.kiaaccess-mcp', () => {
    expect(deviceIdFilePath(HOME)).toBe('/fake/home/.kiaaccess-mcp/device-id');
  });
});

describe('resolveDeviceId', () => {
  beforeEach(() => {
    delete process.env.KIA_DEVICE_ID;
  });

  afterEach(() => {
    delete process.env.KIA_DEVICE_ID;
    vi.restoreAllMocks();
  });

  it('prefers KIA_DEVICE_ID from the environment and never touches disk', () => {
    process.env.KIA_DEVICE_ID = '  ENV-DEVICE-ID  ';
    const { fs, recorded } = fakeFs();
    expect(resolveDeviceId({ fs, homeDir: HOME, generate: () => GENERATED })).toBe('ENV-DEVICE-ID');
    expect(recorded.write).toHaveLength(0);
    expect(recorded.mkdir).toHaveLength(0);
  });

  it('reads a previously persisted id', () => {
    const { fs, recorded } = fakeFs({ '/fake/home/.kiaaccess-mcp/device-id': 'PERSISTED-ID\n' });
    expect(resolveDeviceId({ fs, homeDir: HOME, generate: () => GENERATED })).toBe('PERSISTED-ID');
    expect(recorded.write).toHaveLength(0);
  });

  it('generates and persists an id with 0600 file / 0700 dir perms when none exists', () => {
    const { fs, recorded } = fakeFs();
    expect(resolveDeviceId({ fs, homeDir: HOME, generate: () => GENERATED })).toBe(GENERATED);
    expect(recorded.mkdir).toEqual([{ path: '/fake/home/.kiaaccess-mcp', mode: DEVICE_DIR_MODE }]);
    expect(recorded.write).toEqual([
      { path: '/fake/home/.kiaaccess-mcp/device-id', data: `${GENERATED}\n`, mode: DEVICE_FILE_MODE },
    ]);
    // Perms are re-asserted after the fact because umask masks mkdir/open modes.
    expect(recorded.chmod).toEqual([
      { path: '/fake/home/.kiaaccess-mcp', mode: DEVICE_DIR_MODE },
      { path: '/fake/home/.kiaaccess-mcp/device-id', mode: DEVICE_FILE_MODE },
    ]);
  });

  it('is stable across calls once persisted', () => {
    const { fs } = fakeFs();
    const first = resolveDeviceId({ fs, homeDir: HOME, generate: () => GENERATED });
    const second = resolveDeviceId({ fs, homeDir: HOME, generate: () => 'DIFFERENT-ID' });
    expect(second).toBe(first);
  });

  it('regenerates when the persisted file is blank', () => {
    const { fs, recorded } = fakeFs({ '/fake/home/.kiaaccess-mcp/device-id': '   \n' });
    expect(resolveDeviceId({ fs, homeDir: HOME, generate: () => GENERATED })).toBe(GENERATED);
    expect(recorded.write).toHaveLength(1);
  });

  it('falls back to an in-memory id when persistence fails, warning on stderr', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fs } = fakeFs({}, { failWrite: true });
    expect(resolveDeviceId({ fs, homeDir: HOME, generate: () => GENERATED })).toBe(GENERATED);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/could not persist/i);
  });

  it('uses the real filesystem and home directory by default, with hardened perms', () => {
    // HOME is redirected at a throwaway temp dir, so `os.homedir()` resolves
    // there and the developer's real ~/.kiaaccess-mcp is never touched.
    const realHome = process.env.HOME;
    const tmpHome = mkdtempSync(join(tmpdir(), 'kiaaccess-home-'));
    process.env.HOME = tmpHome;
    try {
      const id = resolveDeviceId();
      expect(id).toMatch(/^[0-9A-F-]{36}$/);
      // Second call reads the persisted file back rather than minting a new id.
      expect(resolveDeviceId()).toBe(id);
      expect(statSync(join(tmpHome, '.kiaaccess-mcp')).mode & 0o777).toBe(DEVICE_DIR_MODE);
      expect(statSync(join(tmpHome, '.kiaaccess-mcp', 'device-id')).mode & 0o777).toBe(DEVICE_FILE_MODE);
    } finally {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('defaults to a crypto uuid when no generator is injected', () => {
    const { fs, recorded } = fakeFs();
    const id = resolveDeviceId({ fs, homeDir: HOME });
    expect(id).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
    expect(recorded.write[0].data).toBe(`${id}\n`);
  });
});

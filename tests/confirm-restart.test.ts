// fleet-audit#1163: on mcp-host a child idles out after ~10 minutes, close to
// the 600s confirm-token TTL. With a per-process random HMAC key, a user who
// previews an unlock and approves after the child restarted got TOKEN_INVALID.
//
// mcp-utils 2.12 honours MCP_HOST_CONFIRM_SECRET (which mcp-host derives per
// registration for a `state.dataDir: true` child) beside an absolute
// MCP_DATA_DIR, and records spent tokens under that data dir. These tests run
// the preview and the confirmed call in SEPARATE OS processes — a real restart
// — through this repo's own confirm path (kia_lock_doors).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let bundleDir: string;
let childScript: string;

beforeAll(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), 'kia-confirm-bundle-'));
  childScript = join(bundleDir, 'child.mjs');
  // One "server process": register the command tools over a fake client (no
  // network), call kia_lock_doors once, print the tool result's text.
  await build({
    stdin: {
      contents: `
        import { createTestHarness } from '@chrischall/mcp-utils/test';
        import { registerCommandsTools } from ${JSON.stringify(join(ROOT, 'src/tools/commands.ts'))};
        const ok = { status: { statusCode: 0 } };
        const result = (command, path) => ({ command, path, method: 'GET', verified: true, xid: 'FAKE-XID', raw: ok });
        const client = {
          getVehicleStatus: async () => ({ vinKey: 'FAKE-VEHICLE-KEY', lastVehicleInfo: { vehicleStatusRpt: { vehicleStatus: { doorLock: false } } } }),
          lockDoors: async () => result('lock', 'rems/door/lock'),
          unlockDoors: async () => result('unlock', 'rems/door/unlock'),
          startClimate: async () => result('start', 'rems/start'),
          stopClimate: async () => result('stop', 'rems/stop'),
          verifyCommand: async () => ({ verified: true, attempts: 1, elapsedMs: 0, snapshot: { doorLock: true }, changedFields: ['doorLock'], cancelled: false }),
        };
        const [token] = process.argv.slice(2);
        const harness = await createTestHarness((server) => registerCommandsTools(server, client));
        const args = { vinKey: 'FAKE-VEHICLE-KEY', waitSeconds: 0, ...(token ? { confirmToken: token } : {}) };
        const res = await harness.callTool('kia_lock_doors', args);
        process.stdout.write(res.content.map((b) => b.text ?? '').join('\\n'));
        await harness.close();
      `,
      resolveDir: ROOT,
      sourcefile: 'child.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: childScript,
    logLevel: 'silent',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
}, 30_000);
afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'kia-confirm-data-'));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

/** Run one server process to completion; `token` makes it the confirmed call. */
function serverProcess(env: Record<string, string>, token?: string): Promise<string> {
  return new Promise((done, fail) => {
    const base = { ...process.env };
    for (const k of ['MCP_CONFIRM_SECRET', 'MCP_HOST_CONFIRM_SECRET', 'MCP_DATA_DIR', 'MCP_CONFIRM_MODE']) delete base[k];
    const child = spawn(process.execPath, token ? [childScript, token] : [childScript], {
      env: { ...base, KIA_WRITE_MODE: 'all', ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.on('close', (code) => (code === 0 ? done(out) : fail(new Error(`child exited ${code}: ${err}`))));
  });
}

function tokenFrom(preview: string): string {
  const body = JSON.parse(preview) as { status: string; confirmToken: string };
  expect(body.status).toBe('confirmation-required');
  return body.confirmToken;
}

describe('a confirm token across a child restart (fleet-audit#1163)', () => {
  it('mcp-host registers this server with a data dir, so it gets MCP_HOST_CONFIRM_SECRET', () => {
    // mcp-host derives the per-registration secret only for dataDir children.
    expect(readFileSync(join(ROOT, 'mint.yaml'), 'utf8')).toMatch(/^state:\s*\n\s+dataDir:\s*true\b/m);
  });

  it('is accepted by the restarted process under the host-injected secret', async () => {
    const hosted = { MCP_HOST_CONFIRM_SECRET: 'fake-host-derived-secret', MCP_DATA_DIR: dataDir };
    const token = tokenFrom(await serverProcess(hosted));

    const confirmed = await serverProcess(hosted, token);

    expect(confirmed).not.toMatch(/TOKEN_INVALID/);
    expect(JSON.parse(confirmed)).toMatchObject({ commandSent: true, command: 'lock' });
  }, 30_000);

  it('refuses the same token in a THIRD process: the spend is recorded on disk, not in memory', async () => {
    const hosted = { MCP_HOST_CONFIRM_SECRET: 'fake-host-derived-secret', MCP_DATA_DIR: dataDir };
    const token = tokenFrom(await serverProcess(hosted));
    await serverProcess(hosted, token);

    const replay = await serverProcess(hosted, token);

    expect(replay).toMatch(/TOKEN_REUSED/);
    expect(replay).not.toMatch(/"commandSent":true/);
  }, 30_000);

  it('control: without the host secret the restart still invalidates the token (random per-process key)', async () => {
    const token = tokenFrom(await serverProcess({ MCP_DATA_DIR: dataDir }));
    const confirmed = await serverProcess({ MCP_DATA_DIR: dataDir }, token);
    expect(confirmed).toMatch(/TOKEN_INVALID/);
  }, 30_000);
});

/**
 * End-to-end boot guard: spawn the REAL built artifacts and run the handshake
 * an MCP host runs at install time (`initialize` → `tools/list`).
 *
 * Two failure modes this catches, both of which unit tests structurally cannot:
 *
 *  1. **An eager import of an esbuild-externalised dependency.** `dist/bundle.js`
 *     is the `.mcpb` artifact and ships with NO `node_modules`; `dotenv` is
 *     `--external`, so a top-level `import 'dotenv'` anywhere in the graph would
 *     crash the shipped server on launch while every test stayed green. The
 *     bundle is therefore copied ALONE into an empty temp dir before it is run.
 *  2. **A `bin` that points at a path `tsc` never emitted.** `dist/index.js` is
 *     the npm entry point, run here from the repo root with `node_modules`
 *     present.
 *
 * Both are run with NO credentials, which also proves the deferred-config-error
 * pattern end to end: the server must boot and serve a full tool list before any
 * Kia credential exists.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { execSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(ROOT, 'dist', 'bundle.js');
const BIN = join(ROOT, 'dist', 'index.js');

/**
 * A LOWER BOUND, never an exact count — this file must stay green when another
 * branch adds a tool (PRs are CI-tested merged with main). `tests/index.test.ts`
 * owns the exact roster; this one only asserts "the built artifact boots and
 * serves its tools". The value is the full `KIA_WRITE_MODE=all` surface, so
 * dropping a registrar still fails here.
 */
const MIN_TOOLS = 17;

beforeAll(() => {
  if (!existsSync(BUNDLE) || !existsSync(BIN)) {
    execSync('npm run build', { cwd: ROOT, stdio: 'ignore' });
  }
}, 180_000);

/** Spawn an MCP stdio server, run initialize + tools/list, resolve tool names. */
function listToolsViaStdio(entry: string, cwd: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [entry], {
      cwd,
      env: {
        ...process.env,
        // No credentials: the server must still boot and answer tools/list.
        KIA_USERNAME: '',
        KIA_PASSWORD: '',
        // Register the widest surface so MIN_TOOLS means what it says.
        KIA_WRITE_MODE: 'all',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out waiting for tools/list; stderr:\n${err}`));
    }, 20_000);

    child.stdout.on('data', (chunk) => {
      out += String(chunk);
      for (const line of out.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let message: { id?: number; result?: { tools?: { name: string }[] } };
        try {
          message = JSON.parse(trimmed);
        } catch {
          continue; // a partial line — wait for the rest
        }
        if (message.id === 1 && message.result) {
          clearTimeout(timer);
          child.kill('SIGKILL');
          resolve((message.result.tools ?? []).map((tool) => tool.name));
          return;
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      err += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    // 'close' (not 'exit') so stdout is fully drained first — otherwise a fast
    // exit can race the pipe and fail a run that actually answered.
    child.on('close', (code) => {
      if (!out.includes('"id":1')) {
        clearTimeout(timer);
        reject(new Error(`server exited (code ${code}) before answering tools/list; stderr:\n${err}`));
      }
    });

    child.stdin.write(
      '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"boot-test","version":"1"}}}\n',
    );
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  });
}

describe('server boot (built artifacts)', () => {
  it('bundled .mcpb (dist/bundle.js) boots WITHOUT node_modules and lists its tools', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiaaccess-mcpb-'));
    try {
      // Only the bundle — no node_modules, no package.json, no .env. Exactly
      // what a .mcpb install unpacks.
      copyFileSync(BUNDLE, join(dir, 'bundle.js'));
      const tools = await listToolsViaStdio(join(dir, 'bundle.js'), dir);
      expect(tools.length).toBeGreaterThanOrEqual(MIN_TOOLS);
      expect(tools).toContain('kia_session_status');
      expect(tools).toContain('kia_list_vehicles');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('npm bin (dist/index.js) boots with node_modules and lists its tools', async () => {
    const tools = await listToolsViaStdio(BIN, ROOT);
    expect(tools.length).toBeGreaterThanOrEqual(MIN_TOOLS);
    expect(tools).toContain('kia_session_status');
  }, 60_000);
});

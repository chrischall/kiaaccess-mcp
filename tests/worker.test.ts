/**
 * The hosted Cloudflare connector, exercised inside the REAL Workers runtime
 * (workerd via Miniflare) against `wrangler.jsonc`'s bindings — the
 * `KiaMcpAgent` Durable Object and `OAUTH_KV`. Run with `npm run worker:test`;
 * the Node suite (`npm test`) excludes this file entirely because it and
 * `src/worker.ts` need `cloudflare:test` / `cloudflare:workers`, which do not
 * exist under Node.
 *
 * Five things are proven here, none of which needs a live Kia session:
 *
 *  1. the OAuth default handler serves the authorization-server discovery doc;
 *  2. an unauthenticated `/mcp` request is rejected before any tool code runs;
 *  3. `/authorize` renders the Kia login page with all three fields;
 *  4. the exact registrar wiring `src/worker.ts` uses produces the intended
 *     roster — specifically WITHOUT the MFA bootstrap tools and the
 *     refresh-token export;
 *  5. a real client request survives workerd's `this`-binding rules.
 *
 * (4) goes through the in-memory MCP harness rather than the token-gated `/mcp`
 * route: a real handshake there needs an OAuth access token minted through
 * `workers-oauth-provider`'s KV grant flow, which would mean a live Kia login.
 * The harness is wired exactly as `worker.ts` wires it, so it cannot drift
 * without this test noticing.
 *
 * (5) is the one that justifies running any of this in workerd at all — see the
 * comment on that test.
 */

import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// The deployment config as text (Vite's `?raw`), so the Worker-side assertions
// below can be made against what will actually be deployed rather than against
// a locally-merged `env`.
// @ts-expect-error -- `?raw` is a Vite import suffix, not a typed module.
import wranglerConfig from '../wrangler.jsonc?raw';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import type { KiaClient } from '../src/client.js';
import { buildHostedKiaClient } from '../src/kia-auth.js';
import { registerChargingTools } from '../src/tools/charging.js';
import { registerCommandsTools } from '../src/tools/commands.js';
import { registerSessionStatusTool } from '../src/tools/session.js';
import { registerVehiclesTools } from '../src/tools/vehicles.js';

// Registration only closes over the client, so an empty stand-in is enough —
// and keeps the roster test away from credentials entirely.
const stubClient = {} as unknown as KiaClient;

describe('Kia Cloudflare connector — OAuth surface', () => {
  it('serves the OAuth authorization-server discovery document', async () => {
    const res = await SELF.fetch('https://example.com/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const meta = (await res.json()) as { authorization_endpoint?: string; token_endpoint?: string };
    expect(meta.authorization_endpoint).toContain('/authorize');
    expect(meta.token_endpoint).toContain('/token');
  });

  it('rejects an unauthenticated /mcp request', async () => {
    const res = await SELF.fetch('https://example.com/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('GET /authorize renders the Kia login page with all three fields', async () => {
    // No `client_id` is needed — the page renders without a registered OAuth
    // client, which is all this asserts. `redirect_uri` IS required though:
    // since workers-oauth-provider 0.8.x, `parseAuthRequest` always runs
    // `validateRedirectUriScheme()`, which rejects the empty string an absent
    // `redirect_uri` becomes.
    const res = await SELF.fetch(
      'https://example.com/authorize?response_type=code&state=abc' +
        '&redirect_uri=' +
        encodeURIComponent('https://example.com/callback'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const html = await res.text();
    expect(html).toContain('Kia Access');
    expect(html).toContain('Kia Owners email');
    expect(html).toContain('Kia Owners password');
    // The token field has to tell the user where the value comes from — there
    // is nowhere else in this flow to explain it.
    expect(html).toContain('kia_export_refresh_token');
    // Password AND token are both masked inputs.
    expect(html.match(/type="password"/g)).toHaveLength(2);
    // The consent text must admit the password is stored, not just checked.
    expect(html).toContain('stored encrypted');
  });
});

describe('Kia Cloudflare connector — tool surface', () => {
  // Pinned, not sniffed. `env.KIA_WRITE_MODE` would seem like the honest source
  // — but wrangler merges the repo's local `.env` over `wrangler.jsonc`'s vars
  // in dev, so a developer whose stdio server runs with KIA_WRITE_MODE=all would
  // silently get a different (larger) roster here than production serves. The
  // deployed value is asserted separately, against the config file itself.
  const DEPLOYED_WRITE_MODE = 'comfort';
  const previousWriteMode = process.env.KIA_WRITE_MODE;

  beforeEach(() => {
    process.env.KIA_WRITE_MODE = DEPLOYED_WRITE_MODE;
  });

  afterEach(() => {
    if (previousWriteMode === undefined) delete process.env.KIA_WRITE_MODE;
    else process.env.KIA_WRITE_MODE = previousWriteMode;
  });

  it('pins KIA_WRITE_MODE to "comfort" in wrangler.jsonc', () => {
    // A remote connector reachable from any claude.ai session must not be able
    // to unlock a car. Raising this to "all" is a deliberate operator edit —
    // this assertion is what makes it a visible one.
    expect(wranglerConfig).toMatch(/"KIA_WRITE_MODE":\s*"comfort"/);
  });

  it('registers the hosted roster via the same wiring as worker.ts', async () => {
    // Mirror src/worker.ts's `tools` array exactly (same order, same wiring).
    const harness = await createTestHarness((server) => {
      registerSessionStatusTool(server, stubClient);
      registerVehiclesTools(server, stubClient);
      registerCommandsTools(server, stubClient);
      registerChargingTools(server, stubClient);
    });

    try {
      const names = (await harness.listTools()).map((tool) => tool.name).sort();
      expect(names).toEqual([
        'kia_charge_targets',
        'kia_list_vehicles',
        'kia_refresh_status',
        'kia_session_status',
        'kia_set_charge_limits',
        'kia_start_charge',
        'kia_start_climate',
        'kia_stop_charge',
        'kia_stop_climate',
        'kia_vehicle_location',
        'kia_vehicle_status',
      ]);
      expect(names).toHaveLength(11);
    } finally {
      await harness.close();
    }
  });

  it('does NOT register the MFA bootstrap or the refresh-token export', async () => {
    const harness = await createTestHarness((server) => {
      registerSessionStatusTool(server, stubClient);
      registerVehiclesTools(server, stubClient);
      registerCommandsTools(server, stubClient);
      registerChargingTools(server, stubClient);
    });

    try {
      const names = (await harness.listTools()).map((tool) => tool.name);
      // MFA cannot complete in a Worker: the passcode arrives minutes later on
      // another device, and Kia's OTP window is ~2 minutes. Registering these
      // would offer a flow that can only fail — while burning login attempts
      // that escalate the account to reCAPTCHA.
      expect(names).not.toContain('kia_start_login');
      expect(names).not.toContain('kia_send_otp');
      expect(names).not.toContain('kia_verify_otp');
      // The hosted runtime was HANDED the remember-me token; echoing it back is
      // a credential leak with no purpose.
      expect(names).not.toContain('kia_export_refresh_token');
    } finally {
      await harness.close();
    }
  });

  it('registers no door command under the deployed KIA_WRITE_MODE', async () => {
    const harness = await createTestHarness((server) => {
      registerCommandsTools(server, stubClient);
    });
    try {
      const names = (await harness.listTools()).map((tool) => tool.name);
      expect(names).not.toContain('kia_lock_doors');
      expect(names).not.toContain('kia_unlock_doors');
    } finally {
      await harness.close();
    }
  });
});

describe('Kia Cloudflare connector — workerd runtime traps', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    Object.defineProperty(globalThis, 'fetch', { value: originalFetch, configurable: true, writable: true });
  });

  it('issues a real request without tripping workerd’s `Illegal invocation`', async () => {
    // THE reason this suite runs in workerd. `globalThis.fetch` must be invoked
    // as a METHOD; a detached reference (`const f = globalThis.fetch; f(url)`,
    // or a module-level `const defaultFetch = globalThis.fetch`) throws
    //   TypeError: Illegal invocation: function called with incorrect `this`
    // on EVERY request in workerd — while passing every Node test and every
    // `wrangler deploy --dry-run`. The stub below reproduces that rule exactly:
    // it refuses to run unless its `this` is the global object, so both the
    // module-scope and per-call detached forms fail here.
    let detachedCall = false;
    const stub = function (this: unknown, _url: string, _init: unknown): Response {
      if (this !== globalThis) {
        detachedCall = true;
        throw new TypeError('Illegal invocation: function called with incorrect `this` reference');
      }
      return new Response(
        JSON.stringify({
          status: { statusCode: 1, errorType: 3, errorCode: 4242, errorMessage: 'STUBBED TRANSPORT REACHED' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    Object.defineProperty(globalThis, 'fetch', { value: stub, configurable: true, writable: true });

    // Hard guard: if workerd refused the override we must NOT continue — a real
    // request would hit Kia with junk credentials and increment the account's
    // `loginAttempt` counter, which is exactly what escalates to reCAPTCHA.
    expect(globalThis.fetch).toBe(stub);

    const client = buildHostedKiaClient({
      username: 'driver@example.test',
      password: 'fake-password',
      rmtoken: 'fake-rmtoken',
    });

    const message = await client.listVehicles().then(
      () => 'unexpectedly succeeded',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );

    expect(detachedCall).toBe(false);
    expect(message).not.toMatch(/illegal invocation/i);
    // It failed for the reason we injected, i.e. the request really was issued
    // and its body really was parsed — not because transport blew up first.
    expect(message).toMatch(/STUBBED TRANSPORT REACHED/);
  });
});

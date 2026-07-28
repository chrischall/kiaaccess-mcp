/**
 * The hosted Cloudflare remote-connector entry point (claude.ai remote MCP).
 *
 * It wires the SAME transport-neutral tool registrars the stdio server uses
 * (`src/registrars.ts`) into `@chrischall/mcp-connector`'s generic OAuth +
 * `McpAgent` harness. Each user logs in on the connector's own page with their
 * Kia email, password, and the remember-me token they exported from their local
 * stdio server (`src/kia-auth.ts`), and `buildClient` mints a per-user
 * `KiaClient` from those props so concurrent sessions never share a session id.
 *
 * ## Why the roster here is SMALLER than the stdio roster
 *
 * Three tools are deliberately absent, and neither a host setting nor an
 * injected instruction can bring them back — registration is the gate:
 *
 *  - `kia_start_login` / `kia_send_otp` / `kia_verify_otp` — the one-time MFA
 *    bootstrap. It cannot complete in a Worker: the passcode arrives by
 *    SMS/email minutes later on a different device, and Kia's ~2-minute OTP
 *    window plus the reCAPTCHA escalation on failed attempts make a
 *    "try it and see" flow actively harmful. The bootstrap happens once,
 *    locally; this connector consumes its output.
 *  - `kia_export_refresh_token` — it would hand back the very credential the
 *    user just pasted in, from a runtime that was given it rather than one that
 *    minted it. Nothing here needs it, so it is not registered.
 *
 * That is why `registerSessionStatusTool` is used instead of
 * `registerSessionTools`.
 *
 * ## Stateless
 *
 * There is no cache: `wrangler.jsonc` declares only the per-session `MCP_OBJECT`
 * Durable Object (the connector's own agent) and `OAUTH_KV`. Every read goes
 * straight to Kia, which is what you want for vehicle state anyway — a cached
 * door-lock reading is a wrong door-lock reading.
 */

import { createConnector } from '@chrischall/mcp-connector';
import type { KiaClient } from './client.js';
import { type KiaProps, buildHostedKiaClient, kiaAuth } from './kia-auth.js';
import { registerChargingTools } from './tools/charging.js';
import { registerCommandsTools } from './tools/commands.js';
import { registerSessionStatusTool } from './tools/session.js';
import { registerVehiclesTools } from './tools/vehicles.js';
import { VERSION } from './version.js';

const { Agent, handler } = createConnector<KiaProps, KiaClient>({
  name: 'kiaaccess-mcp',
  version: VERSION,
  auth: kiaAuth,
  buildClient: (props) => buildHostedKiaClient(props),
  // Same order as src/registrars.ts, minus the stdio-only session tools:
  // get oriented, look at the car, then act on it. Which command tools actually
  // register still depends on KIA_WRITE_MODE (see wrangler.jsonc's `vars`).
  tools: [registerSessionStatusTool, registerVehiclesTools, registerCommandsTools, registerChargingTools],
});

// The connector's per-session MCP agent Durable Object
// (`wrangler.jsonc`'s `MCP_OBJECT` → `KiaMcpAgent`) resolves this named export.
export { Agent as KiaMcpAgent };

export default handler;

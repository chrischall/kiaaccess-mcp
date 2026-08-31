/**
 * The server's tool surface, in one list.
 *
 * This lives beside `index.ts` rather than inside it because `index.ts` boots a
 * stdio server at import time — importing it from a test would connect a
 * transport. Keeping the registrar list here lets `tests/index.test.ts` assert
 * the REAL roster (and the `KIA_WRITE_MODE` gating) against the same array the
 * entry point uses, so the two can never drift.
 *
 * Order is cosmetic — it only decides the order tools are registered in — but
 * it reads as the setup story: get logged in, look at the car, then act on it.
 */

import type { ToolRegistrar } from '@chrischall/mcp-utils';
import type { KiaClient } from './client.js';
import { registerChargingTools } from './tools/charging.js';
import { registerCommandsTools } from './tools/commands.js';
import { registerHealthcheckTools } from './tools/healthcheck.js';
import { registerSessionTools } from './tools/session.js';
import { registerVehiclesTools } from './tools/vehicles.js';

/**
 * Every registrar, applied in order with the shared {@link KiaClient} as deps.
 *
 * Which tools each one actually registers depends on `KIA_WRITE_MODE`, read at
 * registration time: `none` (and any unrecognised value) registers no vehicle
 * commands at all, `comfort` adds climate + charging, `all` also adds door
 * lock/unlock. Registration is the gate — an unregistered tool cannot be
 * invoked by any host setting or injected instruction.
 */
export const TOOL_REGISTRARS: ToolRegistrar<KiaClient>[] = [
  registerHealthcheckTools,
  registerSessionTools,
  registerVehiclesTools,
  registerCommandsTools,
  registerChargingTools,
];

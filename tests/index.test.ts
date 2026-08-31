/**
 * The whole tool surface, in one place.
 *
 * Two invariants live here:
 *
 *  1. **The exact roster.** Every tool this server advertises, sorted. A new
 *     tool has to be added here deliberately — which is the point: the roster
 *     is the server's public API.
 *  2. **`KIA_WRITE_MODE` gating.** Registration — not a runtime check — is what
 *     stops a vehicle command from being callable, so this asserts which tools
 *     EXIST under each mode, including the fail-closed behaviour on a typo. If
 *     this test ever passes with a lock/unlock tool under `comfort`, the safety
 *     control is gone.
 *
 * The registrars are driven through `TOOL_REGISTRARS` — the same array
 * `src/index.ts` hands to `runMcp` — so the roster asserted here is the roster
 * the server actually serves. (`src/index.ts` itself boots a stdio transport at
 * import time; `tests/server-boot.test.ts` exercises it as a real process.)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import type { KiaClient } from '../src/client.js';
import { TOOL_REGISTRARS } from '../src/registrars.js';

// Registration never calls the client — it only closes over it — so an empty
// stand-in is enough, and keeps this test away from credentials entirely.
const stubClient = {} as unknown as KiaClient;

const originalWriteMode = process.env.KIA_WRITE_MODE;

/** Register the real registrar list under `mode` and return the sorted roster. */
async function rosterUnder(mode: string | undefined): Promise<string[]> {
  if (mode === undefined) delete process.env.KIA_WRITE_MODE;
  else process.env.KIA_WRITE_MODE = mode;

  const harness = await createTestHarness(async (server) => {
    for (const register of TOOL_REGISTRARS) await register(server, stubClient);
  });
  try {
    return (await harness.listTools()).map((tool) => tool.name).sort();
  } finally {
    await harness.close();
  }
}

/** The tools that exist regardless of `KIA_WRITE_MODE`: account + read-only. */
const READ_ONLY_ROSTER = [
  'kia_charge_targets',
  'kia_export_refresh_token',
  'kia_forget_session',
  'kia_healthcheck',
  'kia_list_vehicles',
  'kia_refresh_status',
  'kia_send_otp',
  'kia_session_status',
  'kia_start_login',
  'kia_vehicle_location',
  'kia_vehicle_status',
  'kia_verify_otp',
];

/** `comfort` adds the climate and charging commands. */
const COMFORT_ROSTER = [
  ...READ_ONLY_ROSTER,
  'kia_set_charge_limits',
  'kia_start_charge',
  'kia_start_climate',
  'kia_stop_charge',
  'kia_stop_climate',
].sort();

/** `all` additionally unlocks the doors — literally. */
const FULL_ROSTER = [...COMFORT_ROSTER, 'kia_lock_doors', 'kia_unlock_doors'].sort();

beforeEach(() => {
  delete process.env.KIA_WRITE_MODE;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalWriteMode === undefined) delete process.env.KIA_WRITE_MODE;
  else process.env.KIA_WRITE_MODE = originalWriteMode;
});

describe('full tool surface', () => {
  it('registers exactly 19 tools under KIA_WRITE_MODE=all', async () => {
    const names = await rosterUnder('all');
    expect(names).toEqual([
      'kia_charge_targets',
      'kia_export_refresh_token',
      'kia_forget_session',
  'kia_healthcheck',
      'kia_list_vehicles',
      'kia_lock_doors',
      'kia_refresh_status',
      'kia_send_otp',
      'kia_session_status',
      'kia_set_charge_limits',
      'kia_start_charge',
      'kia_start_climate',
      'kia_start_login',
      'kia_stop_charge',
      'kia_stop_climate',
      'kia_unlock_doors',
      'kia_vehicle_location',
      'kia_vehicle_status',
      'kia_verify_otp',
    ]);
    expect(names).toHaveLength(19);
  });

  it('namespaces every tool under `kia_`', async () => {
    const names = await rosterUnder('all');
    expect(names.filter((n) => !n.startsWith('kia_'))).toEqual([]);
  });
});

describe('KIA_WRITE_MODE gating', () => {
  it('defaults to comfort: climate and charging, but no door commands', async () => {
    const names = await rosterUnder(undefined);
    expect(names).toEqual(COMFORT_ROSTER);
    expect(names).not.toContain('kia_lock_doors');
    expect(names).not.toContain('kia_unlock_doors');
  });

  it('treats an explicit "comfort" the same as the default, case-insensitively', async () => {
    expect(await rosterUnder('comfort')).toEqual(COMFORT_ROSTER);
    expect(await rosterUnder('Comfort')).toEqual(COMFORT_ROSTER);
  });

  it('registers the door commands only under "all"', async () => {
    expect(await rosterUnder('all')).toEqual(FULL_ROSTER);
    expect(await rosterUnder('ALL')).toEqual(FULL_ROSTER);
  });

  it('registers no vehicle command at all under "none"', async () => {
    const names = await rosterUnder('none');
    expect(names).toEqual(READ_ONLY_ROSTER);
    // The read-only surface survives — including the charge-target read, which
    // is not a command.
    expect(names).toContain('kia_charge_targets');
    expect(names).toContain('kia_vehicle_status');
  });

  it('fails CLOSED to "none" on an unrecognized value, warning on stderr', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const names = await rosterUnder('comfrot');
    expect(names).toEqual(READ_ONLY_ROSTER);
    expect(stderr).toHaveBeenCalled();
    expect(stderr.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(/KIA_WRITE_MODE/);
  });

  it('fails closed on a blank value too', async () => {
    // `readEnvVar` treats whitespace-only as unset, which must land on the
    // documented default rather than on an accidental "all".
    expect(await rosterUnder('   ')).toEqual(COMFORT_ROSTER);
  });
});

describe('confirm gating', () => {
  it('gates exactly the tools that act on the car or emit a credential', async () => {
    process.env.KIA_WRITE_MODE = 'all';
    const harness = await createTestHarness(async (server) => {
      for (const register of TOOL_REGISTRARS) await register(server, stubClient);
    });
    try {
      const { tools } = await harness.client.listTools();
      const gated = tools
        .filter((tool) => Object.keys(tool.inputSchema.properties ?? {}).includes('confirm'))
        .map((tool) => tool.name)
        .sort();
      // Every tool that moves the vehicle is here. The two that are NOT are
      // deliberate: kia_send_otp and kia_verify_otp are inner steps of a login
      // the already-confirmed kia_start_login began, and cannot run without the
      // otpKey/xid it returned.
      expect(gated).toEqual([
        'kia_export_refresh_token',
        'kia_forget_session',
        'kia_lock_doors',
        'kia_set_charge_limits',
        'kia_start_charge',
        'kia_start_climate',
        'kia_start_login',
        'kia_stop_charge',
        'kia_stop_climate',
        'kia_unlock_doors',
      ]);
    } finally {
      await harness.close();
    }
  });
});

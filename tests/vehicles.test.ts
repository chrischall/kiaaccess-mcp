/**
 * Tests for the read-only vehicle tools.
 *
 * The Kia client is a stub — nothing here touches the network, and every
 * fixture is an obvious fake (no real VIN, vehicle key, session id, or
 * coordinates).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildVehicleStatusBody } from '../src/client.js';
import type { KiaClient } from '../src/client.js';
import { maskVin, registerVehiclesTools } from '../src/tools/vehicles.js';

// --- fixtures (deliberate fakes) -------------------------------------------

const KEY = 'FAKEVEHICLEKEY1';
const OTHER_KEY = 'FAKEVEHICLEKEY2';
const FAKE_VIN = 'FAKEVIN0000ABC123'; // 17 chars, obviously not a real VIN

function vehicleFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vehicleKey: KEY,
    vin: FAKE_VIN,
    nickName: 'Fake EV9',
    modelName: 'EV9',
    modelYear: '2024',
    trim: 'FAKE-TRIM',
    colorName: 'Fake Silver',
    mileage: '1234',
    fuelType: 4,
    telematicsUnit: 1,
    enrollmentStatus: 1,
    generation: 3,
    ...overrides,
  };
}

/** A `cmm/gvi` record, shaped exactly as docs/KIA-API.md describes it. */
function infoFixture(overrides: { vehicleStatus?: unknown; location?: unknown } = {}): Record<string, unknown> {
  return {
    vinKey: KEY,
    lastVehicleInfo: {
      vehicleNickName: 'Fake EV9',
      vehicleStatusRpt: {
        vehicleStatus:
          'vehicleStatus' in overrides
            ? overrides.vehicleStatus
            : {
                doorLock: true,
                ign3: false,
                engine: false,
                // NESTED — there is no flat `airCtrlOn`.
                climate: { airCtrl: false, defrost: false, airTemp: { value: '72', unit: 1 } },
                // Advances on EVERY read; never a change-detection signal.
                syncDate: { utc: '20260727190000', offset: -4 },
                evStatus: { batteryStatus: 78 },
              },
      },
      location:
        'location' in overrides
          ? overrides.location
          : { coord: { lat: 12.34, lon: -56.78, alt: 1, type: 0 }, head: 90, speed: { unit: 1, value: 0 } },
    },
  };
}

const successEnvelope = { status: { statusCode: 0, errorMessage: 'Success with response body' } };

// --- stub client ------------------------------------------------------------

/** Every client method the tools may touch, plus every mutation (to prove none fires). */
function makeStub() {
  return {
    listVehicles: vi.fn(async () => [vehicleFixture()] as unknown[]),
    getVehicleStatus: vi.fn(async (_key: string, _opts?: unknown) => infoFixture() as unknown),
    forceVehicleRefresh: vi.fn(async (_key: string) => successEnvelope as unknown),
    getChargeTargets: vi.fn(async () => []),
    lockDoors: vi.fn(async () => successEnvelope),
    unlockDoors: vi.fn(async () => successEnvelope),
    startClimate: vi.fn(async () => successEnvelope),
    stopClimate: vi.fn(async () => successEnvelope),
    startCharge: vi.fn(async () => successEnvelope),
    cancelCharge: vi.fn(async () => successEnvelope),
    setChargeTargets: vi.fn(async () => successEnvelope),
  };
}

type Stub = ReturnType<typeof makeStub>;

const MUTATING_METHODS = [
  'lockDoors',
  'unlockDoors',
  'startClimate',
  'stopClimate',
  'startCharge',
  'cancelCharge',
  'setChargeTargets',
] as const;

let stub: Stub;
let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(async () => {
  stub = makeStub();
  harness = await createTestHarness((server: McpServer) =>
    registerVehiclesTools(server, stub as unknown as KiaClient),
  );
});

afterEach(async () => {
  await harness.close();
});

function expectNoMutations(): void {
  for (const method of MUTATING_METHODS) expect(stub[method]).not.toHaveBeenCalled();
}

// --- registration -----------------------------------------------------------

describe('registerVehiclesTools', () => {
  it('registers exactly the four read-only vehicle tools', async () => {
    const names = (await harness.listTools()).map((t) => t.name).sort();
    expect(names).toEqual([
      'kia_list_vehicles',
      'kia_refresh_status',
      'kia_vehicle_location',
      'kia_vehicle_status',
    ]);
  });

  it('annotates every tool readOnlyHint: true', async () => {
    const { tools } = await harness.client.listTools();
    expect(tools).toHaveLength(4);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} must be readOnlyHint: true`).toBe(true);
    }
  });

  it('registers no mutating tool: nothing here takes a `confirm` gate', async () => {
    // This registrar owns reads only, so the fleet's confirm/dry-run rule has
    // nothing to gate. If a mutation ever lands here, this test fails and the
    // author must add `schemaConfirm` + a no-network preview.
    const { tools } = await harness.client.listTools();
    for (const tool of tools) {
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(Object.keys(properties), `${tool.name} must not need confirm`).not.toContain('confirm');
    }
  });

  it('never calls a mutating client method from any read tool', async () => {
    await harness.callTool('kia_list_vehicles');
    await harness.callTool('kia_vehicle_status');
    await harness.callTool('kia_refresh_status');
    await harness.callTool('kia_vehicle_location');
    expectNoMutations();
  });
});

// --- kia_list_vehicles ------------------------------------------------------

describe('kia_list_vehicles', () => {
  it('returns the documented summary fields with the VIN masked to its last 6', async () => {
    const result = await harness.callTool('kia_list_vehicles');
    expect(result.isError).toBeFalsy();
    const data = parseToolResult<{ count: number; vehicles: Record<string, unknown>[] }>(result);
    expect(data.count).toBe(1);
    expect(data.vehicles[0]).toEqual({
      vehicleKey: KEY,
      vin: '***********ABC123',
      nickName: 'Fake EV9',
      modelYear: '2024',
      modelName: 'EV9',
      trim: 'FAKE-TRIM',
      mileage: '1234',
      fuelType: 4,
      telematicsUnit: 1,
    });
    // The full VIN must never reach the transcript.
    expect(JSON.stringify(data)).not.toContain(FAKE_VIN);
  });

  it('reports a null vin when the account record has none', async () => {
    stub.listVehicles.mockResolvedValue([vehicleFixture({ vin: undefined })]);
    const data = parseToolResult<{ vehicles: { vin: string | null }[] }>(await harness.callTool('kia_list_vehicles'));
    expect(data.vehicles[0].vin).toBeNull();
  });

  it('handles an account with no enrolled vehicles', async () => {
    stub.listVehicles.mockResolvedValue([]);
    const data = parseToolResult<{ count: number; vehicles: unknown[] }>(await harness.callTool('kia_list_vehicles'));
    expect(data).toEqual({ count: 0, vehicles: [] });
  });
});

describe('maskVin', () => {
  it('keeps only the last 6 characters', () => {
    expect(maskVin(FAKE_VIN)).toBe('***********ABC123');
  });

  it('returns null for a missing vin', () => {
    expect(maskVin(undefined)).toBeNull();
  });

  it('returns a too-short value unchanged (never a real VIN)', () => {
    expect(maskVin('ABC12')).toBe('ABC12');
  });
});

// --- vehicle_key defaulting -------------------------------------------------

describe('vehicle_key defaulting', () => {
  it('defaults to the sole vehicle when the account has exactly one', async () => {
    await harness.callTool('kia_vehicle_status');
    expect(stub.listVehicles).toHaveBeenCalledTimes(1);
    expect(stub.getVehicleStatus).toHaveBeenCalledWith(KEY, { includeClimate: true });
  });

  it('does not list vehicles when vehicle_key is supplied', async () => {
    await harness.callTool('kia_vehicle_status', { vehicle_key: OTHER_KEY });
    expect(stub.listVehicles).not.toHaveBeenCalled();
    expect(stub.getVehicleStatus).toHaveBeenCalledWith(OTHER_KEY, { includeClimate: true });
  });

  it('errors with an actionable message when the account has no vehicles', async () => {
    stub.listVehicles.mockResolvedValue([]);
    const result = await harness.callTool('kia_vehicle_status');
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/no enrolled vehicles/i);
    expect(stub.getVehicleStatus).not.toHaveBeenCalled();
  });

  it('errors and names the choices when the account has more than one vehicle', async () => {
    stub.listVehicles.mockResolvedValue([
      vehicleFixture(),
      vehicleFixture({ vehicleKey: OTHER_KEY, nickName: undefined }),
    ]);
    const result = await harness.callTool('kia_vehicle_status');
    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0].text;
    expect(text).toContain('vehicle_key');
    expect(text).toContain(KEY);
    expect(text).toContain('Fake EV9');
    expect(text).toContain(OTHER_KEY);
    expect(text).toContain('unnamed');
    expect(stub.getVehicleStatus).not.toHaveBeenCalled();
  });

  it('rejects a vehicle_key carrying header-injection characters', async () => {
    const result = await harness.callTool('kia_vehicle_status', { vehicle_key: 'bad key/../x' });
    expect(result.isError).toBe(true);
    expect(stub.getVehicleStatus).not.toHaveBeenCalled();
  });
});

// --- kia_vehicle_status -----------------------------------------------------

describe('kia_vehicle_status', () => {
  it('requests the climate-bearing config flags (airTempRange/seatHeatCoolOption = "1")', async () => {
    await harness.callTool('kia_vehicle_status', { vehicle_key: KEY });
    const [, opts] = stub.getVehicleStatus.mock.calls[0];
    expect(opts).toEqual({ includeClimate: true });
    // Prove those options really produce the flags the nested `climate` block
    // requires — with them at "0" the whole object is absent from cmm/gvi.
    const body = buildVehicleStatusBody(KEY, opts as { includeClimate?: boolean }) as {
      vehicleConfigReq: { airTempRange: string; seatHeatCoolOption: string };
    };
    expect(body.vehicleConfigReq.airTempRange).toBe('1');
    expect(body.vehicleConfigReq.seatHeatCoolOption).toBe('1');
  });

  it('summarizes doors, the EV ignition proxy, and the NESTED climate block', async () => {
    const data = parseToolResult<{
      vehicleKey: string;
      nickName: string;
      doors: { locked: boolean };
      ignition: { ign3: boolean; engine: boolean; note: string };
      climate: { present: boolean; airCtrl: boolean; defrost: boolean; airTemp: { value: string; unit: number } };
      syncDate: unknown;
    }>(await harness.callTool('kia_vehicle_status', { vehicle_key: KEY }));

    expect(data.vehicleKey).toBe(KEY);
    expect(data.nickName).toBe('Fake EV9');
    expect(data.doors.locked).toBe(true);
    expect(data.ignition).toMatchObject({ ign3: false, engine: false });
    expect(data.ignition.note).toMatch(/ign3/);
    expect(data.climate).toMatchObject({
      present: true,
      airCtrl: false,
      defrost: false,
      airTemp: { value: '72', unit: 1 },
    });
    // syncDate is reported for humans but flagged as useless for change detection.
    expect(data.syncDate).toEqual({ utc: '20260727190000', offset: -4 });
  });

  /**
   * `heatVentSeat` arrives on every climate-bearing read (it needs the same
   * `seatHeatCoolOption: "1"` flag the rest of the block does) but was dropped
   * by the projection, so it was reachable only through `include_raw`.
   */
  it('surfaces the per-seat heat/vent block that already arrives with the climate read', async () => {
    stub.getVehicleStatus.mockResolvedValue(
      infoFixture({
        vehicleStatus: {
          doorLock: true,
          climate: {
            airCtrl: false,
            heatVentSeat: {
              driverSeat: { heatVentType: 0, heatVentLevel: 1 },
              passengerSeat: { heatVentType: 2, heatVentLevel: 3 },
            },
          },
        },
      }),
    );

    const data = parseToolResult<{
      climate: { seats: { present: boolean; positions: Record<string, unknown>; note: string } };
    }>(await harness.callTool('kia_vehicle_status', { vehicle_key: KEY }));

    expect(data.climate.seats.present).toBe(true);
    expect(data.climate.seats.positions).toEqual({
      driverSeat: { heatVentType: 0, heatVentLevel: 1 },
      passengerSeat: { heatVentType: 2, heatVentLevel: 3 },
    });
  });

  /**
   * The numbers are passed through untranslated on purpose. docs/KIA-API.md
   * records only one observed sample (`{heatVentType: 0, heatVentLevel: 1}`),
   * which pins down neither which value means "off" nor which means "cooling" —
   * so rendering "ventilating on level 3" would be an invention, and about a
   * physical comfort feature the user would then act on.
   */
  it('does not invent a meaning for the heatVentType / heatVentLevel encoding', async () => {
    stub.getVehicleStatus.mockResolvedValue(
      infoFixture({
        vehicleStatus: {
          climate: { airCtrl: false, heatVentSeat: { driverSeat: { heatVentType: 2, heatVentLevel: 3 } } },
        },
      }),
    );

    const payload = parseToolResult<{ climate: { seats: { note: string } } }>(
      await harness.callTool('kia_vehicle_status', { vehicle_key: KEY }),
    );

    expect(payload.climate.seats.note).toMatch(/unverified/i);

    // Scoped to the DATA, not the note: the note deliberately contains the words
    // "heating" and "ventilating" because it is the instruction not to use them.
    // What must stay free of decoded labels is the reported value itself.
    const positions = JSON.stringify(payload.climate.seats.positions).toLowerCase();
    for (const invented of ['ventilat', 'cooling', 'heat on', 'level 3', 'off']) {
      expect(positions, `must not decode the encoding as ${invented}`).not.toContain(invented);
    }
    // Every reported leaf is a raw number, never a rendered word.
    for (const seat of Object.values(payload.climate.seats.positions as Record<string, Record<string, unknown>>)) {
      for (const value of Object.values(seat)) expect(typeof value).toBe('number');
    }
  });

  it('flags absent seat data as absent, not as "no heated seats"', async () => {
    stub.getVehicleStatus.mockResolvedValue(
      infoFixture({ vehicleStatus: { doorLock: true, climate: { airCtrl: false } } }),
    );

    const data = parseToolResult<{ climate: { present: boolean; seats: { present: boolean; note: string } } }>(
      await harness.callTool('kia_vehicle_status', { vehicle_key: KEY }),
    );

    expect(data.climate.present).toBe(true);
    expect(data.climate.seats.present).toBe(false);
    // Absence has three possible causes and the note must not collapse them
    // into "this car has no heated seats" — that is a capability claim, and
    // capability detection needs cmm/gvi's vehicleFeature block, which this
    // server does not request.
    expect(data.climate.seats.note).toMatch(/not.*(mean|the same)/i);
    expect(data.climate.seats).not.toHaveProperty('positions');
  });

  it('flags an absent climate block instead of pretending it is off', async () => {
    stub.getVehicleStatus.mockResolvedValue(
      infoFixture({ vehicleStatus: { doorLock: false, ign3: false, engine: false } }),
    );
    const data = parseToolResult<{ climate: { present: boolean; note: string } }>(
      await harness.callTool('kia_vehicle_status', { vehicle_key: KEY }),
    );
    expect(data.climate.present).toBe(false);
    expect(data.climate.note).toMatch(/airTempRange/);
    // No invented `airCtrl: false` — absence must not read as "climate is off".
    expect(data.climate).not.toHaveProperty('airCtrl');
  });

  it('omits the raw status block by default and includes it on request', async () => {
    const lean = parseToolResult<Record<string, unknown>>(
      await harness.callTool('kia_vehicle_status', { vehicle_key: KEY }),
    );
    expect(lean).not.toHaveProperty('raw');

    const full = parseToolResult<{ raw: { evStatus: { batteryStatus: number } } }>(
      await harness.callTool('kia_vehicle_status', { vehicle_key: KEY, include_raw: true }),
    );
    expect(full.raw.evStatus.batteryStatus).toBe(78);
  });

  it('errors when cmm/gvi returns no record for the vehicle', async () => {
    stub.getVehicleStatus.mockResolvedValue(null);
    const result = await harness.callTool('kia_vehicle_status', { vehicle_key: KEY });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/no vehicle record/i);
  });

  it('errors when the record carries no vehicleStatus (no lastVehicleInfo)', async () => {
    stub.getVehicleStatus.mockResolvedValue({ vinKey: KEY });
    const result = await harness.callTool('kia_vehicle_status', { vehicle_key: KEY });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/no vehicleStatus/i);
  });

  it('errors when vehicleStatusRpt carries no vehicleStatus', async () => {
    stub.getVehicleStatus.mockResolvedValue(infoFixture({ vehicleStatus: undefined }));
    const result = await harness.callTool('kia_vehicle_status', { vehicle_key: KEY });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/no vehicleStatus/i);
  });
});

// --- kia_refresh_status -----------------------------------------------------

describe('kia_refresh_status', () => {
  it('warns in its description that it wakes the telematics unit and is slower', async () => {
    const { tools } = await harness.client.listTools();
    const description = tools.find((t) => t.name === 'kia_refresh_status')?.description ?? '';
    expect(description).toMatch(/telematics/i);
    expect(description).toMatch(/slow/i);
  });

  it('calls rems/rvs for the resolved vehicle and reports the acknowledgement', async () => {
    const data = parseToolResult<{ vehicleKey: string; requested: boolean; status: { statusCode: number } }>(
      await harness.callTool('kia_refresh_status'),
    );
    expect(stub.forceVehicleRefresh).toHaveBeenCalledWith(KEY);
    expect(data).toMatchObject({ vehicleKey: KEY, requested: true, status: { statusCode: 0 } });
  });

  it('tells the caller to re-read the status afterwards, and does not read it itself', async () => {
    const data = parseToolResult<{ nextStep: string }>(await harness.callTool('kia_refresh_status'));
    expect(data.nextStep).toContain('kia_vehicle_status');
    expect(stub.getVehicleStatus).not.toHaveBeenCalled();
  });
});

// --- kia_vehicle_location ---------------------------------------------------

describe('kia_vehicle_location', () => {
  it('returns the location block with derived coordinates and a map link', async () => {
    const data = parseToolResult<{
      vehicleKey: string;
      latitude: number;
      longitude: number;
      mapUrl: string;
      location: { head: number };
    }>(await harness.callTool('kia_vehicle_location'));

    expect(stub.getVehicleStatus).toHaveBeenCalledWith(KEY, { includeClimate: true });
    expect(data.vehicleKey).toBe(KEY);
    expect(data.latitude).toBe(12.34);
    expect(data.longitude).toBe(-56.78);
    expect(data.mapUrl).toBe('https://www.google.com/maps/search/?api=1&query=12.34,-56.78');
    expect(data.location.head).toBe(90);
  });

  it('returns the raw block without coordinates when the shape is unfamiliar', async () => {
    stub.getVehicleStatus.mockResolvedValue(infoFixture({ location: { somethingElse: true } }));
    const data = parseToolResult<Record<string, unknown>>(await harness.callTool('kia_vehicle_location'));
    expect(data).not.toHaveProperty('latitude');
    expect(data).not.toHaveProperty('mapUrl');
    expect(data.location).toEqual({ somethingElse: true });
  });

  it('errors when cmm/gvi returns no record', async () => {
    stub.getVehicleStatus.mockResolvedValue(null);
    const result = await harness.callTool('kia_vehicle_location');
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/no vehicle record/i);
  });

  it('errors when the record carries no location block', async () => {
    stub.getVehicleStatus.mockResolvedValue(infoFixture({ location: undefined }));
    const result = await harness.callTool('kia_vehicle_location');
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/no location/i);
  });

  it('errors when the whole lastVehicleInfo is missing', async () => {
    stub.getVehicleStatus.mockResolvedValue({ vinKey: KEY });
    const result = await harness.callTool('kia_vehicle_location');
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/no location/i);
  });
});

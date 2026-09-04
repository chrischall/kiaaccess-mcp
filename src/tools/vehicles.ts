/**
 * Read-only vehicle tools: the account's cars, their cached status, a forced
 * telematics refresh, and the last known location.
 *
 * Nothing in this file mutates the vehicle, so no tool here takes the fleet's
 * `confirm` gate — if a mutation is ever added it MUST route through
 * `KiaClient.command()` and grow a dry-run preview.
 *
 * Three live-verified traps this file exists to respect (see `docs/KIA-API.md`):
 *
 *  1. **Climate is nested and conditional.** `vehicleStatus.climate.{airCtrl,…}`
 *     — there is no flat `airCtrlOn` — and the whole block is ABSENT unless
 *     `cmm/gvi` is called with `airTempRange: "1"` and `seatHeatCoolOption: "1"`.
 *     Every read here passes `includeClimate: true`, and an absent block is
 *     reported as *absent*, never as "climate is off".
 *  2. **`ign3`, not `engine`, is the ignition.** On an EV `engine` stays `false`
 *     with remote climate running.
 *  3. **`syncDate` advances on every read.** It is surfaced for humans and
 *     explicitly labelled as useless for before/after change detection.
 */

import { McpToolError, SafePathSegment, minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { extractVehicleStatus } from '../client.js';
import type { KiaClient, KiaSeatHeatVent, KiaVehicleInfo, KiaVehicleSummary } from '../client.js';

/** How many trailing VIN characters stay visible. */
const VIN_VISIBLE_SUFFIX = 6;

/**
 * Mask a VIN to its last {@link VIN_VISIBLE_SUFFIX} characters. A VIN uniquely
 * identifies a car (and its owner) and is never needed to drive this server —
 * `vehicleKey` is what every vehicle-scoped call uses — so the full value never
 * reaches a transcript.
 */
export function maskVin(vin: string | undefined): string | null {
  if (!vin) return null;
  // Anything this short is not a real 17-character VIN; masking it would just
  // erase the whole value.
  if (vin.length <= VIN_VISIBLE_SUFFIX) return vin;
  return `${'*'.repeat(vin.length - VIN_VISIBLE_SUFFIX)}${vin.slice(-VIN_VISIBLE_SUFFIX)}`;
}

/** The projection `kia_list_vehicles` returns (VIN masked). */
function summarizeVehicle(vehicle: KiaVehicleSummary): Record<string, unknown> {
  return {
    vehicleKey: vehicle.vehicleKey,
    vin: maskVin(vehicle.vin),
    nickName: vehicle.nickName,
    modelYear: vehicle.modelYear,
    modelName: vehicle.modelName,
    trim: vehicle.trim,
    mileage: vehicle.mileage,
    fuelType: vehicle.fuelType,
    telematicsUnit: vehicle.telematicsUnit,
  };
}

/**
 * Resolve the vehicle a tool call is about: the caller's `vehicle_key`, or the
 * sole enrolled vehicle when the account has exactly one. With several cars the
 * caller must choose — guessing would send a command to the wrong vehicle.
 */
export async function resolveVehicleKey(client: KiaClient, vehicleKey?: string): Promise<string> {
  if (vehicleKey) return vehicleKey;
  const vehicles = await client.listVehicles();
  if (vehicles.length === 1) return vehicles[0].vehicleKey;
  if (vehicles.length === 0) {
    throw new McpToolError('This Kia account has no enrolled vehicles.', {
      hint: 'Enroll the car in the Kia Access app first, then retry. `kia_list_vehicles` shows what the account can see.',
    });
  }
  const choices = vehicles.map((v) => `${v.vehicleKey} (${v.nickName ?? 'unnamed'})`).join(', ');
  throw new McpToolError(
    `This Kia account has ${vehicles.length} vehicles, so vehicle_key is required. Choices: ${choices}.`,
    { hint: 'Run kia_list_vehicles and pass the vehicleKey of the car you mean.' },
  );
}

/** Fetch one `cmm/gvi` record, always with the climate-bearing config flags. */
async function readVehicleInfo(client: KiaClient, vehicleKey: string): Promise<KiaVehicleInfo> {
  const info = await client.getVehicleStatus(vehicleKey, { includeClimate: true });
  if (!info) {
    throw new McpToolError(`Kia returned no vehicle record for vehicle_key ${vehicleKey}.`, {
      hint: 'Check the key with kia_list_vehicles — cmm/gvi answers with an empty list for an unknown vinKey.',
    });
  }
  return info;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Pull a numeric coordinate out of the location block.
 *
 * **The `location` shape is not enumerated in `docs/KIA-API.md`** — the live
 * capture confirmed the block exists but not its field names. `coord.lat` /
 * `coord.lon` is therefore treated as a best guess: when it does not match, the
 * raw block is still returned untouched and no coordinates are invented.
 */
function readCoordinate(coord: unknown, key: 'lat' | 'lon'): number | undefined {
  const value = isRecord(coord) ? coord[key] : undefined;
  return typeof value === 'number' ? value : undefined;
}

/**
 * Report the per-seat heat/vent block.
 *
 * Two things this deliberately does NOT do:
 *
 *  1. **Decode the numbers.** `docs/KIA-API.md` has one observed sample
 *     (`{ heatVentType: 0, heatVentLevel: 1 }`), which identifies neither the
 *     "off" value nor which type is heating rather than ventilation. Rendering
 *     "ventilating on level 3" would be an invention about a physical comfort
 *     feature the user would then act on, so the raw numbers are passed through
 *     and labelled unverified.
 *  2. **Turn absence into a capability claim.** A missing block means the read
 *     did not carry seat data — not that the car has no heated seats. Capability
 *     lives in `cmm/gvi`'s `vehicleFeature` block, which this server does not
 *     request (it sends `vehicleFeature: "0"`).
 */
function describeSeats(seats: Record<string, KiaSeatHeatVent> | undefined): Record<string, unknown> {
  if (seats === undefined) {
    return {
      present: false,
      note:
        'No heatVentSeat block in this response. That is NOT the same as "the seats are off", and NOT the same as ' +
        '"this car has no heated or ventilated seats" — capability is reported by cmm/gvi\'s vehicleFeature block, ' +
        'which this server does not request.',
    };
  }
  return {
    present: true,
    positions: seats,
    note:
      'Raw per-seat values exactly as Kia reports them. The heatVentType / heatVentLevel encoding is UNVERIFIED — ' +
      'only a single sample ({heatVentType: 0, heatVentLevel: 1}) has been observed, which identifies neither the ' +
      'off value nor which type is heating rather than ventilation. Do not tell the user a seat is heating, ' +
      'ventilating, or off based on these numbers.',
  };
}

/** The optional vehicle selector every tool in this file accepts. */
const vehicleKeyInput = SafePathSegment.describe(
  'vehicleKey from kia_list_vehicles. Optional: defaults to the only vehicle when the account has exactly one.',
).optional();

export function registerVehiclesTools(server: McpServer, client: KiaClient): void {
  server.registerTool(
    'kia_list_vehicles',
    {
      description:
        'List the vehicles enrolled on this Kia Owners account (ownr/gvl). Returns each vehicleKey — the id every ' +
        'other Kia tool takes — plus nickname, model year/name/trim, mileage, fuel type and telematics unit. ' +
        'VINs are masked to their last 6 characters.',
      annotations: toolAnnotations({ title: 'List Kia vehicles', readOnly: true, idempotent: true, openWorld: true }),
    },
    async () => {
      const vehicles = await client.listVehicles();
      return minifiedResult({ count: vehicles.length, vehicles: vehicles.map(summarizeVehicle) });
    },
  );

  server.registerTool(
    'kia_vehicle_status',
    {
      description:
        "Read the vehicle's CACHED status (cmm/gvi): door lock, ignition, and the remote-climate block. Fast, but " +
        'it reports whatever the telematics unit last uploaded — use kia_refresh_status first when freshness matters. ' +
        'Requested with airTempRange/seatHeatCoolOption = "1" so the nested `climate` object is present; when it is ' +
        'still absent the result says so rather than reporting climate as off. Note `ign3` (not `engine`) is the ' +
        'ignition on an EV, and `syncDate` advances on every read, so it never proves anything changed. ' +
        'Per-seat heat/vent state is reported under `climate.seats` as the RAW numbers Kia sends: the ' +
        '`heatVentType`/`heatVentLevel` encoding is UNVERIFIED, so do not tell the user a seat is heating, ' +
        'ventilating or off based on them. An absent seat block means this read carried no seat data — it does NOT ' +
        'mean the car lacks heated seats, which this server cannot currently determine. ' +
        'Pass include_raw for the untrimmed status block (battery/EV detail, doors, tyres, …).',
      annotations: toolAnnotations({ title: 'Kia vehicle status', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {
        vehicle_key: vehicleKeyInput,
        include_raw: z
          .boolean()
          .describe('Include the full vehicleStatus block as `raw` (default false).')
          .optional(),
      },
    },
    async ({ vehicle_key, include_raw }) => {
      const vehicleKey = await resolveVehicleKey(client, vehicle_key);
      const info = await readVehicleInfo(client, vehicleKey);
      // Read before the guard so the "no lastVehicleInfo" path is exercised too.
      const nickName = info.lastVehicleInfo?.vehicleNickName;
      const status = extractVehicleStatus(info);
      if (!status) {
        throw new McpToolError(`Kia returned no vehicleStatus for vehicle_key ${vehicleKey}.`, {
          hint:
            'The record came back without lastVehicleInfo.vehicleStatusRpt.vehicleStatus. Try kia_refresh_status ' +
            'to wake the telematics unit, then read again.',
        });
      }

      const climate = status.climate;
      return minifiedResult({
        vehicleKey,
        nickName,
        doors: { locked: status.doorLock },
        ignition: {
          ign3: status.ign3,
          engine: status.engine,
          note: 'On an EV `engine` stays false while remote climate runs — `ign3` is the ignition proxy.',
        },
        climate:
          climate === undefined
            ? {
                present: false,
                note:
                  'No climate block in this response. It only appears when cmm/gvi is called with ' +
                  'vehicleConfigReq.airTempRange="1" and seatHeatCoolOption="1"; absent is NOT the same as "off".',
              }
            : {
                present: true,
                airCtrl: climate.airCtrl,
                defrost: climate.defrost,
                airTemp: climate.airTemp,
                seats: describeSeats(climate.heatVentSeat),
                note:
                  'airTemp is what the car reports; it may be its own last-set target rather than the last remote ' +
                  'request (unverified — a start requesting 70 still read back 72).',
              },
        syncDate: status.syncDate,
        syncDateNote: 'Advances on EVERY read whether or not anything changed — never treat it as proof of a change.',
        ...(include_raw ? { raw: status } : {}),
      });
    },
  );

  server.registerTool(
    'kia_refresh_status',
    {
      description:
        'Ask the car for a fresh reading (rems/rvs, requestType 0). This WAKES THE TELEMATICS UNIT, so it is much ' +
        'slower than kia_vehicle_status and draws a little power — prefer the cached read unless staleness matters. ' +
        'Kia only acknowledges the request; it does not return the new data and gives no completion signal, so read ' +
        'kia_vehicle_status afterwards to see the refreshed values.',
      annotations: toolAnnotations({
        title: 'Refresh Kia vehicle status',
        readOnly: true,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: { vehicle_key: vehicleKeyInput },
    },
    async ({ vehicle_key }) => {
      const vehicleKey = await resolveVehicleKey(client, vehicle_key);
      const envelope = await client.forceVehicleRefresh(vehicleKey);
      return minifiedResult({
        vehicleKey,
        requested: true,
        status: envelope.status,
        note:
          'Kia acknowledged the refresh request. The telematics unit answers asynchronously (seconds to a minute) ' +
          'and there is no per-request completion signal — cmm/gts reports global flags only.',
        nextStep: 'Call kia_vehicle_status to read the refreshed values.',
      });
    },
  );

  server.registerTool(
    'kia_vehicle_location',
    {
      description:
        "The vehicle's last known location, from the `location` block of the cached cmm/gvi read. This is where the " +
        'telematics unit last reported being, not a live GPS fix — run kia_refresh_status first for a recent one. ' +
        'Latitude/longitude and a map link are derived when the block carries `coord.lat`/`coord.lon`; otherwise the ' +
        'raw block is returned as-is (its exact field names are not verified).',
      annotations: toolAnnotations({ title: 'Kia vehicle location', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: { vehicle_key: vehicleKeyInput },
    },
    async ({ vehicle_key }) => {
      const vehicleKey = await resolveVehicleKey(client, vehicle_key);
      const info = await readVehicleInfo(client, vehicleKey);
      const location = info.lastVehicleInfo?.location;
      if (!isRecord(location)) {
        throw new McpToolError(`Kia returned no location block for vehicle_key ${vehicleKey}.`, {
          hint:
            'Location sharing may be off for this vehicle, or the telematics unit has not reported since enrollment. ' +
            'Try kia_refresh_status, then read again.',
        });
      }

      const latitude = readCoordinate(location.coord, 'lat');
      const longitude = readCoordinate(location.coord, 'lon');
      const coordinates =
        latitude !== undefined && longitude !== undefined
          ? {
              latitude,
              longitude,
              mapUrl: `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`,
            }
          : {};

      return minifiedResult({
        vehicleKey,
        ...coordinates,
        location,
        note: 'Last reported position from the cached read, not a live fix.',
      });
    },
  );
}

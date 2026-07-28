import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { textResult } from '@chrischall/mcp-utils';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type {
  KiaCommandResult,
  KiaVehicleInfo,
  KiaVehicleStatus,
  VerifyCommandResult,
} from '../src/client.js';
import {
  type KiaCommandsClient,
  getKiaWriteMode,
  registerCommandsTools,
} from '../src/tools/commands.js';

// Obvious fakes only — no real vin, vehicle key, sid or coordinates anywhere.
const VIN_KEY = 'FAKE-VEHICLE-KEY';
const XID = 'FAKE-XID-0001';

const CLIMATE_TOOLS = ['kia_start_climate', 'kia_stop_climate'];
const DOOR_TOOLS = ['kia_lock_doors', 'kia_unlock_doors'];
const ALL_TOOLS = [...DOOR_TOOLS, ...CLIMATE_TOOLS];

/** A `cmm/gvi` record wrapping the given nested `vehicleStatus`. */
function vehicleInfo(status: KiaVehicleStatus): KiaVehicleInfo {
  return {
    vinKey: VIN_KEY,
    lastVehicleInfo: { vehicleNickName: 'Fake Car', vehicleStatusRpt: { vehicleStatus: status } },
  };
}

function commandResult(overrides: Partial<KiaCommandResult> = {}): KiaCommandResult {
  return {
    command: 'lock',
    path: 'rems/door/lock',
    method: 'GET',
    verified: true,
    xid: XID,
    raw: { status: { statusCode: 0, errorMessage: 'Success with response body' } },
    ...overrides,
  };
}

function verification(overrides: Partial<VerifyCommandResult<KiaVehicleStatus | null>> = {}): VerifyCommandResult<
  KiaVehicleStatus | null
> {
  return {
    verified: true,
    attempts: 2,
    elapsedMs: 5200,
    snapshot: { doorLock: true },
    changedFields: ['doorLock'],
    ...overrides,
  };
}

/** Every client method the registrar may reach, as spies. */
function makeClient(): {
  client: KiaCommandsClient;
  spies: {
    getVehicleStatus: ReturnType<typeof vi.fn>;
    lockDoors: ReturnType<typeof vi.fn>;
    unlockDoors: ReturnType<typeof vi.fn>;
    startClimate: ReturnType<typeof vi.fn>;
    stopClimate: ReturnType<typeof vi.fn>;
    verifyCommand: ReturnType<typeof vi.fn>;
  };
} {
  const spies = {
    getVehicleStatus: vi.fn(async () => vehicleInfo({ doorLock: false, ign3: false, climate: { airCtrl: false } })),
    lockDoors: vi.fn(async () => commandResult()),
    unlockDoors: vi.fn(async () => commandResult({ command: 'unlock', path: 'rems/door/unlock' })),
    startClimate: vi.fn(async () => commandResult({ command: 'start', path: 'rems/start', method: 'POST' })),
    stopClimate: vi.fn(async () => commandResult({ command: 'stop', path: 'rems/stop' })),
    verifyCommand: vi.fn(async () => verification()),
  };
  return { client: spies as unknown as KiaCommandsClient, spies };
}

/** Assert no client method was touched — i.e. no network call could have happened. */
function expectNoCalls(spies: Record<string, ReturnType<typeof vi.fn>>): void {
  for (const [name, spy] of Object.entries(spies)) {
    expect(spy, `${name} must not be called`).not.toHaveBeenCalled();
  }
}

async function harnessFor(client: KiaCommandsClient) {
  return createTestHarness((server) => registerCommandsTools(server, client));
}

function textOf(result: CallToolResult): string {
  return result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
}

const originalWriteMode = process.env.KIA_WRITE_MODE;

beforeEach(() => {
  process.env.KIA_WRITE_MODE = 'all';
});

afterEach(() => {
  if (originalWriteMode === undefined) delete process.env.KIA_WRITE_MODE;
  else process.env.KIA_WRITE_MODE = originalWriteMode;
  vi.restoreAllMocks();
});

describe('getKiaWriteMode', () => {
  it('defaults to comfort when unset or blank', () => {
    delete process.env.KIA_WRITE_MODE;
    expect(getKiaWriteMode()).toBe('comfort');
    process.env.KIA_WRITE_MODE = '   ';
    expect(getKiaWriteMode()).toBe('comfort');
  });

  it('accepts the three modes case-insensitively', () => {
    process.env.KIA_WRITE_MODE = 'none';
    expect(getKiaWriteMode()).toBe('none');
    process.env.KIA_WRITE_MODE = 'Comfort';
    expect(getKiaWriteMode()).toBe('comfort');
    process.env.KIA_WRITE_MODE = 'ALL';
    expect(getKiaWriteMode()).toBe('all');
  });

  it('fails closed to none on an unrecognised value, warning on stderr', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.KIA_WRITE_MODE = 'yes-please';
    expect(getKiaWriteMode()).toBe('none');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('yes-please');
    expect(warn.mock.calls[0]?.[0]).toContain('none');
  });
});

describe('registration gate', () => {
  /**
   * Names this registrar contributed. A stand-in for the read tools the other
   * registrars add keeps the server advertising a tools capability even when
   * this one registers nothing, which is what a `none` deployment looks like.
   */
  async function toolNames(): Promise<string[]> {
    const { client } = makeClient();
    const harness = await createTestHarness((server) => {
      server.registerTool('kia_probe_read_tool', { description: 'stand-in read tool', inputSchema: {} }, async () =>
        textResult({}),
      );
      registerCommandsTools(server, client);
    });
    const names = (await harness.listTools()).map((t) => t.name).filter((n) => n !== 'kia_probe_read_tool');
    await harness.close();
    return names.sort();
  }

  it('registers nothing under none', async () => {
    process.env.KIA_WRITE_MODE = 'none';
    expect(await toolNames()).toEqual([]);
  });

  it('registers climate only under comfort (the default)', async () => {
    process.env.KIA_WRITE_MODE = 'comfort';
    expect(await toolNames()).toEqual([...CLIMATE_TOOLS].sort());
    delete process.env.KIA_WRITE_MODE;
    expect(await toolNames()).toEqual([...CLIMATE_TOOLS].sort());
  });

  it('registers door locks only under all', async () => {
    process.env.KIA_WRITE_MODE = 'all';
    expect(await toolNames()).toEqual([...ALL_TOOLS].sort());
  });

  it('registers nothing when the mode is unrecognised (fail closed)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.KIA_WRITE_MODE = 'everything';
    expect(await toolNames()).toEqual([]);
  });
});

describe('tool metadata', () => {
  it('flags the temperature argument as best-effort/unconfirmed and cites the API doc', async () => {
    const { client } = makeClient();
    const harness = await harnessFor(client);
    const { tools } = await harness.client.listTools();
    const start = tools.find((t) => t.name === 'kia_start_climate');
    expect(start?.description).toMatch(/best-effort/i);
    expect(start?.description).toMatch(/unconfirmed/i);
    expect(start?.description).toContain('docs/KIA-API.md');
    await harness.close();
  });

  it('marks unlock destructive and the rest non-destructive, all as writes', async () => {
    const { client } = makeClient();
    const harness = await harnessFor(client);
    const { tools } = await harness.client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(byName.kia_unlock_doors?.destructiveHint).toBe(true);
    expect(byName.kia_lock_doors?.destructiveHint).toBe(false);
    expect(byName.kia_start_climate?.destructiveHint).toBe(false);
    expect(byName.kia_stop_climate?.destructiveHint).toBe(false);
    for (const name of ALL_TOOLS) {
      expect(byName[name]?.readOnlyHint, name).toBe(false);
      expect(byName[name]?.openWorldHint, name).toBe(true);
    }
    await harness.close();
  });
});

describe('confirm gate', () => {
  it.each([
    ['kia_lock_doors', 'GET', 'rems/door/lock'],
    ['kia_unlock_doors', 'GET', 'rems/door/unlock'],
    ['kia_start_climate', 'POST', 'rems/start'],
    ['kia_stop_climate', 'GET', 'rems/stop'],
  ])('%s without confirm makes NO call and previews the request', async (name, method, path) => {
    const { client, spies } = makeClient();
    const harness = await harnessFor(client);
    const result = await harness.callTool(name, { vinKey: VIN_KEY });
    const payload = parseToolResult<Record<string, unknown>>(result);

    expect(result.isError).toBeFalsy();
    expect(payload.dryRun).toBe(true);
    expect(payload.method).toBe(method);
    expect(payload.path).toBe(path);
    expect(payload.url).toBe(`https://api.owners.kia.com/apigw/v1/${path}`);
    expect(payload.endpointVerified).toBe(true);
    expect(String(payload.note)).toContain('confirm: true');
    expectNoCalls(spies);
    await harness.close();
  });

  it('treats confirm:false exactly like an absent confirm', async () => {
    const { client, spies } = makeClient();
    const harness = await harnessFor(client);
    const result = await harness.callTool('kia_lock_doors', { vinKey: VIN_KEY, confirm: false });
    expect(parseToolResult<{ dryRun: boolean }>(result).dryRun).toBe(true);
    expectNoCalls(spies);
    await harness.close();
  });

  it('previews the exact rems/start body, including the temperature sentinel', async () => {
    const { client, spies } = makeClient();
    const harness = await harnessFor(client);

    const numeric = parseToolResult<{ willSend: { remoteClimate: Record<string, unknown> } }>(
      await harness.callTool('kia_start_climate', {
        vinKey: VIN_KEY,
        temperature: 68,
        durationMinutes: 10,
        defrost: true,
      }),
    );
    expect(numeric.willSend.remoteClimate).toMatchObject({
      airTemp: { unit: 1, value: '68' },
      airCtrl: true,
      defrost: true,
      ignitionOnDuration: { unit: 4, value: 10 },
    });
    // heatVentSeat is deliberately absent from the body.
    expect(numeric.willSend.remoteClimate).not.toHaveProperty('heatVentSeat');

    const low = parseToolResult<{ willSend: { remoteClimate: { airTemp: { value: string } } } }>(
      await harness.callTool('kia_start_climate', { vinKey: VIN_KEY, temperature: 'LOW' }),
    );
    expect(low.willSend.remoteClimate.airTemp.value).toBe('LOW');

    expectNoCalls(spies);
    await harness.close();
  });

  it('omits a body from the preview for GET commands', async () => {
    const { client } = makeClient();
    const harness = await harnessFor(client);
    const payload = parseToolResult<Record<string, unknown>>(
      await harness.callTool('kia_stop_climate', { vinKey: VIN_KEY }),
    );
    expect(payload).not.toHaveProperty('willSend');
    await harness.close();
  });

  it('rejects a temperature outside 62-82 that is not LOW/HIGH', async () => {
    const { client, spies } = makeClient();
    const harness = await harnessFor(client);
    const result = await harness.callTool('kia_start_climate', { vinKey: VIN_KEY, temperature: 55 });
    expect(result.isError).toBe(true);
    expectNoCalls(spies);
    await harness.close();
  });

  /**
   * Regression: `temperature` is the only argument whose JSON Schema is a
   * number|string union, and hosts filling it were observed to emit the number
   * as a STRING ("72"). That matched neither union branch, so every plain
   * integer failed with a bare "Invalid input at temperature" while the LOW/HIGH
   * sentinels — already strings — worked fine.
   */
  it('accepts a string-encoded integer and normalises it to the numeric wire value', async () => {
    const { client, spies } = makeClient();
    const harness = await harnessFor(client);

    for (const sent of ['72', '62', '82']) {
      const preview = parseToolResult<{ willSend: { remoteClimate: { airTemp: { value: string } } }; action: string }>(
        await harness.callTool('kia_start_climate', { vinKey: VIN_KEY, temperature: sent }),
      );
      expect(preview.willSend.remoteClimate.airTemp.value).toBe(sent);
      // The echoed action must show the number, not a quoted string.
      expect(preview.action).toContain(`${sent}°F`);
    }

    expectNoCalls(spies);
    await harness.close();
  });

  it('still enforces the 62-82 range on a string-encoded integer', async () => {
    const { client, spies } = makeClient();
    const harness = await harnessFor(client);
    for (const sent of ['55', '99', '72.5', 'warm', '']) {
      const result = await harness.callTool('kia_start_climate', { vinKey: VIN_KEY, temperature: sent });
      expect(result.isError, `temperature ${JSON.stringify(sent)} must be rejected`).toBe(true);
    }
    expectNoCalls(spies);
    await harness.close();
  });

  it('advertises the string form in the published input schema', async () => {
    const { client } = makeClient();
    const harness = await harnessFor(client);
    // `harness.listTools()` is name-only; the underlying client returns the
    // full advertised definition, which is what a host actually reads.
    const { tools } = await harness.client.listTools();
    const tool = tools.find((t) => t.name === 'kia_start_climate');
    const temperature = (tool?.inputSchema as { properties?: Record<string, { anyOf?: unknown[] }> } | undefined)
      ?.properties?.temperature;
    // Assert the branch this fix ADDED. The pre-fix two-branch union already
    // published a `{"type":"string","enum":["LOW","HIGH"]}` entry, so a looser
    // "contains a string somewhere" check passes against the broken schema and
    // cannot fail on the regression it documents. Naming the pattern also pins
    // down which side of the Zod pipe is published (input, not output) — the
    // input side is the one a host reads to decide how to encode the value.
    expect(temperature?.anyOf).toContainEqual(expect.objectContaining({ type: 'string', pattern: '^\\d+$' }));
    await harness.close();
  });
});

describe('confirmed execution', () => {
  it('locks, then reports acceptance and observed state separately', async () => {
    const { client, spies } = makeClient();
    spies.verifyCommand.mockResolvedValue(
      verification({ snapshot: { doorLock: true }, changedFields: ['doorLock'] }),
    );
    const harness = await harnessFor(client);

    const payload = parseToolResult<Record<string, unknown>>(
      await harness.callTool('kia_lock_doors', { vinKey: VIN_KEY, confirm: true }),
    );

    expect(spies.lockDoors).toHaveBeenCalledWith(VIN_KEY);
    expect(payload.dryRun).toBeUndefined();
    expect(payload.commandAccepted).toBe(true);
    expect(payload.stateConfirmed).toBe(true);
    expect(payload.xid).toBe(XID);
    expect(payload.expected).toEqual({ doorLock: true });
    expect(payload.observed).toEqual({ doorLock: true });
    expect(payload.changedFields).toEqual(['doorLock']);
    expect(payload.attempts).toBe(2);
    expect(payload.elapsedSeconds).toBe(5.2);
    expect(String(payload.verificationMethod)).toContain('cmm/gvi');
    expect(String(payload.verificationMethod)).toContain('cmm/gts');
    await harness.close();
  });

  it('reads a baseline before commanding and hands it to verifyCommand', async () => {
    const { client, spies } = makeClient();
    const harness = await harnessFor(client);
    await harness.callTool('kia_lock_doors', { vinKey: VIN_KEY, confirm: true });

    expect(spies.getVehicleStatus).toHaveBeenCalledWith(VIN_KEY, { includeClimate: true });
    // Baseline read happens BEFORE the mutation.
    expect(spies.getVehicleStatus.mock.invocationCallOrder[0]).toBeLessThan(
      spies.lockDoors.mock.invocationCallOrder[0] as number,
    );

    const opts = spies.verifyCommand.mock.calls[0]?.[2] as { baseline: unknown; timeoutMs: number };
    expect(opts.baseline).toEqual({ doorLock: false, ign3: false, climate: { airCtrl: false } });
    expect(opts.timeoutMs).toBe(60_000);
    await harness.close();
  });

  it('passes a re-read function that digs out the nested vehicleStatus', async () => {
    const { client, spies } = makeClient();
    const harness = await harnessFor(client);
    await harness.callTool('kia_lock_doors', { vinKey: VIN_KEY, confirm: true });

    const readFn = spies.verifyCommand.mock.calls[0]?.[0] as () => Promise<KiaVehicleStatus | null>;
    spies.getVehicleStatus.mockResolvedValueOnce(vehicleInfo({ doorLock: true }));
    await expect(readFn()).resolves.toEqual({ doorLock: true });

    spies.getVehicleStatus.mockResolvedValueOnce(null);
    await expect(readFn()).resolves.toBeNull();
    await harness.close();
  });

  it.each([
    ['kia_lock_doors', true],
    ['kia_unlock_doors', false],
  ])('%s gates on doorLock === %s and nothing else', async (name, want) => {
    const { client, spies } = makeClient();
    const harness = await harnessFor(client);
    await harness.callTool(name, { vinKey: VIN_KEY, confirm: true });

    const predicate = spies.verifyCommand.mock.calls[0]?.[1] as (s: KiaVehicleStatus | null) => boolean;
    expect(predicate({ doorLock: want })).toBe(true);
    expect(predicate({ doorLock: !want })).toBe(false);
    expect(predicate({})).toBe(false);
    expect(predicate(null)).toBe(false);
    await harness.close();
  });

  it.each([
    ['kia_start_climate', true],
    ['kia_stop_climate', false],
  ])('%s gates on the NESTED climate.airCtrl === %s', async (name, want) => {
    const { client, spies } = makeClient();
    const harness = await harnessFor(client);
    await harness.callTool(name, { vinKey: VIN_KEY, confirm: true });

    const predicate = spies.verifyCommand.mock.calls[0]?.[1] as (s: KiaVehicleStatus | null) => boolean;
    expect(predicate({ climate: { airCtrl: want } })).toBe(true);
    expect(predicate({ climate: { airCtrl: !want } })).toBe(false);
    // There is no flat `airCtrlOn` — reading one must never satisfy the gate.
    expect(predicate({ airCtrlOn: want } as KiaVehicleStatus)).toBe(false);
    expect(predicate(null)).toBe(false);
    await harness.close();
  });

  it('reports every proof field for climate, including ign3, with nulls when absent', async () => {
    const { client, spies } = makeClient();
    spies.verifyCommand.mockResolvedValue(
      verification({ snapshot: { ign3: true }, changedFields: ['ign3'] }),
    );
    const harness = await harnessFor(client);
    const payload = parseToolResult<Record<string, unknown>>(
      await harness.callTool('kia_start_climate', { vinKey: VIN_KEY, confirm: true }),
    );
    expect(payload.expected).toEqual({ 'climate.airCtrl': true });
    expect(payload.observed).toEqual({ 'climate.airCtrl': null, ign3: true });
    await harness.close();
  });

  it('forwards climate options to the client', async () => {
    const { client, spies } = makeClient();
    const harness = await harnessFor(client);
    await harness.callTool('kia_start_climate', {
      vinKey: VIN_KEY,
      confirm: true,
      temperature: 72,
      durationMinutes: 15,
      defrost: true,
    });
    expect(spies.startClimate).toHaveBeenCalledWith(VIN_KEY, {
      airTempF: 72,
      defrost: true,
      durationMinutes: 15,
    });
    await harness.close();
  });

  it('forwards the LOW/HIGH sentinel unchanged', async () => {
    const { client, spies } = makeClient();
    const harness = await harnessFor(client);
    await harness.callTool('kia_start_climate', { vinKey: VIN_KEY, confirm: true, temperature: 'HIGH' });
    expect(spies.startClimate.mock.calls[0]?.[1]).toMatchObject({ airTempF: 'HIGH' });
    await harness.close();
  });

  it('never claims success when the state change was not observed', async () => {
    const { client, spies } = makeClient();
    spies.verifyCommand.mockResolvedValue(
      verification({ verified: false, attempts: 12, snapshot: { doorLock: false }, changedFields: [] }),
    );
    const harness = await harnessFor(client);
    const result = await harness.callTool('kia_unlock_doors', { vinKey: VIN_KEY, confirm: true });
    const payload = parseToolResult<Record<string, unknown>>(result);

    expect(result.isError).toBeFalsy();
    expect(payload.commandAccepted).toBe(true);
    expect(payload.stateConfirmed).toBe(false);
    expect(String(payload.note)).toContain('NOT');
    expect(String(payload.note)).toMatch(/not.*(done|confirmed)/i);
    await harness.close();
  });

  it('honours waitSeconds, including 0 for fire-and-check-once', async () => {
    const { client, spies } = makeClient();
    const harness = await harnessFor(client);
    await harness.callTool('kia_stop_climate', { vinKey: VIN_KEY, confirm: true, waitSeconds: 0 });
    expect((spies.verifyCommand.mock.calls[0]?.[2] as { timeoutMs: number }).timeoutMs).toBe(0);

    await harness.callTool('kia_stop_climate', { vinKey: VIN_KEY, confirm: true, waitSeconds: 30 });
    expect((spies.verifyCommand.mock.calls[1]?.[2] as { timeoutMs: number }).timeoutMs).toBe(30_000);
    await harness.close();
  });

  it('refuses to command a vehicle Kia does not return, before any mutation', async () => {
    const { client, spies } = makeClient();
    spies.getVehicleStatus.mockResolvedValue(null);
    const harness = await harnessFor(client);
    const result = await harness.callTool('kia_lock_doors', { vinKey: 'FAKE-UNKNOWN-KEY', confirm: true });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('FAKE-UNKNOWN-KEY');
    expect(spies.lockDoors).not.toHaveBeenCalled();
    expect(spies.verifyCommand).not.toHaveBeenCalled();
    await harness.close();
  });

  it('surfaces an upstream command failure as a tool error', async () => {
    const { client, spies } = makeClient();
    spies.stopClimate.mockRejectedValue(new Error('Kia API error on rems/stop: boom'));
    const harness = await harnessFor(client);
    const result = await harness.callTool('kia_stop_climate', { vinKey: VIN_KEY, confirm: true });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('rems/stop');
    await harness.close();
  });
});

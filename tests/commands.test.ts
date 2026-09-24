import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { textResult, withCallSignal } from '@chrischall/mcp-utils';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import type { CallToolResult } from '@modelcontextprotocol/server';
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
import { z } from 'zod';
import {
  callConfirmed,
  previewOf,
  requestConfirmation,
  snapshotConfirmEnv,
} from './confirm-helpers.js';

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
    lastVehicleInfo: {
      vehicleNickName: 'Fake Car',
      vehicleStatusRpt: { vehicleStatus: status },
    },
  };
}

function commandResult(overrides: Partial<KiaCommandResult> = {}): KiaCommandResult {
  return {
    command: 'lock',
    path: 'rems/door/lock',
    method: 'GET',
    verified: true,
    xid: XID,
    raw: {
      status: { statusCode: 0, errorMessage: 'Success with response body' },
    },
    ...overrides,
  };
}

function verification(
  overrides: Partial<VerifyCommandResult<KiaVehicleStatus | null>> = {},
): VerifyCommandResult<KiaVehicleStatus | null> {
  return {
    verified: true,
    attempts: 2,
    elapsedMs: 5200,
    snapshot: { doorLock: true },
    changedFields: ['doorLock'],
    cancelled: false,
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
    getVehicleStatus: vi.fn(async () =>
      vehicleInfo({
        doorLock: false,
        ign3: false,
        climate: { airCtrl: false },
      }),
    ),
    lockDoors: vi.fn(async () => commandResult()),
    unlockDoors: vi.fn(async () => commandResult({ command: 'unlock', path: 'rems/door/unlock' })),
    startClimate: vi.fn(async () =>
      commandResult({ command: 'start', path: 'rems/start', method: 'POST' }),
    ),
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
let restoreConfirmEnv: () => void;

beforeEach(() => {
  process.env.KIA_WRITE_MODE = 'all';
  restoreConfirmEnv = snapshotConfirmEnv();
});

afterEach(() => {
  restoreConfirmEnv();
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
      server.registerTool(
        'kia_probe_read_tool',
        { description: 'stand-in read tool', inputSchema: z.object({}) },
        async () => textResult({}),
      );
      registerCommandsTools(server, client);
    });
    const names = (await harness.listTools())
      .map((t) => t.name)
      .filter((n) => n !== 'kia_probe_read_tool');
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

describe('confirmation gate', () => {
  it.each([
    ['kia_lock_doors', 'GET', 'rems/door/lock'],
    ['kia_unlock_doors', 'GET', 'rems/door/unlock'],
    ['kia_start_climate', 'POST', 'rems/start'],
    ['kia_stop_climate', 'GET', 'rems/stop'],
  ])('%s phase 1 makes NO call and previews the request with a token', async (name, method, path) => {
    const { client, spies } = makeClient();
    const harness = await harnessFor(client);
    const { preview, action } = await requestConfirmation(harness, name, { vinKey: VIN_KEY });

    expect(action).toMatch(/^(vehicle|climate)\./);
    expect(preview.method).toBe(method);
    expect(preview.path).toBe(path);
    expect(preview.url).toBe(`https://api.owners.kia.com/apigw/v1/${path}`);
    expect(preview.vinKey).toBe(VIN_KEY);
    expect(preview.endpointVerified).toBe(true);
    expect(preview.proof).toBeDefined();
    expect(String(preview.note)).toMatch(/not been touched/);
    expectNoCalls(spies);
    await harness.close();
  });

  it.each([
    ['kia_lock_doors', 'lockDoors'],
    ['kia_unlock_doors', 'unlockDoors'],
    ['kia_start_climate', 'startClimate'],
    ['kia_stop_climate', 'stopClimate'],
  ] as const)('%s phase 2 with the returned token sends the command exactly once', async (name, method) => {
    const { client, spies } = makeClient();
    const harness = await harnessFor(client);
    const result = await callConfirmed(harness, name, { vinKey: VIN_KEY });
    expect(result.isError).toBeFalsy();
    expect(parseToolResult<{ commandSent: boolean }>(result).commandSent).toBe(true);
    expect(spies[method]).toHaveBeenCalledTimes(1);
    await harness.close();
  });

  it('advertises confirmToken and no longer accepts a confirm parameter', async () => {
    const { client } = makeClient();
    const harness = await harnessFor(client);
    const { tools } = await harness.client.listTools();
    for (const name of ALL_TOOLS) {
      const tool = tools.find((t) => t.name === name);
      const properties = Object.keys(tool?.inputSchema.properties ?? {});
      expect(properties, name).toContain('confirmToken');
      expect(properties, name).not.toContain('confirm');
      expect(tool?.description, name).toContain('MCP_CONFIRM_MODE');
    }
    await harness.close();
  });

  it('refuses a replayed token as TOKEN_REUSED and does not send again', async () => {
    const { client, spies } = makeClient();
    const harness = await harnessFor(client);
    const { confirmToken } = await requestConfirmation(harness, 'kia_lock_doors', { vinKey: VIN_KEY });
    await harness.callTool('kia_lock_doors', { vinKey: VIN_KEY, confirmToken });
    expect(spies.lockDoors).toHaveBeenCalledTimes(1);

    const replay = await harness.callTool('kia_lock_doors', { vinKey: VIN_KEY, confirmToken });
    expect(replay.isError).toBe(true);
    expect(parseToolResult<{ error: string }>(replay).error).toBe('TOKEN_REUSED');
    expect(spies.lockDoors).toHaveBeenCalledTimes(1);
    await harness.close();
  });

  it('refuses a token whose arguments changed as DRAFT_CHANGED and sends nothing', async () => {
    const { client, spies } = makeClient();
    const harness = await harnessFor(client);
    const { confirmToken } = await requestConfirmation(harness, 'kia_start_climate', {
      vinKey: VIN_KEY,
      temperature: 68,
    });
    const changed = await harness.callTool('kia_start_climate', {
      vinKey: VIN_KEY,
      temperature: 80,
      confirmToken,
    });
    expect(changed.isError).toBe(true);
    const body = parseToolResult<{ error: string; preview: { willSend: { remoteClimate: { airTemp: { value: string } } } } }>(changed);
    expect(body.error).toBe('DRAFT_CHANGED');
    // The fresh preview shows what WOULD be sent now.
    expect(body.preview.willSend.remoteClimate.airTemp.value).toBe('80');
    expectNoCalls(spies);
    await harness.close();
  });

  it('sends after the user accepts an elicitation prompt, without a token', async () => {
    const { client, spies } = makeClient();
    const harness = await createTestHarness((server) => registerCommandsTools(server, client), {
      elicitation: async () => ({ action: 'accept', content: { confirmed: true } }),
    });
    const result = await harness.callTool('kia_lock_doors', { vinKey: VIN_KEY });
    expect(result.isError).toBeFalsy();
    expect(parseToolResult<{ commandSent: boolean }>(result).commandSent).toBe(true);
    expect(spies.lockDoors).toHaveBeenCalledTimes(1);
    await harness.close();
  });

  it('sends nothing when the user declines the elicitation prompt', async () => {
    const { client, spies } = makeClient();
    const harness = await createTestHarness((server) => registerCommandsTools(server, client), {
      elicitation: async () => ({ action: 'decline' }),
    });
    await harness.callTool('kia_unlock_doors', { vinKey: VIN_KEY });
    expectNoCalls(spies);
    await harness.close();
  });

  it('refuses outright under MCP_CONFIRM_MODE=refuse on a client that cannot be prompted', async () => {
    process.env.MCP_CONFIRM_MODE = 'refuse';
    const { client, spies } = makeClient();
    const harness = await harnessFor(client);
    const result = await harness.callTool('kia_lock_doors', { vinKey: VIN_KEY });
    const body = parseToolResult<{ reason: string; dispatched: boolean }>(result);
    expect(body.reason).toBe('confirmation-unsupported');
    expect(body.dispatched).toBe(false);
    expectNoCalls(spies);
    await harness.close();
  });

  it('previews the exact rems/start body, including the temperature sentinel', async () => {
    const { client, spies } = makeClient();
    const harness = await harnessFor(client);

    const numeric = (await previewOf(harness, 'kia_start_climate', {
      vinKey: VIN_KEY,
      temperature: 68,
      durationMinutes: 10,
      defrost: true,
    })) as { willSend: { remoteClimate: Record<string, unknown> } };
    expect(numeric.willSend.remoteClimate).toMatchObject({
      airTemp: { unit: 1, value: '68' },
      airCtrl: true,
      defrost: true,
      ignitionOnDuration: { unit: 4, value: 10 },
    });
    // heatVentSeat is deliberately absent from the body.
    expect(numeric.willSend.remoteClimate).not.toHaveProperty('heatVentSeat');

    const low = (await previewOf(harness, 'kia_start_climate', {
      vinKey: VIN_KEY,
      temperature: 'LOW',
    })) as { willSend: { remoteClimate: { airTemp: { value: string } } } };
    expect(low.willSend.remoteClimate.airTemp.value).toBe('LOW');

    expectNoCalls(spies);
    await harness.close();
  });

  it('omits a body from the preview for GET commands', async () => {
    const { client } = makeClient();
    const harness = await harnessFor(client);
    const payload = await previewOf(harness, 'kia_stop_climate', { vinKey: VIN_KEY });
    expect(payload).not.toHaveProperty('willSend');
    await harness.close();
  });

  it('rejects a temperature outside 62-82 that is not LOW/HIGH', async () => {
    const { client, spies } = makeClient();
    const harness = await harnessFor(client);
    const result = await harness.callTool('kia_start_climate', {
      vinKey: VIN_KEY,
      temperature: 55,
    });
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
      const preview = (await previewOf(harness, 'kia_start_climate', {
        vinKey: VIN_KEY,
        temperature: sent,
      })) as { willSend: { remoteClimate: { airTemp: { value: string } } }; action: string };
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
      const result = await harness.callTool('kia_start_climate', {
        vinKey: VIN_KEY,
        temperature: sent,
      });
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
    const temperature = (
      tool?.inputSchema as { properties?: Record<string, { anyOf?: unknown[] }> } | undefined
    )?.properties?.temperature;
    // Assert the branch this fix ADDED. The pre-fix two-branch union already
    // published a `{"type":"string","enum":["LOW","HIGH"]}` entry, so a looser
    // "contains a string somewhere" check passes against the broken schema and
    // cannot fail on the regression it documents. Naming the pattern also pins
    // down which side of the Zod pipe is published (input, not output) — the
    // input side is the one a host reads to decide how to encode the value.
    expect(temperature?.anyOf).toContainEqual(
      expect.objectContaining({ type: 'string', pattern: '^\\d+$' }),
    );
    await harness.close();
  });
});

describe('confirmed execution', () => {
  it('locks, then reports acceptance and observed state separately', async () => {
    const { client, spies } = makeClient();
    spies.verifyCommand.mockResolvedValue(
      verification({
        snapshot: { doorLock: true },
        changedFields: ['doorLock'],
      }),
    );
    const harness = await harnessFor(client);

    const payload = parseToolResult<Record<string, unknown>>(
      await callConfirmed(harness, 'kia_lock_doors', {
        vinKey: VIN_KEY,
      }),
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
    await callConfirmed(harness, 'kia_lock_doors', {
      vinKey: VIN_KEY,
    });

    expect(spies.getVehicleStatus).toHaveBeenCalledWith(VIN_KEY, {
      includeClimate: true,
    });
    // Baseline read happens BEFORE the mutation.
    expect(spies.getVehicleStatus.mock.invocationCallOrder[0]).toBeLessThan(
      spies.lockDoors.mock.invocationCallOrder[0] as number,
    );

    const opts = spies.verifyCommand.mock.calls[0]?.[2] as {
      baseline: unknown;
      timeoutMs: number;
    };
    expect(opts.baseline).toEqual({
      doorLock: false,
      ign3: false,
      climate: { airCtrl: false },
    });
    // 30s, not 60s: baseline + command + a 60s poll outlasts the MCP SDK
    // client's default 60s request timeout, and a timed-out command looks
    // "failed" to a model that may then fire it again.
    expect(opts.timeoutMs).toBe(30_000);
    await harness.close();
  });

  it('says outright that an unconfirmed command WAS sent and must not be re-sent', async () => {
    const { client, spies } = makeClient();
    spies.verifyCommand.mockResolvedValue(
      verification({ verified: false, attempts: 7, snapshot: { doorLock: true }, changedFields: [] }),
    );
    const harness = await harnessFor(client);
    const result = await callConfirmed(harness, 'kia_unlock_doors', { vinKey: VIN_KEY, });
    const payload = parseToolResult<Record<string, unknown>>(result);

    expect(payload.commandSent).toBe(true);
    expect(String(payload.note)).toMatch(/WAS sent/);
    expect(String(payload.note)).toMatch(/do not send it again/i);
    await harness.close();
  });

  it('notes when verification stopped because the caller cancelled', async () => {
    const { client, spies } = makeClient();
    spies.verifyCommand.mockResolvedValue(
      verification({ verified: false, attempts: 1, snapshot: { doorLock: true }, changedFields: [], cancelled: true }),
    );
    const harness = await harnessFor(client);
    const payload = parseToolResult<Record<string, unknown>>(
      await callConfirmed(harness, 'kia_unlock_doors', { vinKey: VIN_KEY, }),
    );
    expect(String(payload.note)).toContain('verification was cancelled');
    await harness.close();
  });

  it('advertises the lower default wait in the input schema', async () => {
    const { client } = makeClient();
    const harness = await harnessFor(client);
    const { tools } = await harness.client.listTools();
    const lock = tools.find((tool) => tool.name === 'kia_lock_doors');
    const wait = (lock?.inputSchema as { properties: Record<string, { default?: unknown; description?: string }> })
      .properties.waitSeconds;
    expect(wait.default).toBe(30);
    expect(wait.description).toMatch(/default 30/);
    await harness.close();
  });

  it('passes a re-read function that digs out the nested vehicleStatus', async () => {
    const { client, spies } = makeClient();
    const harness = await harnessFor(client);
    await callConfirmed(harness, 'kia_lock_doors', {
      vinKey: VIN_KEY,
    });

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
    await callConfirmed(harness, name, { vinKey: VIN_KEY, });

    const predicate = spies.verifyCommand.mock.calls[0]?.[1] as (
      s: KiaVehicleStatus | null,
    ) => boolean;
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
    await callConfirmed(harness, name, { vinKey: VIN_KEY, });

    const predicate = spies.verifyCommand.mock.calls[0]?.[1] as (
      s: KiaVehicleStatus | null,
    ) => boolean;
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
      await callConfirmed(harness, 'kia_start_climate', {
        vinKey: VIN_KEY,
      }),
    );
    expect(payload.expected).toEqual({ 'climate.airCtrl': true });
    expect(payload.observed).toEqual({ 'climate.airCtrl': null, ign3: true });
    await harness.close();
  });

  it('forwards climate options to the client', async () => {
    const { client, spies } = makeClient();
    const harness = await harnessFor(client);
    await callConfirmed(harness, 'kia_start_climate', {
      vinKey: VIN_KEY,
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
    await callConfirmed(harness, 'kia_start_climate', {
      vinKey: VIN_KEY,
      temperature: 'HIGH',
    });
    expect(spies.startClimate.mock.calls[0]?.[1]).toMatchObject({
      airTempF: 'HIGH',
    });
    await harness.close();
  });

  it('never claims success when the state change was not observed', async () => {
    const { client, spies } = makeClient();
    spies.verifyCommand.mockResolvedValue(
      verification({
        verified: false,
        attempts: 12,
        snapshot: { doorLock: false },
        changedFields: [],
      }),
    );
    const harness = await harnessFor(client);
    const result = await callConfirmed(harness, 'kia_unlock_doors', {
      vinKey: VIN_KEY,
    });
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
    await callConfirmed(harness, 'kia_stop_climate', {
      vinKey: VIN_KEY,
      waitSeconds: 0,
    });
    expect((spies.verifyCommand.mock.calls[0]?.[2] as { timeoutMs: number }).timeoutMs).toBe(0);

    await callConfirmed(harness, 'kia_stop_climate', {
      vinKey: VIN_KEY,
      waitSeconds: 30,
    });
    expect((spies.verifyCommand.mock.calls[1]?.[2] as { timeoutMs: number }).timeoutMs).toBe(
      30_000,
    );
    await harness.close();
  });

  it('refuses to command a vehicle Kia does not return, before any mutation', async () => {
    const { client, spies } = makeClient();
    spies.getVehicleStatus.mockResolvedValue(null);
    const harness = await harnessFor(client);
    const result = await callConfirmed(harness, 'kia_lock_doors', {
      vinKey: 'FAKE-UNKNOWN-KEY',
    });

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
    const result = await callConfirmed(harness, 'kia_stop_climate', {
      vinKey: VIN_KEY,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('rems/stop');
    await harness.close();
  });
});

// ---------------------------------------------------------------------------
// Cancellation outside verifyCommand's poll loop
// ---------------------------------------------------------------------------

type ToolHandler = (args: Record<string, unknown>, ctx: unknown) => Promise<CallToolResult>;

/**
 * A request context whose caller declares no elicitation capability — the
 * direct-call equivalent of a harness created without an elicitation handler,
 * so the gate runs its two-phase token flow.
 */
const NO_ELICITATION_CTX = {
  mcpReq: { envelope: { 'io.modelcontextprotocol/clientCapabilities': {} } },
};

/**
 * Capture the registered handlers directly so a call can run inside an
 * ambient cancellation signal (`withCallSignal`) — through the harness, a
 * cancelled request never delivers its result back to the test.
 */
function captureHandlers(client: KiaCommandsClient): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const fakeServer = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  registerCommandsTools(fakeServer as unknown as Parameters<typeof registerCommandsTools>[0], client);
  return handlers;
}

function abortError(): Error {
  return Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
}

/**
 * Run phase 1 of the lock tool outside any signal, and return phase 2 — the
 * confirmed call carrying the token — for the test to run as it likes.
 */
async function confirmedLock(client: KiaCommandsClient): Promise<() => Promise<CallToolResult>> {
  const handler = captureHandlers(client).get('kia_lock_doors');
  if (handler === undefined) throw new Error('kia_lock_doors not registered');
  const args = { vinKey: VIN_KEY, waitSeconds: 30 };
  const phaseOne = parseToolResult<{ confirmToken: string }>(await handler(args, NO_ELICITATION_CTX));
  return () => handler({ ...args, confirmToken: phaseOne.confirmToken }, NO_ELICITATION_CTX);
}

/** Run the confirmed lock tool under a signal the test controls. */
async function lockUnder(
  controller: AbortController,
  client: KiaCommandsClient,
): Promise<Record<string, unknown>> {
  const phaseTwo = await confirmedLock(client);
  const result = await withCallSignal(controller.signal, phaseTwo);
  expect(result.isError).toBeFalsy();
  return parseToolResult<Record<string, unknown>>(result);
}

describe('cancellation outside the poll loop', () => {
  it('returns a not-sent result when cancelled during the baseline read', async () => {
    const { client, spies } = makeClient();
    const controller = new AbortController();
    spies.getVehicleStatus.mockImplementation(async () => {
      controller.abort();
      throw abortError();
    });
    const payload = await lockUnder(controller, client);

    expect(payload.cancelled).toBe(true);
    expect(payload.commandSent).toBe(false);
    expect(payload.stateConfirmed).toBe(false);
    expect(String(payload.note)).toMatch(/NOT sent/);
    expect(spies.lockDoors).not.toHaveBeenCalled();
    expect(spies.verifyCommand).not.toHaveBeenCalled();
  });

  it('does not fire the command when cancelled after the baseline read', async () => {
    const { client, spies } = makeClient();
    const controller = new AbortController();
    spies.getVehicleStatus.mockImplementation(async () => {
      controller.abort();
      return vehicleInfo({ doorLock: false });
    });
    const payload = await lockUnder(controller, client);

    expect(payload.cancelled).toBe(true);
    expect(payload.commandSent).toBe(false);
    expect(spies.lockDoors).not.toHaveBeenCalled();
    expect(spies.verifyCommand).not.toHaveBeenCalled();
  });

  it('reports an unknown send state when cancelled during the command request', async () => {
    const { client, spies } = makeClient();
    const controller = new AbortController();
    spies.lockDoors.mockImplementation(async () => {
      controller.abort();
      throw abortError();
    });
    const payload = await lockUnder(controller, client);

    expect(payload.cancelled).toBe(true);
    expect(payload.commandSent).toBe('unknown');
    expect(payload.stateConfirmed).toBe(false);
    expect(String(payload.note)).toMatch(/may have reached Kia/);
    expect(String(payload.note)).toMatch(/re-read the vehicle status/i);
    expect(spies.verifyCommand).not.toHaveBeenCalled();
  });

  it('keeps commandSent:true when cancellation lands during a verification re-read', async () => {
    const { client, spies } = makeClient();
    const controller = new AbortController();
    spies.verifyCommand.mockImplementation(async () => {
      controller.abort();
      throw abortError();
    });
    const payload = await lockUnder(controller, client);

    expect(payload.cancelled).toBe(true);
    expect(payload.commandSent).toBe(true);
    expect(payload.commandAccepted).toBe(true);
    expect(payload.xid).toBe(XID);
    expect(payload.stateConfirmed).toBe(false);
    expect(String(payload.note)).toMatch(/do not send it again/i);
  });

  it('still surfaces a failure that is not a cancellation as a tool error', async () => {
    const { client, spies } = makeClient();
    const controller = new AbortController();
    spies.lockDoors.mockRejectedValue(new Error('Kia API error on rems/door/lock: boom'));
    const phaseTwo = await confirmedLock(client);
    await expect(
      withCallSignal(controller.signal, phaseTwo),
    ).rejects.toThrow('rems/door/lock');
  });

  it('still surfaces a baseline-read failure that is not a cancellation', async () => {
    const { client, spies } = makeClient();
    const controller = new AbortController();
    spies.getVehicleStatus.mockRejectedValue(new Error('Kia API error on vehicle status: boom'));
    const phaseTwo = await confirmedLock(client);
    await expect(
      withCallSignal(controller.signal, phaseTwo),
    ).rejects.toThrow('vehicle status: boom');
    expect(controller.signal.aborted).toBe(false);
    expect(spies.lockDoors).not.toHaveBeenCalled();
  });

  it('still surfaces a verification failure that is not a cancellation', async () => {
    const { client, spies } = makeClient();
    const controller = new AbortController();
    spies.verifyCommand.mockRejectedValue(new Error('verification blew up'));
    const phaseTwo = await confirmedLock(client);
    await expect(
      withCallSignal(controller.signal, phaseTwo),
    ).rejects.toThrow('verification blew up');
    expect(controller.signal.aborted).toBe(false);
    expect(spies.lockDoors).toHaveBeenCalledTimes(1);
  });
});

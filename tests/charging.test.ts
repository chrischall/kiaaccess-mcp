import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import type { TestHarness } from '@chrischall/mcp-utils/test';
import type {
  KiaChargeTarget,
  KiaClient,
  KiaCommandResult,
  VerifyCommandOptions,
  VerifyCommandResult,
} from '../src/client.js';
import { diffIgnoringSyncDate } from '../src/client.js';
import { registerChargingTools } from '../src/tools/charging.js';

/**
 * The write-mode gate lives in ONE place (`src/tools/commands.ts`). Mocking it
 * here proves this registrar consults that shared helper rather than a private
 * copy of the same logic: a second copy of a control that decides whether a car
 * can be commanded would drift.
 */
const commandsMock = vi.hoisted(() => ({ getKiaWriteMode: vi.fn() }));

vi.mock('../src/tools/commands.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tools/commands.js')>();
  return { ...actual, getKiaWriteMode: commandsMock.getKiaWriteMode };
});

const { getKiaWriteMode: realGetKiaWriteMode } =
  await vi.importActual<typeof import('../src/tools/commands.js')>('../src/tools/commands.js');

// Obvious fakes only — never a real vehicle key.
const VIN_KEY = 'FAKE-VEHICLE-KEY';

const OK_STATUS = { statusCode: 0, errorType: 0, errorCode: 0, errorMessage: 'Success with response body' };

function commandResult(overrides: Partial<KiaCommandResult> & Pick<KiaCommandResult, 'command'>): KiaCommandResult {
  return {
    path: 'evc/unspecified',
    method: 'POST',
    verified: false,
    xid: 'FAKE-XID',
    raw: { status: OK_STATUS },
    ...overrides,
  };
}

/**
 * A stub `KiaClient`. `verifyCommand` is a faithful single-pass stand-in: it
 * really invokes the read function and the predicate the registrar builds, so
 * the verification logic under test is exercised rather than stubbed away.
 * Nothing here touches the network.
 */
function makeClient(targetReads: KiaChargeTarget[][] = []) {
  let readIndex = 0;
  const stub = {
    getChargeTargets: vi.fn(async (_vinKey: string): Promise<KiaChargeTarget[]> => {
      const next = targetReads[Math.min(readIndex, targetReads.length - 1)] ?? [];
      readIndex += 1;
      return next;
    }),
    startCharge: vi.fn(async (_vinKey: string, _chargeRatio?: number) =>
      commandResult({ command: 'charge', path: 'evc/charge', method: 'POST' }),
    ),
    cancelCharge: vi.fn(async (_vinKey: string) =>
      commandResult({ command: 'cancelCharge', path: 'evc/cancel', method: 'GET' }),
    ),
    setChargeTargets: vi.fn(async (_vinKey: string, _targets: KiaChargeTarget[]) =>
      commandResult({ command: 'setChargeTargets', path: 'evc/sts', method: 'POST' }),
    ),
    verifyCommand: vi.fn(
      async <T>(
        readFn: () => Promise<T>,
        predicate: (snapshot: T) => boolean,
        opts: VerifyCommandOptions<T> = {},
      ): Promise<VerifyCommandResult<T>> => {
        const snapshot = await readFn();
        return {
          verified: predicate(snapshot),
          attempts: 1,
          elapsedMs: 0,
          snapshot,
          changedFields: diffIgnoringSyncDate(opts.baseline, snapshot),
        };
      },
    ),
  };
  return stub;
}

type ClientStub = ReturnType<typeof makeClient>;

async function harnessFor(stub: ClientStub): Promise<TestHarness> {
  return createTestHarness((server) => {
    registerChargingTools(server, stub as unknown as KiaClient);
  });
}

/** Every client method that would issue a network call. */
function networkCallCount(stub: ClientStub): number {
  return (
    stub.getChargeTargets.mock.calls.length +
    stub.startCharge.mock.calls.length +
    stub.cancelCharge.mock.calls.length +
    stub.setChargeTargets.mock.calls.length +
    stub.verifyCommand.mock.calls.length
  );
}

let harness: TestHarness | undefined;

beforeEach(() => {
  delete process.env.KIA_WRITE_MODE;
  // Default to the real gate, so every other test still exercises it for real.
  commandsMock.getKiaWriteMode.mockImplementation(realGetKiaWriteMode);
});

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  delete process.env.KIA_WRITE_MODE;
  vi.restoreAllMocks();
});

describe('registerChargingTools — registration', () => {
  it('registers the read tool and all three write tools by default (comfort)', async () => {
    harness = await harnessFor(makeClient());
    const names = (await harness.listTools()).map((t) => t.name).sort();
    expect(names).toEqual([
      'kia_charge_targets',
      'kia_set_charge_limits',
      'kia_start_charge',
      'kia_stop_charge',
    ]);
  });

  it('registers the write tools under KIA_WRITE_MODE=all', async () => {
    process.env.KIA_WRITE_MODE = 'ALL';
    harness = await harnessFor(makeClient());
    const names = (await harness.listTools()).map((t) => t.name);
    expect(names).toContain('kia_start_charge');
    expect(names).toContain('kia_stop_charge');
    expect(names).toContain('kia_set_charge_limits');
  });

  it('registers only the read tool under KIA_WRITE_MODE=none', async () => {
    process.env.KIA_WRITE_MODE = 'none';
    harness = await harnessFor(makeClient());
    expect((await harness.listTools()).map((t) => t.name)).toEqual(['kia_charge_targets']);
  });

  it('fails closed to none on an unrecognized KIA_WRITE_MODE, warning on stderr', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.KIA_WRITE_MODE = 'comfrot';
    harness = await harnessFor(makeClient());
    expect((await harness.listTools()).map((t) => t.name)).toEqual(['kia_charge_targets']);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(/KIA_WRITE_MODE/);
  });

  it('reads the gate from the shared getKiaWriteMode helper, not a private copy', async () => {
    // The environment says "comfort" (the default); the shared helper says
    // "none". A private re-implementation would ignore the helper and register
    // the write tools anyway.
    commandsMock.getKiaWriteMode.mockReturnValue('none');
    harness = await harnessFor(makeClient());
    expect((await harness.listTools()).map((t) => t.name)).toEqual(['kia_charge_targets']);
    expect(commandsMock.getKiaWriteMode).toHaveBeenCalled();
  });

  it('tells the caller how to confirm each write, since a success status is not proof', async () => {
    harness = await harnessFor(makeClient());
    const { tools } = await harness.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.description ?? '']));

    for (const [name, endpoint] of [
      ['kia_start_charge', 'evc/charge'],
      ['kia_stop_charge', 'evc/cancel'],
      ['kia_set_charge_limits', 'evc/sts'],
    ] as const) {
      const description = byName.get(name) as string;
      // These endpoints are verified against a real vehicle, so the description
      // must NOT claim otherwise — but a success status still only means Kia
      // accepted the command, so each one has to name its confirmation path.
      expect(description).not.toMatch(/UNVERIFIED/i);
      expect(description).toMatch(/Verified against a|Verified against a real vehicle/);
      expect(description).toMatch(/kia_vehicle_status|evc\/gts|re-read/);
      expect(description).toContain(endpoint);
      expect(description).toMatch(/confirm/);
    }
    // The read endpoint WAS verified live — it must not carry the warning.
    expect(byName.get('kia_charge_targets')).not.toMatch(/UNVERIFIED/);
  });
});

describe('kia_charge_targets', () => {
  it('reads evc/gts and returns the per-plug-type targets', async () => {
    const stub = makeClient([[{ plugType: 0, targetSOClevel: 90 }]]);
    harness = await harnessFor(stub);

    const parsed = parseToolResult<{ vinKey: string; endpoint: string; targets: KiaChargeTarget[] }>(
      await harness.callTool('kia_charge_targets', { vinKey: VIN_KEY }),
    );

    expect(stub.getChargeTargets).toHaveBeenCalledExactlyOnceWith(VIN_KEY);
    expect(parsed.vinKey).toBe(VIN_KEY);
    expect(parsed.endpoint).toBe('evc/gts');
    expect(parsed.targets).toEqual([{ plugType: 0, targetSOClevel: 90 }]);
  });

  it('rejects a vinKey carrying control characters (header injection)', async () => {
    const stub = makeClient();
    harness = await harnessFor(stub);

    const result = await harness.callTool('kia_charge_targets', { vinKey: 'FAKE\r\nsid: x' });

    expect(result.isError).toBe(true);
    expect(networkCallCount(stub)).toBe(0);
  });
});

describe('kia_start_charge', () => {
  it('makes NO request and returns a dry-run preview without confirm', async () => {
    const stub = makeClient();
    harness = await harnessFor(stub);

    const parsed = parseToolResult<{
      dryRun: boolean;
      method: string;
      endpoint: string;
      willSend: unknown;
      endpointVerified: boolean;
    }>(await harness.callTool('kia_start_charge', { vinKey: VIN_KEY }));

    expect(networkCallCount(stub)).toBe(0);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.method).toBe('POST');
    expect(parsed.endpoint).toBe('evc/charge');
    expect(parsed.willSend).toEqual({ chargeRatio: 100 });
    expect(parsed.endpointVerified).toBe(false);
  });

  it('previews the caller-supplied chargeRatio', async () => {
    const stub = makeClient();
    harness = await harnessFor(stub);

    const parsed = parseToolResult<{ willSend: { chargeRatio: number } }>(
      await harness.callTool('kia_start_charge', { vinKey: VIN_KEY, chargeRatio: 80 }),
    );

    expect(parsed.willSend).toEqual({ chargeRatio: 80 });
    expect(networkCallCount(stub)).toBe(0);
  });

  it('issues the command with confirm:true and reports it as unverified', async () => {
    const stub = makeClient();
    harness = await harnessFor(stub);

    const parsed = parseToolResult<{
      command: string;
      endpointVerified: boolean;
      xid: string;
      verification: { attempted: boolean; reason: string };
    }>(await harness.callTool('kia_start_charge', { vinKey: VIN_KEY, chargeRatio: 80, confirm: true }));

    expect(stub.startCharge).toHaveBeenCalledExactlyOnceWith(VIN_KEY, 80);
    expect(parsed.command).toBe('charge');
    expect(parsed.endpointVerified).toBe(false);
    expect(parsed.xid).toBe('FAKE-XID');
    expect(parsed.verification.attempted).toBe(false);
    expect(parsed.verification.reason).toMatch(/evc\/gts/);
  });

  it('defaults chargeRatio to 100 when confirmed without one', async () => {
    const stub = makeClient();
    harness = await harnessFor(stub);

    await harness.callTool('kia_start_charge', { vinKey: VIN_KEY, confirm: true });

    expect(stub.startCharge).toHaveBeenCalledExactlyOnceWith(VIN_KEY, 100);
  });

  it('rejects a nonsensical chargeRatio before any request', async () => {
    const stub = makeClient();
    harness = await harnessFor(stub);

    const result = await harness.callTool('kia_start_charge', { vinKey: VIN_KEY, chargeRatio: 150, confirm: true });

    expect(result.isError).toBe(true);
    expect(networkCallCount(stub)).toBe(0);
  });
});

describe('kia_stop_charge', () => {
  it('makes NO request and returns a dry-run preview without confirm', async () => {
    const stub = makeClient();
    harness = await harnessFor(stub);

    const parsed = parseToolResult<{ dryRun: boolean; method: string; endpoint: string; willSend?: unknown }>(
      await harness.callTool('kia_stop_charge', { vinKey: VIN_KEY }),
    );

    expect(networkCallCount(stub)).toBe(0);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.method).toBe('GET');
    expect(parsed.endpoint).toBe('evc/cancel');
    // evc/cancel is a GET — there is no body to preview.
    expect(parsed.willSend).toBeUndefined();
  });

  it('issues the command with confirm:true', async () => {
    const stub = makeClient();
    harness = await harnessFor(stub);

    const parsed = parseToolResult<{ command: string; endpointVerified: boolean }>(
      await harness.callTool('kia_stop_charge', { vinKey: VIN_KEY, confirm: true }),
    );

    expect(stub.cancelCharge).toHaveBeenCalledExactlyOnceWith(VIN_KEY);
    expect(parsed.command).toBe('cancelCharge');
    expect(parsed.endpointVerified).toBe(false);
  });
});

describe('kia_set_charge_limits', () => {
  const targets = [{ plugType: 0, targetSOClevel: 80 }];

  it('makes NO request — not even the baseline read — without confirm', async () => {
    const stub = makeClient();
    harness = await harnessFor(stub);

    const parsed = parseToolResult<{ dryRun: boolean; endpoint: string; willSend: unknown }>(
      await harness.callTool('kia_set_charge_limits', { vinKey: VIN_KEY, targets }),
    );

    expect(networkCallCount(stub)).toBe(0);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.endpoint).toBe('evc/sts');
    expect(parsed.willSend).toEqual({ targetSOClist: targets });
  });

  it('sets the targets and verifies by re-reading evc/gts', async () => {
    // Baseline read, then the post-command read that proves the change.
    const stub = makeClient([[{ plugType: 0, targetSOClevel: 50 }], [{ plugType: 0, targetSOClevel: 80 }]]);
    harness = await harnessFor(stub);

    const parsed = parseToolResult<{
      command: string;
      verification: { attempted: boolean; verified: boolean; changedFields: string[]; targets: KiaChargeTarget[] };
    }>(await harness.callTool('kia_set_charge_limits', { vinKey: VIN_KEY, targets, confirm: true }));

    expect(stub.setChargeTargets).toHaveBeenCalledExactlyOnceWith(VIN_KEY, targets);
    expect(stub.getChargeTargets).toHaveBeenCalledTimes(2); // baseline + verification re-read
    expect(parsed.command).toBe('setChargeTargets');
    expect(parsed.verification.attempted).toBe(true);
    expect(parsed.verification.verified).toBe(true);
    expect(parsed.verification.changedFields).toEqual(['[0].targetSOClevel']);
    expect(parsed.verification.targets).toEqual([{ plugType: 0, targetSOClevel: 80 }]);
  });

  it('reports verified:false when the re-read does not show the requested target', async () => {
    const stub = makeClient([[{ plugType: 0, targetSOClevel: 50 }]]);
    harness = await harnessFor(stub);

    const parsed = parseToolResult<{ verification: { verified: boolean; hint: string } }>(
      await harness.callTool('kia_set_charge_limits', { vinKey: VIN_KEY, targets, confirm: true }),
    );

    expect(parsed.verification.verified).toBe(false);
    expect(parsed.verification.hint).toMatch(/does not report the requested targets/);
    expect(parsed.verification.hint).toMatch(/accepted the command|accepted the request/);
  });

  it('skips the baseline read and the re-read when verify:false', async () => {
    const stub = makeClient();
    harness = await harnessFor(stub);

    const parsed = parseToolResult<{ verification: { attempted: boolean; reason: string } }>(
      await harness.callTool('kia_set_charge_limits', { vinKey: VIN_KEY, targets, confirm: true, verify: false }),
    );

    expect(stub.getChargeTargets).not.toHaveBeenCalled();
    expect(stub.verifyCommand).not.toHaveBeenCalled();
    expect(stub.setChargeTargets).toHaveBeenCalledTimes(1);
    expect(parsed.verification.attempted).toBe(false);
    expect(parsed.verification.reason).toMatch(/verify/);
  });

  it('rejects duplicate plug types before any request, with an actionable hint', async () => {
    const stub = makeClient();
    harness = await harnessFor(stub);

    const result = await harness.callTool('kia_set_charge_limits', {
      vinKey: VIN_KEY,
      targets: [
        { plugType: 1, targetSOClevel: 80 },
        { plugType: 1, targetSOClevel: 90 },
      ],
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(networkCallCount(stub)).toBe(0);
    const text = JSON.stringify(result.content);
    expect(text).toMatch(/plugType/);
    expect(text).toMatch(/1/);
  });

  it('rejects an out-of-range targetSOClevel before any request', async () => {
    const stub = makeClient();
    harness = await harnessFor(stub);

    const result = await harness.callTool('kia_set_charge_limits', {
      vinKey: VIN_KEY,
      targets: [{ plugType: 0, targetSOClevel: 5 }],
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(networkCallCount(stub)).toBe(0);
  });

  it('rejects an empty targets list', async () => {
    const stub = makeClient();
    harness = await harnessFor(stub);

    const result = await harness.callTool('kia_set_charge_limits', { vinKey: VIN_KEY, targets: [], confirm: true });

    expect(result.isError).toBe(true);
    expect(networkCallCount(stub)).toBe(0);
  });
});

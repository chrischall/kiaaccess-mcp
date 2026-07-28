import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KiaCredentialError } from '../src/auth.js';
import {
  KiaClient,
  buildStartClimateBody,
  buildVehicleStatusBody,
  client as singletonClient,
  diffIgnoringSyncDate,
  extractVehicleStatus,
} from '../src/client.js';
import { KiaApiError, type FetchLike, type KiaRequestInit } from '../src/protocol.js';
import type { KiaSessionIO, KiaStoredSession } from '../src/session.js';

const DEVICE_ID = 'FAKE-DEVICE-0000-1111';
const VIN_KEY = 'FAKE-VEHICLE-KEY';
const RMTOKEN = 'fake-rmtoken';
const SID = 'fake-sid-1';

const OK = { statusCode: 0, errorType: 0, errorCode: 0, errorMessage: 'Success with response body' };

interface StubResponse {
  body: unknown;
  headers?: Record<string, string>;
  status?: number;
}

interface Recorded {
  url: string;
  init: KiaRequestInit;
}

/** Queue-backed fetch stub. Every test asserts against `calls`. */
function stubFetch(responses: StubResponse[]): { fetchImpl: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let index = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const spec = responses[index++];
    if (spec === undefined) throw new Error(`unexpected extra fetch to ${url}`);
    return {
      status: spec.status ?? 200,
      headers: new Headers(spec.headers ?? {}),
      text: async () => JSON.stringify(spec.body),
    } as unknown as Response;
  };
  return { fetchImpl, calls };
}

/** The `prof/authUser` refresh that mints a sid. */
const AUTH_OK: StubResponse = { headers: { sid: SID }, body: { status: OK } };

/** A session store that never touches disk. */
function memoryIO(initial: KiaStoredSession | null = null): KiaSessionIO & { saved: KiaStoredSession[] } {
  const saved: KiaStoredSession[] = [];
  let current = initial;
  return {
    saved,
    load: () => current,
    save: (session) => {
      saved.push(session);
      current = session;
    },
    clear: () => {
      current = null;
    },
  };
}

function makeClient(fetchImpl: FetchLike, overrides: Record<string, unknown> = {}): KiaClient {
  return new KiaClient({
    username: 'driver@example.test',
    password: 'fake-password',
    rmtoken: RMTOKEN,
    deviceId: DEVICE_ID,
    sessionIO: memoryIO(),
    fetchImpl,
    ...overrides,
  });
}

describe('deferred config error', () => {
  beforeEach(() => {
    delete process.env.KIA_USERNAME;
    delete process.env.KIA_PASSWORD;
  });

  it('constructs without credentials so the server still boots and answers tools/list', () => {
    expect(() => new KiaClient()).not.toThrow();
  });

  it('exports a module-level singleton for the stdio server', () => {
    expect(singletonClient).toBeInstanceOf(KiaClient);
  });

  it('does no I/O, randomness or timers at construction (Workers global scope forbids them)', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const uuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID');
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      new KiaClient();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(uuidSpy).not.toHaveBeenCalled();
      expect(timerSpy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('rethrows the config error at request time, without making a network call', async () => {
    const { fetchImpl, calls } = stubFetch([]);
    const client = new KiaClient({ deviceId: DEVICE_ID, sessionIO: memoryIO(), fetchImpl });
    await expect(client.listVehicles()).rejects.toThrow(/KIA_USERNAME/);
    await expect(client.listVehicles()).rejects.toThrow(/KIA_PASSWORD/);
    expect(calls).toHaveLength(0);
  });

  it('names only the credential that is actually missing', async () => {
    process.env.KIA_USERNAME = 'driver@example.test';
    const { fetchImpl } = stubFetch([]);
    const client = new KiaClient({ deviceId: DEVICE_ID, sessionIO: memoryIO(), fetchImpl });
    const err = await client.listVehicles().catch((e: unknown) => e as Error);
    expect(err.message).toContain('KIA_PASSWORD');
    expect(err.message).not.toContain('KIA_USERNAME');
  });

  it('reads credentials from the environment when none are injected', async () => {
    process.env.KIA_USERNAME = 'driver@example.test';
    process.env.KIA_PASSWORD = 'fake-password';
    const { fetchImpl, calls } = stubFetch([
      AUTH_OK,
      { body: { status: OK, payload: { vehicleSummary: [] } } },
    ]);
    const client = new KiaClient({ rmtoken: RMTOKEN, deviceId: DEVICE_ID, sessionIO: memoryIO(), fetchImpl });
    await client.listVehicles();
    expect(JSON.parse(calls[0].init.body!).userCredential.userId).toBe('driver@example.test');
  });

  it('reports whether it is configured without throwing', () => {
    expect(new KiaClient({ deviceId: DEVICE_ID, sessionIO: memoryIO() }).isConfigured()).toBe(false);
    expect(
      new KiaClient({ username: 'driver@example.test', password: 'fake-password', deviceId: DEVICE_ID, sessionIO: memoryIO() })
        .isConfigured(),
    ).toBe(true);
  });
});

describe('sid minting', () => {
  beforeEach(() => {
    process.env.KIA_USERNAME = 'driver@example.test';
    process.env.KIA_PASSWORD = 'fake-password';
  });

  afterEach(() => {
    delete process.env.KIA_USERNAME;
    delete process.env.KIA_PASSWORD;
  });

  it('mints a sid from the rmtoken before the first read, then reuses it', async () => {
    const { fetchImpl, calls } = stubFetch([
      AUTH_OK,
      { body: { status: OK, payload: { vehicleSummary: [{ vehicleKey: VIN_KEY, vin: 'FAKEVIN' }] } } },
      { body: { status: OK, payload: { vehicleSummary: [] } } },
    ]);
    const client = makeClient(fetchImpl);

    const vehicles = await client.listVehicles();
    await client.listVehicles();

    expect(vehicles).toEqual([{ vehicleKey: VIN_KEY, vin: 'FAKEVIN' }]);
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.owners.kia.com/apigw/v1/prof/authUser',
      'https://api.owners.kia.com/apigw/v1/ownr/gvl',
      'https://api.owners.kia.com/apigw/v1/ownr/gvl',
    ]);
    expect(calls[1].init.headers.sid).toBe(SID);
    expect(calls[1].init.headers.date).toMatch(/GMT$/);
  });

  it('coalesces a concurrent burst onto ONE refresh', async () => {
    const { fetchImpl, calls } = stubFetch([
      AUTH_OK,
      { body: { status: OK, payload: { vehicleSummary: [] } } },
      { body: { status: OK, payload: { vehicleSummary: [] } } },
      { body: { status: OK, payload: { vehicleSummary: [] } } },
    ]);
    const client = makeClient(fetchImpl);

    await Promise.all([client.listVehicles(), client.listVehicles(), client.listVehicles()]);

    expect(calls.filter((c) => c.url.endsWith('prof/authUser'))).toHaveLength(1);
  });

  it('loads the rmtoken from the session store when none is injected', async () => {
    const io = memoryIO({
      accountId: 'driver@example.test',
      rmtoken: 'fake-rmtoken-from-disk',
      deviceId: DEVICE_ID,
      updatedAt: '2026-07-27T19:00:00.000Z',
    });
    const { fetchImpl, calls } = stubFetch([AUTH_OK, { body: { status: OK, payload: { vehicleSummary: [] } } }]);
    const client = makeClient(fetchImpl, { rmtoken: undefined, sessionIO: io });

    await client.listVehicles();

    expect(calls[0].init.headers.rmtoken).toBe('fake-rmtoken-from-disk');
  });

  it('asks for the MFA bootstrap when there is no rmtoken anywhere', async () => {
    const { fetchImpl, calls } = stubFetch([]);
    const client = makeClient(fetchImpl, { rmtoken: undefined });
    await expect(client.listVehicles()).rejects.toThrow(/one-time|bootstrap/i);
    expect(calls).toHaveLength(0);
  });

  it('never retries a credential rejection (that would escalate to reCAPTCHA)', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        body: {
          status: { statusCode: 1, errorCode: 1001, errorMessage: 'Invalid Email or Password' },
          payload: { loginAttempt: 1 },
        },
      },
    ]);
    const client = makeClient(fetchImpl);

    await expect(client.listVehicles()).rejects.toBeInstanceOf(KiaCredentialError);
    expect(calls).toHaveLength(1);
  });

  it('re-mints and replays exactly once when a call reports an expired session', async () => {
    const { fetchImpl, calls } = stubFetch([
      AUTH_OK,
      { body: { status: { statusCode: 1, errorCode: 5001, errorMessage: 'Session Key is either invalid or expired' } } },
      { headers: { sid: 'fake-sid-2' }, body: { status: OK } },
      { body: { status: OK, payload: { vehicleSummary: [] } } },
    ]);
    const client = makeClient(fetchImpl);

    await expect(client.listVehicles()).resolves.toEqual([]);
    expect(calls.map((c) => c.url.split('/v1/')[1])).toEqual([
      'prof/authUser',
      'ownr/gvl',
      'prof/authUser',
      'ownr/gvl',
    ]);
    expect(calls[3].init.headers.sid).toBe('fake-sid-2');
  });

  it('persists a rotated rmtoken but leaves an unrotated one alone', async () => {
    const io = memoryIO();
    const { fetchImpl } = stubFetch([
      { headers: { sid: SID, rmtoken: 'fake-rmtoken-2' }, body: { status: OK } },
      { body: { status: OK, payload: { vehicleSummary: [] } } },
    ]);
    const client = makeClient(fetchImpl, { sessionIO: io });

    await client.listVehicles();

    expect(io.saved).toHaveLength(1);
    expect(io.saved[0].rmtoken).toBe('fake-rmtoken-2');
  });

  it('does not rewrite the store when the rmtoken is unchanged', async () => {
    const io = memoryIO();
    const { fetchImpl } = stubFetch([AUTH_OK, { body: { status: OK, payload: { vehicleSummary: [] } } }]);
    await makeClient(fetchImpl, { sessionIO: io }).listVehicles();
    expect(io.saved).toHaveLength(0);
  });

  it('uses the global fetch when none is injected', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        ({
          status: 200,
          headers: new Headers({ sid: SID }),
          text: async () => JSON.stringify({ status: OK, payload: { vehicleSummary: [] } }),
        }) as unknown as Response,
    );
    try {
      const client = new KiaClient({
        username: 'driver@example.test',
        password: 'fake-password',
        rmtoken: RMTOKEN,
        deviceId: DEVICE_ID,
        sessionIO: memoryIO(),
      });
      await expect(client.listVehicles()).resolves.toEqual([]);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('reads', () => {
  beforeEach(() => {
    process.env.KIA_USERNAME = 'driver@example.test';
    process.env.KIA_PASSWORD = 'fake-password';
  });

  afterEach(() => {
    delete process.env.KIA_USERNAME;
    delete process.env.KIA_PASSWORD;
  });

  it('requests cmm/gvi with the climate-bearing config flags and the vinkey header', async () => {
    const info = { vinKey: VIN_KEY, lastVehicleInfo: { vehicleStatusRpt: { vehicleStatus: { doorLock: true } } } };
    const { fetchImpl, calls } = stubFetch([AUTH_OK, { body: { status: OK, payload: { vehicleInfoList: [info] } } }]);
    const client = makeClient(fetchImpl);

    await expect(client.getVehicleStatus(VIN_KEY)).resolves.toEqual(info);

    expect(calls[1].url).toBe('https://api.owners.kia.com/apigw/v1/cmm/gvi');
    expect(calls[1].init.headers.vinkey).toBe(VIN_KEY);
    const body = JSON.parse(calls[1].init.body!);
    // Climate is ABSENT unless these two flags are "1".
    expect(body.vehicleConfigReq.airTempRange).toBe('1');
    expect(body.vehicleConfigReq.seatHeatCoolOption).toBe('1');
    // The API itself misspells this key; correcting it silently drops the field.
    expect(body.vehicleInfoReq).toHaveProperty('drivingActivty');
    expect(body.vinKey).toEqual([VIN_KEY]);
  });

  it('can ask for the lighter payload without the climate block', () => {
    const body = buildVehicleStatusBody(VIN_KEY, { includeClimate: false }) as {
      vehicleConfigReq: Record<string, string>;
    };
    expect(body.vehicleConfigReq.airTempRange).toBe('0');
    expect(body.vehicleConfigReq.seatHeatCoolOption).toBe('0');
  });

  it('returns null when cmm/gvi reports no vehicle', async () => {
    const { fetchImpl } = stubFetch([AUTH_OK, { body: { status: OK, payload: {} } }]);
    await expect(makeClient(fetchImpl).getVehicleStatus(VIN_KEY)).resolves.toBeNull();
  });

  it('returns an empty vehicle list when the payload is missing', async () => {
    const { fetchImpl } = stubFetch([AUTH_OK, { body: { status: OK } }]);
    await expect(makeClient(fetchImpl).listVehicles()).resolves.toEqual([]);
  });

  it('forces a fresh read from the vehicle with rems/rvs', async () => {
    const { fetchImpl, calls } = stubFetch([AUTH_OK, { body: { status: OK, payload: {} } }]);
    await makeClient(fetchImpl).forceVehicleRefresh(VIN_KEY);
    expect(calls[1].url).toBe('https://api.owners.kia.com/apigw/v1/rems/rvs');
    expect(JSON.parse(calls[1].init.body!)).toEqual({ requestType: 0 });
  });

  it('reads EV charge targets', async () => {
    const targets = [{ plugType: 0, targetSOClevel: 80 }];
    const { fetchImpl, calls } = stubFetch([AUTH_OK, { body: { status: OK, payload: { targetSOClist: targets } } }]);
    await expect(makeClient(fetchImpl).getChargeTargets(VIN_KEY)).resolves.toEqual(targets);
    expect(calls[1].init.method).toBe('GET');
    expect(calls[1].url).toBe('https://api.owners.kia.com/apigw/v1/evc/gts');
  });

  it('returns an empty target list when the payload is missing', async () => {
    const { fetchImpl } = stubFetch([AUTH_OK, { body: { status: OK, payload: {} } }]);
    await expect(makeClient(fetchImpl).getChargeTargets(VIN_KEY)).resolves.toEqual([]);
  });

  it('rejects a body that is not a Kia envelope rather than treating it as expired', async () => {
    const { fetchImpl, calls } = stubFetch([AUTH_OK, { body: { nope: true } }]);
    await expect(makeClient(fetchImpl).listVehicles()).rejects.toThrow(/unrecognized/i);
    // No session-expiry replay: an unrecognized body is not an expired session.
    expect(calls).toHaveLength(2);
  });

  it('throws on a non-zero statusCode even though HTTP was 200', async () => {
    const { fetchImpl } = stubFetch([
      AUTH_OK,
      {
        status: 200,
        body: { status: { statusCode: 1, errorType: 3, errorCode: 9200, errorMessage: 'Missing mandatory data in header' } },
      },
    ]);
    const err = await makeClient(fetchImpl)
      .listVehicles()
      .catch((e: unknown) => e as KiaApiError);
    expect(err).toBeInstanceOf(KiaApiError);
    expect(err.errorCode).toBe(9200);
  });
});

describe('commands', () => {
  beforeEach(() => {
    process.env.KIA_USERNAME = 'driver@example.test';
    process.env.KIA_PASSWORD = 'fake-password';
  });

  afterEach(() => {
    delete process.env.KIA_USERNAME;
    delete process.env.KIA_PASSWORD;
  });

  it('locks the doors and returns the Xid response header, never polling cmm/gts', async () => {
    const { fetchImpl, calls } = stubFetch([AUTH_OK, { headers: { Xid: 'fake-action-xid' }, body: { status: OK } }]);

    const result = await makeClient(fetchImpl).lockDoors(VIN_KEY);

    expect(result.xid).toBe('fake-action-xid');
    expect(result.raw.status.statusCode).toBe(0);
    expect(result.verified).toBe(true);
    expect(calls[1].init.method).toBe('GET');
    expect(calls[1].url).toBe('https://api.owners.kia.com/apigw/v1/rems/door/lock');
    expect(calls[1].init.headers.vinkey).toBe(VIN_KEY);
    // cmm/gts is NOT a per-action poll — a client that waits on it waits forever.
    expect(calls.some((c) => c.url.includes('cmm/gts'))).toBe(false);
  });

  it('reports a null xid when the header is absent', async () => {
    const { fetchImpl } = stubFetch([AUTH_OK, { body: { status: OK } }]);
    await expect(makeClient(fetchImpl).unlockDoors(VIN_KEY)).resolves.toMatchObject({
      xid: null,
      path: 'rems/door/unlock',
    });
  });

  it('starts climate with the verified body shape', async () => {
    const { fetchImpl, calls } = stubFetch([AUTH_OK, { body: { status: OK } }]);

    await makeClient(fetchImpl).startClimate(VIN_KEY, { airTempF: 72, defrost: true, durationMinutes: 10 });

    expect(calls[1].init.method).toBe('POST');
    expect(calls[1].url).toBe('https://api.owners.kia.com/apigw/v1/rems/start');
    expect(JSON.parse(calls[1].init.body!)).toEqual({
      remoteClimate: {
        airTemp: { unit: 1, value: '72' },
        airCtrl: true,
        defrost: true,
        heatingAccessory: { rearWindow: 0, sideMirror: 0, steeringWheel: 0, steeringWheelStep: 0 },
        ignitionOnDuration: { unit: 4, value: 10 },
      },
    });
  });

  it('defaults the climate body to the live-verified values', () => {
    expect(buildStartClimateBody()).toEqual({
      remoteClimate: {
        airTemp: { unit: 1, value: '70' },
        airCtrl: true,
        defrost: false,
        heatingAccessory: { rearWindow: 0, sideMirror: 0, steeringWheel: 0, steeringWheelStep: 0 },
        ignitionOnDuration: { unit: 4, value: 5 },
      },
    });
  });

  it('stops climate with a GET', async () => {
    const { fetchImpl, calls } = stubFetch([AUTH_OK, { body: { status: OK } }]);
    await makeClient(fetchImpl).stopClimate(VIN_KEY);
    expect(calls[1].init.method).toBe('GET');
    expect(calls[1].url).toBe('https://api.owners.kia.com/apigw/v1/rems/stop');
  });

  it('flags the EV charge commands as unverified', async () => {
    const { fetchImpl, calls } = stubFetch([
      AUTH_OK,
      { body: { status: OK } },
      { body: { status: OK } },
      { body: { status: OK } },
    ]);
    const client = makeClient(fetchImpl);

    expect((await client.startCharge(VIN_KEY, 80)).verified).toBe(false);
    expect((await client.cancelCharge(VIN_KEY)).verified).toBe(false);
    expect((await client.setChargeTargets(VIN_KEY, [{ plugType: 1, targetSOClevel: 90 }])).verified).toBe(false);

    expect(JSON.parse(calls[1].init.body!)).toEqual({ chargeRatio: 80 });
    expect(calls[2].init.method).toBe('GET');
    expect(JSON.parse(calls[3].init.body!)).toEqual({ targetSOClist: [{ plugType: 1, targetSOClevel: 90 }] });
  });

  it('defaults the charge ratio to 100', async () => {
    const { fetchImpl, calls } = stubFetch([AUTH_OK, { body: { status: OK } }]);
    await makeClient(fetchImpl).startCharge(VIN_KEY);
    expect(JSON.parse(calls[1].init.body!)).toEqual({ chargeRatio: 100 });
  });
});

describe('diffIgnoringSyncDate', () => {
  it('ignores syncDate at any depth (it advances on EVERY read)', () => {
    const before = { syncDate: { utc: 1 }, vehicleStatus: { syncDate: 111, doorLock: true } };
    const after = { syncDate: { utc: 2 }, vehicleStatus: { syncDate: 222, doorLock: true } };
    expect(diffIgnoringSyncDate(before, after)).toEqual([]);
  });

  it('reports the real change with a dotted path', () => {
    const before = { vehicleStatus: { doorLock: true, climate: { airCtrl: false }, syncDate: 1 } };
    const after = { vehicleStatus: { doorLock: false, climate: { airCtrl: true }, syncDate: 2 } };
    expect(diffIgnoringSyncDate(before, after).sort()).toEqual(['vehicleStatus.climate.airCtrl', 'vehicleStatus.doorLock']);
  });

  it('reports appearing and disappearing keys', () => {
    expect(diffIgnoringSyncDate({ a: 1 }, { a: 1, b: 2 })).toEqual(['b']);
    expect(diffIgnoringSyncDate({ a: 1, b: 2 }, { a: 1 })).toEqual(['b']);
  });

  it('handles arrays element-wise and by length', () => {
    expect(diffIgnoringSyncDate({ a: [1, 2] }, { a: [1, 3] })).toEqual(['a[1]']);
    expect(diffIgnoringSyncDate({ a: [1] }, { a: [1, 2] })).toEqual(['a']);
    expect(diffIgnoringSyncDate({ a: [{ syncDate: 1, v: 2 }] }, { a: [{ syncDate: 9, v: 2 }] })).toEqual([]);
  });

  it('labels a changed scalar root', () => {
    expect(diffIgnoringSyncDate(1, 2)).toEqual(['(root)']);
    expect(diffIgnoringSyncDate(null, { a: 1 })).toEqual(['(root)']);
    expect(diffIgnoringSyncDate(null, null)).toEqual([]);
  });
});

describe('extractVehicleStatus', () => {
  it('digs the nested vehicleStatus out of a cmm/gvi record', () => {
    const status = { doorLock: true, climate: { airCtrl: false } };
    expect(extractVehicleStatus({ vinKey: VIN_KEY, lastVehicleInfo: { vehicleStatusRpt: { vehicleStatus: status } } })).toEqual(
      status,
    );
  });

  it('returns null for a missing or partial record', () => {
    expect(extractVehicleStatus(null)).toBeNull();
    expect(extractVehicleStatus({ vinKey: VIN_KEY })).toBeNull();
    expect(extractVehicleStatus({ vinKey: VIN_KEY, lastVehicleInfo: {} })).toBeNull();
  });
});

describe('verifyCommand', () => {
  const client = new KiaClient({ deviceId: DEVICE_ID, sessionIO: memoryIO() });

  it('re-reads until the predicate holds and reports the changed fields', async () => {
    const baseline = { doorLock: false, syncDate: 1 };
    const snapshots = [
      { doorLock: false, syncDate: 2 },
      { doorLock: true, syncDate: 3 },
    ];
    let index = 0;
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await client.verifyCommand(
      async () => snapshots[index++],
      (snapshot) => snapshot.doorLock === true,
      { baseline, timeoutMs: 30_000, intervalMs: 5_000, sleep, now: () => 0 },
    );

    expect(result.verified).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.changedFields).toEqual(['doorLock']);
    expect(result.snapshot).toEqual({ doorLock: true, syncDate: 3 });
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it('EXCLUDES syncDate from change detection (including it makes every command look successful)', async () => {
    const baseline = { doorLock: false, syncDate: '2026-07-27T19:00:00Z' };
    const after = { doorLock: false, syncDate: '2026-07-27T19:05:00Z' };

    const result = await client.verifyCommand(async () => after, () => false, {
      baseline,
      timeoutMs: 0,
      sleep: async () => {},
    });

    expect(result.verified).toBe(false);
    expect(result.changedFields).toEqual([]);
  });

  it('gives up after the timeout instead of polling forever', async () => {
    let clock = 0;
    const sleep = vi.fn().mockImplementation(async () => {
      clock += 5_000;
    });
    const read = vi.fn().mockResolvedValue({ doorLock: false });

    const result = await client.verifyCommand(read, () => false, {
      timeoutMs: 12_000,
      intervalMs: 5_000,
      sleep,
      now: () => clock,
    });

    expect(result.verified).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.elapsedMs).toBe(10_000);
  });

  it('verifies on the very first read without sleeping', async () => {
    const sleep = vi.fn();
    const result = await client.verifyCommand(async () => ({ doorLock: true }), (s) => s.doorLock, { sleep });
    expect(result.verified).toBe(true);
    expect(result.attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('diffs against the first read when no baseline is supplied', async () => {
    const snapshots = [{ ign3: false }, { ign3: true }];
    let index = 0;
    const result = await client.verifyCommand(async () => snapshots[index++], (s) => s.ign3, {
      intervalMs: 1,
      timeoutMs: 5_000,
      now: () => 0,
    });
    expect(result.changedFields).toEqual(['ign3']);
  });
});

describe('MFA bootstrap through the client', () => {
  beforeEach(() => {
    process.env.KIA_USERNAME = 'driver@example.test';
    process.env.KIA_PASSWORD = 'fake-password';
  });

  afterEach(() => {
    delete process.env.KIA_USERNAME;
    delete process.env.KIA_PASSWORD;
  });

  it('runs the three steps and persists the rmtoken without ever returning it', async () => {
    const io = memoryIO();
    const { fetchImpl, calls } = stubFetch([
      { headers: { xid: 'fake-xid' }, body: { status: OK, payload: { otpKey: 'fake-otp-key', nextAction: 'MFA_REQUIRED' } } },
      { body: { status: OK, payload: { message: 'OTP sent successfully' } } },
      { headers: { sid: SID, rmtoken: 'fake-rmtoken-new' }, body: { status: OK } },
    ]);
    const client = makeClient(fetchImpl, { rmtoken: undefined, sessionIO: io });

    const started = await client.beginLogin();
    expect(started.otpKey).toBe('fake-otp-key');
    expect(started.xid).toBe('fake-xid');

    await client.sendLoginOtp({ otpKey: started.otpKey, xid: started.xid, notifyType: 'SMS' });

    const completed = await client.completeLogin({ otpKey: started.otpKey, xid: started.xid, otp: '000000' });

    expect(completed).toEqual({ accountId: 'driver@example.test', deviceId: DEVICE_ID, persisted: true });
    expect(JSON.stringify(completed)).not.toContain('fake-rmtoken-new');
    expect(io.saved).toHaveLength(1);
    expect(io.saved[0]).toMatchObject({ accountId: 'driver@example.test', rmtoken: 'fake-rmtoken-new', deviceId: DEVICE_ID });
    expect(client.exportRmToken()).toBe('fake-rmtoken-new');
    expect(calls.map((c) => c.url.split('/v1/')[1])).toEqual(['prof/authUser', 'cmm/sendOTP', 'cmm/verifyOTP']);
  });

  it('mints the next sid from the freshly bootstrapped rmtoken', async () => {
    const { fetchImpl, calls } = stubFetch([
      { headers: { sid: SID, rmtoken: 'fake-rmtoken-new' }, body: { status: OK } },
      AUTH_OK,
      { body: { status: OK, payload: { vehicleSummary: [] } } },
    ]);
    const client = makeClient(fetchImpl, { rmtoken: undefined });

    await client.completeLogin({ otpKey: 'fake-otp-key', xid: 'fake-xid', otp: '000000' });
    await client.listVehicles();

    expect(calls[1].init.headers.rmtoken).toBe('fake-rmtoken-new');
  });

  it('reports whether a stored session exists and can forget it', async () => {
    const io = memoryIO({
      accountId: 'driver@example.test',
      rmtoken: RMTOKEN,
      deviceId: DEVICE_ID,
      updatedAt: '2026-07-27T19:00:00.000Z',
    });
    const { fetchImpl } = stubFetch([]);
    const client = makeClient(fetchImpl, { rmtoken: undefined, sessionIO: io });

    expect(client.hasSession()).toBe(true);
    client.forgetSession();
    expect(client.hasSession()).toBe(false);
    expect(client.exportRmToken()).toBeNull();
  });

  it('reports no session for an unconfigured client instead of throwing', () => {
    delete process.env.KIA_USERNAME;
    delete process.env.KIA_PASSWORD;
    const client = new KiaClient({ deviceId: DEVICE_ID, sessionIO: memoryIO() });
    expect(client.hasSession()).toBe(false);
    expect(client.exportRmToken()).toBeNull();
    expect(() => client.forgetSession()).not.toThrow();
    expect(client.describeConfig()).toEqual({
      accountId: null,
      deviceId: DEVICE_ID,
      configured: false,
      hasSession: false,
    });
  });

  it('exposes the resolved device id for diagnostics', () => {
    expect(makeClient(stubFetch([]).fetchImpl).describeConfig()).toEqual({
      accountId: 'driver@example.test',
      deviceId: DEVICE_ID,
      configured: true,
      hasSession: true,
    });
  });

  it('falls back to the resolved (env / persisted) device id when none is injected', () => {
    process.env.KIA_DEVICE_ID = 'ENV-DEVICE-ID';
    try {
      const client = new KiaClient({ username: 'driver@example.test', password: 'fake', sessionIO: memoryIO() });
      expect(client.describeConfig().deviceId).toBe('ENV-DEVICE-ID');
    } finally {
      delete process.env.KIA_DEVICE_ID;
    }
  });
});

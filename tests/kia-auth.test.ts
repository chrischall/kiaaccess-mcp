/**
 * The hosted connector's login (`src/kia-auth.ts`).
 *
 * This file is deliberately in the NODE pool, not the Workers one: `kia-auth.ts`
 * imports only the TYPE of `ConnectorAuth`, so nothing at runtime pulls in
 * `agents/mcp` or `cloudflare:workers` and the module loads anywhere. Keeping it
 * here means the login path — the single place a user's Kia password is
 * verified — is covered by the same 100%-threshold suite as the rest of `src/`.
 *
 * Everything is fake: fake emails, fake passwords, fake tokens. No test in this
 * file may reach the real Kia API — every `login()` call runs against a stubbed
 * global `fetch`, and a real credential rejection would increment Kia's
 * `loginAttempt` counter on someone's account.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHostedKiaClient, hostedDeviceId, kiaAuth } from '../src/kia-auth.js';
import { BASE_URL, ENDPOINTS } from '../src/protocol.js';

const OK = { statusCode: 0, errorType: 0, errorCode: 0, errorMessage: 'Success with response body' };
const FAIL = { statusCode: 1, errorType: 1, errorCode: 1001, errorMessage: 'Invalid Email or Password' };

const GOOD_FIELDS = {
  username: 'Driver@Example.test',
  password: 'fake-password',
  rmtoken: 'fake-rmtoken',
};

interface StubResponse {
  body: unknown;
  headers?: Record<string, string>;
}

/** Replace the global `fetch` with a queue of canned Kia responses. */
function stubGlobalFetch(responses: StubResponse[]): { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  let index = 0;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const spec = responses[index++];
    if (spec === undefined) throw new Error(`unexpected extra fetch to ${url}`);
    return {
      status: 200,
      headers: new Headers(spec.headers ?? {}),
      text: async () => JSON.stringify(spec.body),
    } as unknown as Response;
  });
  return { calls };
}

/** The two calls a successful `login()` makes: refresh a sid, then read gvl. */
const LOGIN_OK: StubResponse[] = [
  { headers: { sid: 'fake-sid' }, body: { status: OK } },
  { body: { status: OK, payload: { vehicleSummary: [] } } },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hostedDeviceId', () => {
  it('is deterministic — the same account always yields the same device id', () => {
    expect(hostedDeviceId('driver@example.test')).toBe(hostedDeviceId('driver@example.test'));
  });

  it('normalises case and surrounding whitespace, because the account id does', () => {
    // `KiaClient` lowercases/trims the username before using it as the account
    // key; a device id that did not would flip on a differently-typed login.
    expect(hostedDeviceId('  Driver@Example.test ')).toBe(hostedDeviceId('driver@example.test'));
  });

  it('differs between accounts', () => {
    expect(hostedDeviceId('a@example.test')).not.toBe(hostedDeviceId('b@example.test'));
  });

  it('is shaped like the v4 uuid Kia’s iOS client sends', () => {
    expect(hostedDeviceId('driver@example.test')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('uses no randomness — a second isolate would derive the identical value', () => {
    const random = vi.spyOn(globalThis.Math, 'random');
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID');
    hostedDeviceId('driver@example.test');
    expect(random).not.toHaveBeenCalled();
    expect(uuid).not.toHaveBeenCalled();
  });
});

describe('buildHostedKiaClient', () => {
  it('configures the client from the props, with the derived device id', () => {
    const client = buildHostedKiaClient({ ...GOOD_FIELDS });
    const config = client.describeConfig();
    expect(config.configured).toBe(true);
    expect(config.accountId).toBe('driver@example.test');
    expect(config.deviceId).toBe(hostedDeviceId(GOOD_FIELDS.username));
    // The rmtoken came from the props, so the hosted session is live with no
    // MFA bootstrap and no filesystem read.
    expect(config.hasSession).toBe(true);
  });

  it('ignores KIA_USERNAME/KIA_PASSWORD — one isolate serves many users', () => {
    vi.stubEnv('KIA_USERNAME', 'someone-else@example.test');
    vi.stubEnv('KIA_PASSWORD', 'not-this-one');
    const client = buildHostedKiaClient({ ...GOOD_FIELDS });
    expect(client.describeConfig().accountId).toBe('driver@example.test');
    vi.unstubAllEnvs();
  });

  it('persists nothing — the Worker has no filesystem', () => {
    // `nullSessionIO` is what makes this safe; exporting the token back out is
    // a pure read of what was passed in, never a disk read.
    const client = buildHostedKiaClient({ ...GOOD_FIELDS });
    expect(client.exportRmToken()).toBe('fake-rmtoken');
    expect(() => client.forgetSession()).not.toThrow();
  });
});

describe('kiaAuth — form definition', () => {
  it('collects exactly the three fields a silent refresh needs', () => {
    expect(kiaAuth.fields.map((field) => field.name)).toEqual(['username', 'password', 'rmtoken']);
  });

  it('masks both secrets on the login page', () => {
    const secret = kiaAuth.fields.filter((field) => field.type === 'password').map((field) => field.name);
    expect(secret).toEqual(['password', 'rmtoken']);
  });

  it('states honestly that all three values are stored, and why', () => {
    // The password is NOT a one-time check: Kia's refresh sends the full
    // credential body alongside the rmtoken. Saying otherwise would be a lie
    // shown to the user at the moment they consent.
    expect(kiaAuth.privacyNote).toMatch(/stored encrypted/i);
    expect(kiaAuth.privacyNote).toMatch(/password/i);
    expect(kiaAuth.privacyNote).toMatch(/token/i);
    expect(kiaAuth.privacyNote).toMatch(/every session renewal/i);
  });
});

describe('kiaAuth.login — verification', () => {
  it('really refreshes the session and reads the vehicle list before accepting', async () => {
    const { calls } = stubGlobalFetch(LOGIN_OK);

    const props = await kiaAuth.login({ ...GOOD_FIELDS }, {});

    expect(calls).toHaveLength(2);
    // 1. prof/authUser with the pasted rmtoken — the real proof it works.
    expect(calls[0].url).toBe(`${BASE_URL}${ENDPOINTS.authUser}`);
    expect((calls[0].init.headers as Record<string, string>).rmtoken).toBe('fake-rmtoken');
    // 2. the cheap read, under the sid that refresh produced.
    expect(calls[1].url).toBe(`${BASE_URL}${ENDPOINTS.vehicleList}`);
    expect((calls[1].init.headers as Record<string, string>).sid).toBe('fake-sid');

    expect(props).toEqual({ username: 'Driver@Example.test', password: 'fake-password', rmtoken: 'fake-rmtoken' });
  });

  it('trims the pasted email and token — a copy/paste picks up whitespace', async () => {
    stubGlobalFetch(LOGIN_OK);
    const props = await kiaAuth.login(
      { username: '  driver@example.test\n', password: 'fake-password', rmtoken: ' fake-rmtoken ' },
      {},
    );
    expect(props.username).toBe('driver@example.test');
    expect(props.rmtoken).toBe('fake-rmtoken');
  });

  it('rejects a bad token/password with a message that names all three inputs', async () => {
    stubGlobalFetch([{ body: { status: FAIL } }]);
    await expect(kiaAuth.login({ ...GOOD_FIELDS }, {})).rejects.toThrow(/Could not connect to Kia/);
    await expect(
      kiaAuth.login({ ...GOOD_FIELDS }, {}).catch((err: Error) => err.message),
    ).resolves.toMatch(/email, password, and remember-me token/i);
  });

  it('mentions the device-binding possibility — the one failure a user cannot guess', async () => {
    stubGlobalFetch([{ body: { status: FAIL } }]);
    const message = await kiaAuth.login({ ...GOOD_FIELDS }, {}).catch((err: Error) => err.message);
    expect(message).toMatch(/tied to the device/i);
    expect(message).toMatch(/kia_export_refresh_token/);
  });

  it('never retries a credential rejection — that is what escalates to reCAPTCHA', async () => {
    const { calls } = stubGlobalFetch([{ body: { status: FAIL } }]);
    await expect(kiaAuth.login({ ...GOOD_FIELDS }, {})).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('surfaces a non-Error rejection without crashing on `.message`', async () => {
    vi.stubGlobal('fetch', async () => {
      throw 'socket exploded'; // eslint-disable-line no-throw-literal
    });
    await expect(kiaAuth.login({ ...GOOD_FIELDS }, {})).rejects.toThrow(/socket exploded/);
  });

  it('leaks no secret into the login-page error text', async () => {
    // The failing request carried the password and the token; the message that
    // comes back gets rendered into HTML on a page the user is looking at.
    stubGlobalFetch([{ body: { status: FAIL } }]);
    const message = await kiaAuth.login({ ...GOOD_FIELDS }, {}).catch((err: Error) => err.message);
    expect(message).not.toContain('fake-password');
    expect(message).not.toContain('fake-rmtoken');
  });

  it('refuses an incomplete form before making any network call', async () => {
    const { calls } = stubGlobalFetch([]);
    // Each missing field, including the `undefined` shape a hand-built POST can
    // produce (the connector itself normalises absent fields to '').
    await expect(kiaAuth.login({} as Record<string, string>, {})).rejects.toThrow(/all required/i);
    await expect(kiaAuth.login({ ...GOOD_FIELDS, username: '  ' }, {})).rejects.toThrow(/all required/i);
    await expect(kiaAuth.login({ ...GOOD_FIELDS, password: '' }, {})).rejects.toThrow(/all required/i);
    await expect(kiaAuth.login({ ...GOOD_FIELDS, rmtoken: '' }, {})).rejects.toThrow(/all required/i);
    expect(calls).toHaveLength(0);
  });

  it('points an unbootstrapped user at the local server, since MFA cannot run here', async () => {
    const message = await kiaAuth.login({} as Record<string, string>, {}).catch((err: Error) => err.message);
    expect(message).toMatch(/kia_export_refresh_token/);
    expect(message).toMatch(/MFA cannot be completed here/i);
  });
});

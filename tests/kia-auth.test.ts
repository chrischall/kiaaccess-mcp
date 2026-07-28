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

const CREDS = { username: 'Driver@Example.test', password: 'fake-password' };

/** In-memory stand-in for the OAUTH_KV binding the two-step flow parks state in. */
function stubKv() {
  const store = new Map<string, string>();
  return {
    store,
    binding: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
    },
  };
}
const envWith = (kv: ReturnType<typeof stubKv>) => ({ OAUTH_KV: kv.binding });

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

describe('kiaAuth — form definition', () => {
  it('collects email, password and a code box — never a remember-me token', () => {
    // The token is minted HERE by the OTP flow. Asking the user to paste one
    // was the old design and forced them to run the local stdio server first,
    // which defeats the point of a hosted connector.
    expect(kiaAuth.fields.map((f) => f.name)).toEqual(['username', 'password', 'otp']);
    expect(JSON.stringify(kiaAuth.fields)).not.toMatch(/rmtoken/i);
  });

  it('masks the password but not the texted code', () => {
    const byName = Object.fromEntries(kiaAuth.fields.map((f) => [f.name, f]));
    expect(byName.password.type).toBe('password');
    // Single-use and expires in ~2 minutes; masking only makes it harder to type.
    expect(byName.otp.type).toBeUndefined();
  });

  it('says plainly in the privacy note that the password is retained', () => {
    // It must be: Kia demands it on every session renewal, so claiming
    // otherwise would be a lie the storage layer contradicts.
    expect(kiaAuth.privacyNote).toMatch(/password/i);
    expect(kiaAuth.privacyNote).toMatch(/encrypted/i);
  });
});

describe('kiaAuth.login — step 1 (no code yet)', () => {
  it('authenticates, sends an SMS, stashes the handles and asks for the code', async () => {
    const kv = stubKv();
    const { calls } = stubGlobalFetch([
      { headers: { xid: 'fake-xid' }, body: { status: OK, payload: { otpKey: 'fake-otpkey', nextAction: 'MFA_REQUIRED' } } },
      { body: { status: OK, payload: { message: 'OTP sent successfully', phone: '(***) ***-6609' } } },
    ]);

    // The rejection is a PROMPT, so it carries no message — a banner would
    // report a failure that did not happen. Everything the user needs is in the
    // hint rendered beside the newly-revealed field.
    const thrown = await kiaAuth.login({ ...CREDS, otp: '' }, envWith(kv)).catch((e: Error) => e) as Error & {
      revealFields?: string[]; fieldHints?: Record<string, string>;
    };
    expect(thrown.message).toBe('');
    expect(thrown.revealFields).toEqual(['otp']);
    expect(thrown.fieldHints?.otp).toMatch(/code/i);

    expect(calls[0].url).toContain(ENDPOINTS.authUser);
    expect(calls[1].url).toContain(ENDPOINTS.sendOtp);
    const stashed = JSON.parse([...kv.store.values()][0]);
    expect(stashed).toEqual({ otpKey: 'fake-otpkey', xid: 'fake-xid' });
    // The stash must never carry a credential — only per-attempt handles.
    expect(JSON.stringify(stashed)).not.toContain(CREDS.password);
  });

  it('sanitizes a wrong password on the FIRST submit — the commonest failure', async () => {
    // Kia's error body can echo the request that carried the password, so this
    // path must go through describeLoginFailure (which truncates/redacts) and
    // not surface a raw KiaApiError on the login page.
    const kv = stubKv();
    stubGlobalFetch([{ body: { status: FAIL } }]);

    await expect(kiaAuth.login({ ...CREDS, otp: '' }, envWith(kv))).rejects.toThrow(/Could not sign in to Kia/);
    // Nothing was stashed, because nothing was sent.
    expect(kv.store.size).toBe(0);
  });

  it('never lets the submitted password reach the login page in an error', async () => {
    const kv = stubKv();
    // A hostile/naive upstream echoing the request straight back at us.
    stubGlobalFetch([
      {
        body: {
          status: { ...FAIL, errorMessage: `rejected for userCredential.password=${CREDS.password}` },
        },
      },
    ]);

    const err = await kiaAuth.login({ ...CREDS, otp: '' }, envWith(kv)).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(CREDS.password);
    expect((err as Error).message).toContain('[redacted]');
  });

  it('scrubs the minted token too, not just the password', async () => {
    // verifiedProps runs after a successful verifyOTP, so an upstream echo at
    // that point could carry the remember-me token — a full MFA bypass.
    const kv = stubKv();
    kv.store.set('mfa:driver@example.test', JSON.stringify({ otpKey: 'k', xid: 'x' }));
    stubGlobalFetch([
      { headers: { sid: 's', rmtoken: 'fake-rmtoken' }, body: { status: OK } },
      { body: { status: { ...FAIL, errorMessage: 'upstream echoed fake-rmtoken back' } } },
    ]);

    const err = await kiaAuth.login({ ...CREDS, otp: '038291' }, envWith(kv)).catch((e: Error) => e);
    expect((err as Error).message).not.toContain('fake-rmtoken');
  });

  it('sanitizes a failure while dispatching the code', async () => {
    const kv = stubKv();
    stubGlobalFetch([
      { headers: { xid: 'x' }, body: { status: OK, payload: { otpKey: 'k', nextAction: 'MFA_REQUIRED' } } },
      { body: { status: FAIL } },
    ]);
    await expect(kiaAuth.login({ ...CREDS, otp: '' }, envWith(kv))).rejects.toThrow(/Could not sign in to Kia/);
    // The stash is only written AFTER a successful send, so a failed dispatch
    // must not leave handles behind for a code that was never delivered.
    expect(kv.store.size).toBe(0);
  });

  it('reveals the code box and pins the destination under it', async () => {
    // The rejection IS the step-2 prompt, so it has to carry the instructions:
    // which field comes into play, and where the code went. Without
    // revealFields the box stays hidden+disabled and the flow cannot continue.
    const kv = stubKv();
    stubGlobalFetch([
      { headers: { xid: 'x' }, body: { status: OK, payload: { otpKey: 'k', nextAction: 'MFA_REQUIRED' } } },
      { body: { status: OK, payload: { phone: '(***) ***-6609' } } },
    ]);

    const err = await kiaAuth.login({ ...CREDS, otp: '' }, envWith(kv)).catch((e: Error) => e) as Error & {
      revealFields?: string[]; fieldHints?: Record<string, string>;
    };

    expect(err.revealFields).toEqual(['otp']);
    expect(err.fieldHints?.otp).toContain('6609');
  });

  it('surfaces the masked destination in the hint, where it stays while typing', async () => {
    const kv = stubKv();
    stubGlobalFetch([
      { headers: { xid: 'fake-xid' }, body: { status: OK, payload: { otpKey: 'k', nextAction: 'MFA_REQUIRED' } } },
      { body: { status: OK, payload: { phone: '(***) ***-6609' } } },
    ]);
    const thrown = await kiaAuth.login({ ...CREDS, otp: '' }, envWith(kv)).catch((e: Error) => e) as Error & {
      fieldHints?: Record<string, string>;
    };
    expect(thrown.fieldHints?.otp).toContain('(***) ***-6609');
  });

  it('still names a destination when Kia returns no masked phone', async () => {
    // Both payloads omit it; the message must stay useful rather than render
    // "sent a code to undefined".
    const kv = stubKv();
    stubGlobalFetch([
      { headers: { xid: 'x' }, body: { status: OK, payload: { otpKey: 'k', nextAction: 'MFA_REQUIRED' } } },
      { body: { status: OK, payload: {} } },
    ]);
    const thrown = await kiaAuth.login({ ...CREDS, otp: '' }, envWith(kv)).catch((e: Error) => e) as Error & {
      fieldHints?: Record<string, string>;
    };
    expect(thrown.fieldHints?.otp).toMatch(/your phone/i);
  });

  it('refuses a login with no email or no password before touching the network', async () => {
    const kv = stubKv();
    const { calls } = stubGlobalFetch([]);
    await expect(kiaAuth.login({ username: '', password: 'x', otp: '' }, envWith(kv))).rejects.toThrow(/email/i);
    await expect(kiaAuth.login({ username: 'a@b.test', password: '', otp: '' }, envWith(kv))).rejects.toThrow(/password/i);
    expect(calls).toHaveLength(0);
  });

  it('treats entirely absent fields as empty rather than throwing on undefined', async () => {
    // The harness passes whatever the form posted; a missing key must read as
    // blank, not blow up in `.trim()` before the friendly validation runs.
    const kv = stubKv();
    const { calls } = stubGlobalFetch([]);
    await expect(kiaAuth.login({}, envWith(kv))).rejects.toThrow(/email/i);
    expect(calls).toHaveLength(0);
  });

  it('fails clearly when the deployment has no OAUTH_KV to carry the code', async () => {
    const { calls } = stubGlobalFetch([]);
    await expect(kiaAuth.login({ ...CREDS, otp: '' }, {})).rejects.toThrow(/OAUTH_KV|misconfigured/i);
    expect(calls).toHaveLength(0);
  });

  it('does not pretend to succeed when Kia skips the challenge', async () => {
    // A remember-me token only ever comes back from verifyOTP. With no
    // challenge there is nothing durable to store, so accepting the login
    // would strand a session that dies at the first refresh.
    const kv = stubKv();
    stubGlobalFetch([
      // otpKey present but not MFA_REQUIRED — startLogin throws outright when
      // the key is missing, so this is the only shape reaching the branch.
      { headers: { xid: 'x' }, body: { status: OK, payload: { otpKey: 'k', nextAction: 'NONE' } } },
    ]);
    await expect(kiaAuth.login({ ...CREDS, otp: '' }, envWith(kv))).rejects.toThrow(/verification/i);
  });
});

describe('kiaAuth.login — step 2 (code supplied)', () => {
  const primed = () => {
    const kv = stubKv();
    kv.store.set('mfa:driver@example.test', JSON.stringify({ otpKey: 'fake-otpkey', xid: 'fake-xid' }));
    return kv;
  };

  it('verifies the code, keeps the token, and proves it works before storing', async () => {
    const kv = primed();
    const { calls } = stubGlobalFetch([
      { headers: { sid: 'fake-sid', rmtoken: 'fake-rmtoken' }, body: { status: OK } },
      ...LOGIN_OK,
    ]);

    const props = await kiaAuth.login({ ...CREDS, otp: '038291' }, envWith(kv));

    expect(calls[0].url).toContain(ENDPOINTS.verifyOtp);
    expect(props).toEqual({ username: CREDS.username, password: CREDS.password, rmtoken: 'fake-rmtoken' });
    // The trailing calls are the real proof: refresh, then a live read.
    expect(calls[2].url).toContain('ownr/gvl');
  });

  it('consumes the stash so a code cannot be replayed', async () => {
    const kv = primed();
    stubGlobalFetch([{ headers: { sid: 's', rmtoken: 't' }, body: { status: OK } }, ...LOGIN_OK]);
    await kiaAuth.login({ ...CREDS, otp: '038291' }, envWith(kv));
    expect(kv.store.size).toBe(0);
  });

  it('tells the user to request a fresh code when the stash has expired', async () => {
    const kv = stubKv();
    const { calls } = stubGlobalFetch([]);
    await expect(kiaAuth.login({ ...CREDS, otp: '038291' }, envWith(kv))).rejects.toThrow(/expired|fresh/i);
    expect(calls).toHaveLength(0);
  });

  it('renders a non-Error rejection without crashing on .message', async () => {
    // fetch itself can reject with a string or a DOMException in workerd, so
    // the failure formatter must not assume an Error was thrown.
    const kv = primed();
    vi.stubGlobal('fetch', async () => {
      throw 'connection reset';
    });
    await expect(kiaAuth.login({ ...CREDS, otp: '038291' }, envWith(kv))).rejects.toThrow(/connection reset/);
  });

  it('keeps the code box revealed on EVERY step-2 failure', async () => {
    // A revealOnDemand field is re-hidden on a server-side re-render unless the
    // rejection names it, so a wrong or expired code hid the very box the error
    // text tells the user to correct ("Clear the code box and submit again").
    // Invisible with JS on — the inline script only ever un-hides, never
    // re-hides — which is why it survived until a sibling connector hit it.
    //
    // Asserts the contract that matters: revealFields present AND a non-empty
    // message, since an empty message renders as a silent prompt rather than
    // the failure it is.
    const expiredStash = (await kiaAuth
      .login({ ...CREDS, otp: '038291' }, envWith(stubKv()))
      .catch((e: Error) => e)) as Error & { revealFields?: string[] };
    expect(expiredStash.revealFields).toEqual(['otp']);
    expect(expiredStash.message).not.toBe('');

    stubGlobalFetch([{ body: { status: FAIL } }]);
    const wrongCode = (await kiaAuth
      .login({ ...CREDS, otp: '000000' }, envWith(primed()))
      .catch((e: Error) => e)) as Error & { revealFields?: string[] };
    expect(wrongCode.revealFields).toEqual(['otp']);
    expect(wrongCode.message).not.toBe('');
  });

  it('reports a wrong code without retrying it', async () => {
    // A retry burns Kia's loginAttempt budget toward enforceRecaptcha, which
    // breaks server-side auth for the account permanently.
    const kv = primed();
    const { calls } = stubGlobalFetch([{ body: { status: FAIL } }]);
    await expect(kiaAuth.login({ ...CREDS, otp: '000000' }, envWith(kv))).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('normalises a non-Error rejection from the KV binding, still revealing the box', async () => {
    // kv.get is an external binding: workerd can reject it with something that
    // is not an Error, and `.revealFields` cannot be attached to a string. The
    // normalisation exists for that, and without it the throw would escape
    // un-annotated and the code box would vanish on retry.
    const kv = stubKv();
    kv.binding.get = async () => { throw 'KV unavailable'; };
    const { calls } = stubGlobalFetch([]);

    const err = await kiaAuth.login({ ...CREDS, otp: '038291' }, envWith(kv)).catch((e: Error) => e) as Error & {
      revealFields?: string[];
    };

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('KV unavailable');
    expect(err.revealFields).toEqual(['otp']);
    expect(calls).toHaveLength(0);
  });

  it('does not clobber a rejection that already chose its own reveal set', async () => {
    // The guard exists so a future throw site inside this block can name its own
    // fields. Asserted rather than assumed: silently overwriting them would be a
    // subtle bug in whatever adds that path later.
    const kv = stubKv();
    kv.binding.get = async () => {
      const e = new Error('needs a different field');
      Object.assign(e, { revealFields: ['somethingElse'] });
      throw e;
    };

    const err = await kiaAuth.login({ ...CREDS, otp: '038291' }, envWith(kv)).catch((e: Error) => e) as Error & {
      revealFields?: string[];
    };

    expect(err.revealFields).toEqual(['somethingElse']);
  });

  it('rejects the login when the post-verification read fails', async () => {
    // The code was right, but the resulting session cannot actually read the
    // account (unenrolled vehicle, revoked access). Storing those props would
    // defer the failure into a later tool call, so it fails here instead.
    const kv = primed();
    stubGlobalFetch([
      { headers: { sid: 's', rmtoken: 'fake-rmtoken' }, body: { status: OK } },
      { headers: { sid: 's' }, body: { status: OK } },
      { body: { status: FAIL } },
    ]);
    // This is one of the three step-2 failure modes the reveal fix covers, so
    // assert the contract here too rather than merely that it rejects.
    const err = await kiaAuth.login({ ...CREDS, otp: '038291' }, envWith(kv)).catch((e: Error) => e) as Error & {
      revealFields?: string[];
    };
    expect(err.revealFields).toEqual(['otp']);
    expect(err.message).not.toBe('');
  });

  it('trims whitespace a copy/paste drags into the email and code', async () => {
    const kv = primed();
    stubGlobalFetch([{ headers: { sid: 's', rmtoken: 'fake-rmtoken' }, body: { status: OK } }, ...LOGIN_OK]);
    const props = await kiaAuth.login(
      { username: '  Driver@Example.test ', password: CREDS.password, otp: ' 038291 ' },
      envWith(kv),
    );
    // Trimmed, not case-folded: hostedDeviceId normalises case itself and the
    // stash key is lowercased, so both submissions agree either way.
    expect(props.username).toBe('Driver@Example.test');
  });
});

describe('buildHostedKiaClient', () => {
  it('configures the client from the props, with the derived device id', () => {
    const client = buildHostedKiaClient({ ...CREDS, rmtoken: 'fake-rmtoken' });
    const config = client.describeConfig();
    expect(config.configured).toBe(true);
    expect(config.accountId).toBe('driver@example.test');
    expect(config.deviceId).toBe(hostedDeviceId({ ...CREDS, rmtoken: 'fake-rmtoken' }.username));
    // The rmtoken came from the props, so the hosted session is live with no
    // MFA bootstrap and no filesystem read.
    expect(config.hasSession).toBe(true);
  });

  it('ignores KIA_USERNAME/KIA_PASSWORD — one isolate serves many users', () => {
    vi.stubEnv('KIA_USERNAME', 'someone-else@example.test');
    vi.stubEnv('KIA_PASSWORD', 'not-this-one');
    const client = buildHostedKiaClient({ ...CREDS, rmtoken: 'fake-rmtoken' });
    expect(client.describeConfig().accountId).toBe('driver@example.test');
    vi.unstubAllEnvs();
  });

  it('persists nothing — the Worker has no filesystem', () => {
    // `nullSessionIO` is what makes this safe; exporting the token back out is
    // a pure read of what was passed in, never a disk read.
    const client = buildHostedKiaClient({ ...CREDS, rmtoken: 'fake-rmtoken' });
    expect(client.exportRmToken()).toBe('fake-rmtoken');
    expect(() => client.forgetSession()).not.toThrow();
  });
});

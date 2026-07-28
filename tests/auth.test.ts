import { describe, expect, it, vi } from 'vitest';
import { KiaCredentialError, refreshSession, sendOtp, startLogin, verifyOtp } from '../src/auth.js';
import { KiaApiError, type FetchLike, type KiaRequestInit } from '../src/protocol.js';

const DEVICE_ID = 'FAKE-DEVICE-0000-1111';
const CREDS = { username: 'driver@example.test', password: 'fake-password' };
const FAKE_OTP_KEY = 'fake-otp-key';
const FAKE_XID = 'fake-xid';
const FAKE_SID = 'fake-sid';
const FAKE_RMTOKEN = 'fake-rmtoken';

interface Recorded {
  url: string;
  init: KiaRequestInit;
}

function stubFetch(
  responses: Array<{ body: unknown; headers?: Record<string, string>; status?: number; text?: string }>,
): { fetchImpl: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let index = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const spec = responses[index++];
    if (spec === undefined) throw new Error(`unexpected extra fetch to ${url}`);
    return {
      status: spec.status ?? 200,
      headers: new Headers(spec.headers ?? {}),
      text: async () => spec.text ?? JSON.stringify(spec.body),
    } as unknown as Response;
  };
  return { fetchImpl, calls };
}

const OK = { statusCode: 0, errorType: 0, errorCode: 0, errorMessage: 'Success with response body' };

describe('startLogin', () => {
  it('posts the credential payload and returns the otpKey plus the xid RESPONSE header', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        headers: { xid: FAKE_XID },
        body: {
          status: OK,
          payload: {
            otpKey: FAKE_OTP_KEY,
            hasEmail: true,
            hasPhone: true,
            email: 'd***@example.test',
            phone: '***-***-1234',
            emailVerifyStatus: true,
            phoneVerifyStatus: true,
            nextAction: 'MFA_REQUIRED',
          },
        },
      },
    ]);

    const result = await startLogin(CREDS, DEVICE_ID, { fetchImpl });

    expect(result).toEqual({
      otpKey: FAKE_OTP_KEY,
      xid: FAKE_XID,
      nextAction: 'MFA_REQUIRED',
      mfaRequired: true,
      hasEmail: true,
      hasPhone: true,
      maskedEmail: 'd***@example.test',
      maskedPhone: '***-***-1234',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.owners.kia.com/apigw/v1/prof/authUser');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body!)).toEqual({
      deviceKey: '',
      deviceType: 2,
      userCredential: { userId: CREDS.username, password: CREDS.password },
      tncFlag: 1,
    });
  });

  it('sends the mandatory date header (its absence is errorCode 9200)', async () => {
    const { fetchImpl, calls } = stubFetch([
      { headers: { xid: FAKE_XID }, body: { status: OK, payload: { otpKey: FAKE_OTP_KEY, nextAction: 'MFA_REQUIRED' } } },
    ]);
    await startLogin(CREDS, DEVICE_ID, { fetchImpl });
    expect(calls[0].init.headers.date).toMatch(/GMT$/);
    expect(calls[0].init.headers.deviceid).toBe(DEVICE_ID);
  });

  it('surfaces a missing-date rejection as a KiaApiError instead of pretending it worked', async () => {
    const { fetchImpl } = stubFetch([
      {
        body: {
          status: { statusCode: 1, errorType: 3, errorCode: 9200, errorMessage: 'Missing mandatory data in header' },
        },
      },
    ]);
    await expect(startLogin(CREDS, DEVICE_ID, { fetchImpl })).rejects.toThrow(/9200/);
  });

  it('throws a NON-RETRYABLE credential error on errorCode 1001 and makes no second attempt', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        body: {
          status: { statusCode: 1, errorType: 1, errorCode: 1001, errorMessage: 'Invalid Email or Password' },
          payload: { loginAttempt: 2, enforceRecaptcha: false },
        },
      },
    ]);

    const err = await startLogin(CREDS, DEVICE_ID, { fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KiaCredentialError);
    const credErr = err as KiaCredentialError;
    expect(credErr.retryable).toBe(false);
    expect(credErr.loginAttempt).toBe(2);
    expect(credErr.enforceRecaptcha).toBe(false);
    expect(credErr.message).toMatch(/recaptcha/i);
    expect(credErr.hint).toMatch(/do not retry/i);
    // The whole point: exactly one attempt, ever.
    expect(calls).toHaveLength(1);
  });

  it('throws the same non-retryable error on errorCode 1037', async () => {
    const { fetchImpl, calls } = stubFetch([
      { body: { status: { statusCode: 1, errorCode: 1037, errorMessage: 'Please enter valid email address' } } },
    ]);
    await expect(startLogin(CREDS, DEVICE_ID, { fetchImpl })).rejects.toBeInstanceOf(KiaCredentialError);
    expect(calls).toHaveLength(1);
  });

  it('reports when reCAPTCHA has already been enforced', async () => {
    const { fetchImpl } = stubFetch([
      {
        body: {
          status: { statusCode: 1, errorCode: 1001, errorMessage: 'Invalid Email or Password' },
          payload: { loginAttempt: 5, enforceRecaptcha: true },
        },
      },
    ]);
    const err = (await startLogin(CREDS, DEVICE_ID, { fetchImpl }).catch((e: unknown) => e)) as KiaCredentialError;
    expect(err.enforceRecaptcha).toBe(true);
    expect(err.message).toMatch(/already/i);
  });

  it('throws when the xid response header is missing', async () => {
    const { fetchImpl } = stubFetch([{ body: { status: OK, payload: { otpKey: FAKE_OTP_KEY } } }]);
    await expect(startLogin(CREDS, DEVICE_ID, { fetchImpl })).rejects.toThrow(/xid/i);
  });

  it('throws when the otpKey is missing from the payload', async () => {
    const { fetchImpl } = stubFetch([{ headers: { xid: FAKE_XID }, body: { status: OK, payload: {} } }]);
    await expect(startLogin(CREDS, DEVICE_ID, { fetchImpl })).rejects.toThrow(/otpKey/i);
  });

  it('reports mfaRequired=false when Kia skips the challenge', async () => {
    const { fetchImpl } = stubFetch([
      { headers: { xid: FAKE_XID }, body: { status: OK, payload: { otpKey: FAKE_OTP_KEY } } },
    ]);
    const result = await startLogin(CREDS, DEVICE_ID, { fetchImpl });
    expect(result.mfaRequired).toBe(false);
    expect(result.nextAction).toBeUndefined();
    expect(result.maskedEmail).toBeUndefined();
  });
});

describe('sendOtp', () => {
  it('sends the otpkey/xid/notifytype headers with an empty body', async () => {
    const { fetchImpl, calls } = stubFetch([
      { body: { status: OK, payload: { phone: '***-***-1234', message: 'OTP sent successfully', expiresIn: 1800000000000 } } },
    ]);

    const result = await sendOtp({ otpKey: FAKE_OTP_KEY, xid: FAKE_XID, notifyType: 'SMS' }, DEVICE_ID, { fetchImpl });

    expect(result).toEqual({ message: 'OTP sent successfully', maskedPhone: '***-***-1234', expiresIn: 1800000000000 });
    expect(calls[0].url).toBe('https://api.owners.kia.com/apigw/v1/cmm/sendOTP');
    expect(calls[0].init.headers.otpkey).toBe(FAKE_OTP_KEY);
    expect(calls[0].init.headers.xid).toBe(FAKE_XID);
    expect(calls[0].init.headers.notifytype).toBe('SMS');
    expect(JSON.parse(calls[0].init.body!)).toEqual({});
  });

  it('supports EMAIL delivery', async () => {
    const { fetchImpl, calls } = stubFetch([{ body: { status: OK, payload: {} } }]);
    const result = await sendOtp({ otpKey: FAKE_OTP_KEY, xid: FAKE_XID, notifyType: 'EMAIL' }, DEVICE_ID, { fetchImpl });
    expect(calls[0].init.headers.notifytype).toBe('EMAIL');
    expect(result).toEqual({ message: undefined, maskedPhone: undefined, expiresIn: undefined });
  });

  it('propagates a non-zero statusCode', async () => {
    const { fetchImpl } = stubFetch([
      { body: { status: { statusCode: 1, errorCode: 4001, errorMessage: 'OTP send failed' } } },
    ]);
    await expect(
      sendOtp({ otpKey: FAKE_OTP_KEY, xid: FAKE_XID, notifyType: 'SMS' }, DEVICE_ID, { fetchImpl }),
    ).rejects.toBeInstanceOf(KiaApiError);
  });
});

describe('verifyOtp', () => {
  it('returns the sid and rmtoken from the RESPONSE headers', async () => {
    const { fetchImpl, calls } = stubFetch([
      { headers: { sid: FAKE_SID, rmtoken: FAKE_RMTOKEN }, body: { status: OK, payload: {} } },
    ]);

    const result = await verifyOtp({ otpKey: FAKE_OTP_KEY, xid: FAKE_XID, otp: '000000' }, DEVICE_ID, { fetchImpl });

    expect(result).toEqual({ sid: FAKE_SID, rmtoken: FAKE_RMTOKEN });
    expect(calls[0].url).toBe('https://api.owners.kia.com/apigw/v1/cmm/verifyOTP');
    expect(calls[0].init.headers.otpkey).toBe(FAKE_OTP_KEY);
    expect(calls[0].init.headers.xid).toBe(FAKE_XID);
    expect(JSON.parse(calls[0].init.body!)).toEqual({ otp: '000000' });
  });

  it('throws when the sid header is missing', async () => {
    const { fetchImpl } = stubFetch([{ headers: { rmtoken: FAKE_RMTOKEN }, body: { status: OK } }]);
    await expect(
      verifyOtp({ otpKey: FAKE_OTP_KEY, xid: FAKE_XID, otp: '000000' }, DEVICE_ID, { fetchImpl }),
    ).rejects.toThrow(/sid/i);
  });

  it('throws when the rmtoken header is missing', async () => {
    const { fetchImpl } = stubFetch([{ headers: { sid: FAKE_SID }, body: { status: OK } }]);
    await expect(
      verifyOtp({ otpKey: FAKE_OTP_KEY, xid: FAKE_XID, otp: '000000' }, DEVICE_ID, { fetchImpl }),
    ).rejects.toThrow(/rmtoken/i);
  });

  it('propagates a rejected OTP', async () => {
    const { fetchImpl } = stubFetch([
      { body: { status: { statusCode: 1, errorCode: 4004, errorMessage: 'Invalid OTP' } } },
    ]);
    await expect(
      verifyOtp({ otpKey: FAKE_OTP_KEY, xid: FAKE_XID, otp: '000000' }, DEVICE_ID, { fetchImpl }),
    ).rejects.toThrow(/Invalid OTP/);
  });
});

describe('refreshSession', () => {
  it('mints a fresh sid from the rmtoken with no MFA challenge', async () => {
    const { fetchImpl, calls } = stubFetch([{ headers: { sid: FAKE_SID }, body: { status: OK, payload: {} } }]);

    const result = await refreshSession(FAKE_RMTOKEN, CREDS, DEVICE_ID, { fetchImpl });

    expect(result).toEqual({ sid: FAKE_SID, rmtoken: FAKE_RMTOKEN });
    expect(calls[0].url).toBe('https://api.owners.kia.com/apigw/v1/prof/authUser');
    expect(calls[0].init.headers.rmtoken).toBe(FAKE_RMTOKEN);
    expect(calls[0].init.headers.sid).toBeUndefined();
    // Refresh body: deviceKey is the device uuid and tncFlag is omitted.
    expect(JSON.parse(calls[0].init.body!)).toEqual({
      deviceKey: DEVICE_ID,
      deviceType: 2,
      userCredential: { userId: CREDS.username, password: CREDS.password },
    });
  });

  it('keeps the existing rmtoken when Kia does not rotate it, and adopts one when it does', async () => {
    const rotated = 'fake-rmtoken-2';
    const { fetchImpl } = stubFetch([
      { headers: { sid: FAKE_SID, rmtoken: rotated }, body: { status: OK } },
    ]);
    const result = await refreshSession(FAKE_RMTOKEN, CREDS, DEVICE_ID, { fetchImpl });
    expect(result.rmtoken).toBe(rotated);
  });

  it('throws a non-retryable credential error rather than retrying (1001)', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        body: {
          status: { statusCode: 1, errorCode: 1001, errorMessage: 'Invalid Email or Password' },
          payload: { loginAttempt: 1 },
        },
      },
    ]);
    await expect(refreshSession(FAKE_RMTOKEN, CREDS, DEVICE_ID, { fetchImpl })).rejects.toBeInstanceOf(
      KiaCredentialError,
    );
    expect(calls).toHaveLength(1);
  });

  it('throws when no sid comes back', async () => {
    const { fetchImpl } = stubFetch([{ body: { status: OK, payload: {} } }]);
    await expect(refreshSession(FAKE_RMTOKEN, CREDS, DEVICE_ID, { fetchImpl })).rejects.toThrow(/sid/i);
  });

  it('surfaces a stale rmtoken as an actionable re-bootstrap error', async () => {
    const { fetchImpl } = stubFetch([
      { body: { status: { statusCode: 1, errorCode: 5001, errorMessage: 'Invalid rmtoken' } } },
    ]);
    const err = (await refreshSession(FAKE_RMTOKEN, CREDS, DEVICE_ID, { fetchImpl }).catch(
      (e: unknown) => e,
    )) as KiaApiError;
    expect(err).toBeInstanceOf(KiaApiError);
    expect(err.errorCode).toBe(5001);
  });

  it('uses the global fetch when none is injected', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 200,
      headers: new Headers({ sid: FAKE_SID }),
      text: async () => JSON.stringify({ status: OK }),
    } as unknown as Response);
    try {
      await expect(refreshSession(FAKE_RMTOKEN, CREDS, DEVICE_ID)).resolves.toMatchObject({ sid: FAKE_SID });
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects a non-JSON upstream response with a clear error', async () => {
    const { fetchImpl } = stubFetch([{ body: null, status: 502, text: '<html>Bad Gateway</html>' }]);
    await expect(refreshSession(FAKE_RMTOKEN, CREDS, DEVICE_ID, { fetchImpl })).rejects.toThrow(/non-JSON/i);
  });

  it('labels an empty upstream body rather than reporting an empty error', async () => {
    const { fetchImpl } = stubFetch([{ body: null, status: 504, text: '' }]);
    await expect(refreshSession(FAKE_RMTOKEN, CREDS, DEVICE_ID, { fetchImpl })).rejects.toThrow(/<empty body>/);
  });
});

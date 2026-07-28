import { describe, expect, it } from 'vitest';
import {
  BASE_URL,
  COMMAND_SPECS,
  KIA_ERROR_INVALID_CREDENTIALS,
  KIA_ERROR_INVALID_EMAIL,
  KIA_ERROR_INVALID_VEHICLE_FOR_SESSION,
  KIA_ERROR_MISSING_HEADER_DATA,
  KIA_STATIC_HEADERS,
  KiaApiError,
  assertKiaSuccess,
  buildHeaders,
  gmtOffsetHours,
  isCredentialRejection,
  isInvalidVehicleForSessionStatus,
  isSessionExpiredStatus,
  rfc1123,
} from '../src/protocol.js';

const DEVICE_ID = 'FAKE-DEVICE-0000-1111';

describe('BASE_URL', () => {
  it('is the apigw v1 root and ends in a slash so paths concatenate', () => {
    expect(BASE_URL).toBe('https://api.owners.kia.com/apigw/v1/');
    expect(`${BASE_URL}prof/authUser`).toBe('https://api.owners.kia.com/apigw/v1/prof/authUser');
  });
});

describe('rfc1123', () => {
  it('formats a date as an RFC 1123 GMT string', () => {
    expect(rfc1123(new Date(Date.UTC(2026, 6, 27, 19, 4, 5)))).toBe('Mon, 27 Jul 2026 19:04:05 GMT');
  });
});

describe('gmtOffsetHours', () => {
  it('returns the local offset in hours, negative west of GMT', () => {
    const date = new Date('2026-07-27T19:00:00Z');
    // getTimezoneOffset() is minutes *behind* UTC, so the sign flips.
    const expected = String(Math.round(-date.getTimezoneOffset() / 60));
    expect(gmtOffsetHours(date)).toBe(expected);
  });
});

describe('buildHeaders', () => {
  it('always sets a fresh RFC 1123 date header (omitting it fails with errorCode 9200)', () => {
    const now = new Date(Date.UTC(2026, 6, 27, 19, 4, 5));
    const headers = buildHeaders(DEVICE_ID, undefined, { now });
    expect(headers.date).toBe('Mon, 27 Jul 2026 19:04:05 GMT');
  });

  it('advances the date header between calls rather than caching one', () => {
    const first = buildHeaders(DEVICE_ID, undefined, { now: new Date(Date.UTC(2026, 6, 27, 19, 0, 0)) });
    const second = buildHeaders(DEVICE_ID, undefined, { now: new Date(Date.UTC(2026, 6, 27, 19, 0, 30)) });
    expect(first.date).not.toBe(second.date);
  });

  it('defaults the date to the current clock when no `now` is injected', () => {
    const before = Date.now();
    const headers = buildHeaders(DEVICE_ID);
    const after = Date.now();
    const stamped = Date.parse(headers.date);
    // RFC 1123 has second granularity, so floor the bounds to the second.
    expect(stamped).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(stamped).toBeLessThanOrEqual(after);
  });

  it('carries the full static header set', () => {
    const headers = buildHeaders(DEVICE_ID);
    for (const [key, value] of Object.entries(KIA_STATIC_HEADERS)) {
      expect(headers[key]).toBe(value);
    }
    expect(headers.secretkey).toBe('sydnat-9kykci-Kuhtep-h5nK');
    expect(headers.host).toBe('api.owners.kia.com');
  });

  it('sets both deviceid and clientuuid to the device uuid', () => {
    const headers = buildHeaders(DEVICE_ID);
    expect(headers.deviceid).toBe(DEVICE_ID);
    expect(headers.clientuuid).toBe(DEVICE_ID);
  });

  it('sets the gmt offset header', () => {
    const now = new Date('2026-07-27T19:00:00Z');
    expect(buildHeaders(DEVICE_ID, undefined, { now }).offset).toBe(gmtOffsetHours(now));
  });

  it('merges extra headers (sid / vinkey / otpkey) lowercased', () => {
    const headers = buildHeaders(DEVICE_ID, { sid: 'fake-sid', vinKey: 'fake-vinkey' });
    expect(headers.sid).toBe('fake-sid');
    expect(headers.vinkey).toBe('fake-vinkey');
  });

  it('drops extra headers whose value is undefined', () => {
    const headers = buildHeaders(DEVICE_ID, { sid: undefined, vinkey: 'fake-vinkey' });
    expect('sid' in headers).toBe(false);
    expect(headers.vinkey).toBe('fake-vinkey');
  });
});

describe('assertKiaSuccess', () => {
  it('returns the envelope when status.statusCode is 0', () => {
    const body = { status: { statusCode: 0, errorMessage: 'Success with response body' }, payload: { a: 1 } };
    expect(assertKiaSuccess<{ a: number }>(body, 'cmm/gvi').payload).toEqual({ a: 1 });
  });

  it('throws KiaApiError when statusCode is non-zero even though HTTP was 200', () => {
    const body = {
      status: { statusCode: 1, errorType: 3, errorCode: 9200, errorMessage: 'Missing mandatory data in header' },
    };
    try {
      assertKiaSuccess(body, 'prof/authUser');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(KiaApiError);
      const apiErr = err as KiaApiError;
      expect(apiErr.statusCode).toBe(1);
      expect(apiErr.errorType).toBe(3);
      expect(apiErr.errorCode).toBe(KIA_ERROR_MISSING_HEADER_DATA);
      expect(apiErr.errorMessage).toBe('Missing mandatory data in header');
      expect(apiErr.path).toBe('prof/authUser');
      expect(apiErr.message).toContain('9200');
      expect(apiErr.hint).toMatch(/date/i);
    }
  });

  it('has no date hint for unrelated error codes', () => {
    const err = new KiaApiError({ statusCode: 1, errorCode: 4004, errorMessage: 'Nope' }, 'rems/start');
    expect(err.hint).toBeUndefined();
    expect(err.message).toContain('rems/start');
  });

  it('tolerates a missing errorMessage', () => {
    const err = new KiaApiError({ statusCode: 1 }, 'cmm/gvi');
    expect(err.message).toContain('cmm/gvi');
    expect(err.errorMessage).toBeUndefined();
  });

  it('throws when the body is not a Kia envelope at all', () => {
    expect(() => assertKiaSuccess('<html>gateway error</html>', 'ownr/gvl')).toThrow(KiaApiError);
    expect(() => assertKiaSuccess(null, 'ownr/gvl')).toThrow(/unrecognized/i);
    expect(() => assertKiaSuccess({ nope: true }, 'ownr/gvl')).toThrow(/unrecognized/i);
  });
});

describe('isCredentialRejection', () => {
  it('matches the two credential-rejection codes', () => {
    expect(isCredentialRejection({ statusCode: 1, errorCode: KIA_ERROR_INVALID_CREDENTIALS })).toBe(true);
    expect(isCredentialRejection({ statusCode: 1, errorCode: KIA_ERROR_INVALID_EMAIL })).toBe(true);
  });

  it('does not match success or unrelated failures', () => {
    expect(isCredentialRejection({ statusCode: 0 })).toBe(false);
    expect(isCredentialRejection({ statusCode: 1, errorCode: 9200 })).toBe(false);
    expect(isCredentialRejection({ statusCode: 1 })).toBe(false);
  });
});

describe('isSessionExpiredStatus', () => {
  it('never treats a success as expired', () => {
    expect(isSessionExpiredStatus({ statusCode: 0, errorMessage: 'session' })).toBe(false);
  });

  it('matches session-shaped failure messages', () => {
    expect(isSessionExpiredStatus({ statusCode: 1, errorMessage: 'Session Key is either invalid or expired' })).toBe(true);
    expect(isSessionExpiredStatus({ statusCode: 1, errorMessage: 'Please re-login' })).toBe(true);
  });

  it('does not match a credential rejection (that must never be retried)', () => {
    expect(
      isSessionExpiredStatus({ statusCode: 1, errorCode: KIA_ERROR_INVALID_CREDENTIALS, errorMessage: 'Invalid Email or Password' }),
    ).toBe(false);
  });

  it('does not match unrelated failures or a missing message', () => {
    expect(isSessionExpiredStatus({ statusCode: 1, errorCode: 9200, errorMessage: 'Missing mandatory data in header' })).toBe(false);
    expect(isSessionExpiredStatus({ statusCode: 1 })).toBe(false);
  });

  /**
   * Regression: this message contains the word "session", so the substring
   * heuristic classified a rotated `vinkey` as a dead session and re-ran
   * `prof/authUser` — which mints a NEW session and rotates every vehicle key
   * again. Each attempt therefore invalidated the key the caller had just
   * fetched, and no retry could ever succeed.
   */
  it('does not match "Invalid vehicle for current session" — that is a stale vinkey, not a dead session', () => {
    expect(
      isSessionExpiredStatus({
        statusCode: 1,
        errorType: 1,
        errorCode: KIA_ERROR_INVALID_VEHICLE_FOR_SESSION,
        errorMessage: 'Invalid vehicle for current session',
      }),
    ).toBe(false);
  });
});

describe('isInvalidVehicleForSessionStatus', () => {
  it('matches Kia errorCode 1005', () => {
    expect(
      isInvalidVehicleForSessionStatus({
        statusCode: 1,
        errorType: 1,
        errorCode: KIA_ERROR_INVALID_VEHICLE_FOR_SESSION,
        errorMessage: 'Invalid vehicle for current session',
      }),
    ).toBe(true);
  });

  it('keys off the errorCode, not the message', () => {
    // Same words, different code — not the rotated-key condition.
    expect(isInvalidVehicleForSessionStatus({ statusCode: 1, errorCode: 1, errorMessage: 'Invalid vehicle for current session' })).toBe(
      false,
    );
    expect(isInvalidVehicleForSessionStatus({ statusCode: 0, errorCode: KIA_ERROR_INVALID_VEHICLE_FOR_SESSION })).toBe(false);
    expect(isInvalidVehicleForSessionStatus({ statusCode: 1 })).toBe(false);
  });
});

describe('COMMAND_SPECS', () => {
  it('records the live-verified door and climate commands with their proof fields', () => {
    expect(COMMAND_SPECS.lock).toMatchObject({ path: 'rems/door/lock', method: 'GET', verified: true });
    expect(COMMAND_SPECS.unlock).toMatchObject({ path: 'rems/door/unlock', method: 'GET', verified: true });
    expect(COMMAND_SPECS.start).toMatchObject({ path: 'rems/start', method: 'POST', verified: true });
    expect(COMMAND_SPECS.stop).toMatchObject({ path: 'rems/stop', method: 'GET', verified: true });
    expect(COMMAND_SPECS.start.proofFields).toContain('ign3');
  });

  it('marks every command verified, each with the proof field it was verified by', () => {
    // All seven were exercised against the live vehicle. The flag is not
    // decorative: it feeds endpointVerified in every tool result, so a spec
    // added later from documentation alone must set it false rather than
    // inherit a blanket true.
    for (const spec of Object.values(COMMAND_SPECS)) {
      expect(spec.verified).toBe(true);
    }
    // Charging proves itself with evStatus.batteryCharge, NOT evc/gts — that
    // reports the target state of charge, not whether the car is charging.
    expect(COMMAND_SPECS.charge.proofFields).toEqual(['evStatus.batteryCharge']);
    expect(COMMAND_SPECS.cancelCharge.proofFields).toEqual(['evStatus.batteryCharge']);
    // evc/sts is proven by re-reading evc/gts, which the tool does itself.
    expect(COMMAND_SPECS.setChargeTargets.proofFields).toEqual([]);
    expect(COMMAND_SPECS.setChargeTargets.note).toMatch(/BOTH plug types/);
  });
});

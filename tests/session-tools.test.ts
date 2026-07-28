/**
 * Tests for the account/session tools — the one-time MFA bootstrap plus the
 * refresh-token export the hosted connector needs.
 *
 * The Kia client is a stub: nothing here touches the network, and every fixture
 * is an obvious fake (no real email, device id, otp key, sid or rmtoken).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import type { TestHarness } from '@chrischall/mcp-utils/test';
import type { KiaSessionClient } from '../src/tools/session.js';
import { maskAccountId, registerSessionTools } from '../src/tools/session.js';

// --- fixtures (deliberate fakes) -------------------------------------------

const ACCOUNT = 'driver@example.invalid';
const MASKED_ACCOUNT = 'd***@example.invalid';
const DEVICE_ID = 'fakedevice-0000-0000-0000-000000000000';
const OTP_KEY = 'FAKE-OTP-KEY';
const XID = 'FAKE-XID';
const RMTOKEN = 'FAKE-RMTOKEN-NOT-A-REAL-CREDENTIAL';
/** Kia reports the OTP window as an epoch-ms instant, not a duration. */
const OTP_EXPIRES_AT_MS = Date.parse('2026-07-27T20:02:00.000Z');

type Stub = {
  describeConfig: ReturnType<typeof vi.fn>;
  beginLogin: ReturnType<typeof vi.fn>;
  sendLoginOtp: ReturnType<typeof vi.fn>;
  completeLogin: ReturnType<typeof vi.fn>;
  exportRmToken: ReturnType<typeof vi.fn>;
  forgetSession: ReturnType<typeof vi.fn>;
};

function makeStub(): Stub {
  return {
    describeConfig: vi.fn(() => ({
      accountId: ACCOUNT,
      deviceId: DEVICE_ID,
      configured: true,
      hasSession: true,
    })),
    beginLogin: vi.fn(async () => ({
      otpKey: OTP_KEY,
      xid: XID,
      nextAction: 'MFA_REQUIRED',
      mfaRequired: true,
      hasEmail: true,
      hasPhone: true,
      maskedEmail: 'd***@example.invalid',
      maskedPhone: '***-***-0000',
    })),
    sendLoginOtp: vi.fn(async () => ({
      message: 'A passcode was sent.',
      maskedPhone: '***-***-0000',
      // Kia's `expiresIn` is an epoch-ms timestamp, not a duration.
      expiresIn: OTP_EXPIRES_AT_MS as number | undefined,
    })),
    completeLogin: vi.fn(async () => ({ accountId: ACCOUNT, deviceId: DEVICE_ID, persisted: true })),
    exportRmToken: vi.fn(() => RMTOKEN as string | null),
    forgetSession: vi.fn(() => undefined),
  };
}

let stub: Stub;
let harness: TestHarness;
const originalWriteMode = process.env.KIA_WRITE_MODE;

async function mount(): Promise<void> {
  harness = await createTestHarness((server) =>
    registerSessionTools(server, stub as unknown as KiaSessionClient),
  );
}

function textOf(result: { content: unknown }): string {
  return (result.content as { text: string }[])[0].text;
}

beforeEach(() => {
  stub = makeStub();
  delete process.env.KIA_WRITE_MODE;
});

afterEach(async () => {
  if (harness) await harness.close();
  vi.restoreAllMocks();
  if (originalWriteMode === undefined) delete process.env.KIA_WRITE_MODE;
  else process.env.KIA_WRITE_MODE = originalWriteMode;
});

// --- registration -----------------------------------------------------------

describe('registerSessionTools', () => {
  it('registers exactly the six account tools', async () => {
    await mount();
    const names = (await harness.listTools()).map((t) => t.name).sort();
    expect(names).toEqual([
      'kia_export_refresh_token',
      'kia_forget_session',
      'kia_send_otp',
      'kia_session_status',
      'kia_start_login',
      'kia_verify_otp',
    ]);
  });

  it('touches the client at registration time', async () => {
    await mount();
    expect(stub.describeConfig).not.toHaveBeenCalled();
    expect(stub.beginLogin).not.toHaveBeenCalled();
    expect(stub.exportRmToken).not.toHaveBeenCalled();
    expect(stub.forgetSession).not.toHaveBeenCalled();
  });
});

// --- maskAccountId ----------------------------------------------------------

describe('maskAccountId', () => {
  it('keeps only the first character and the domain of an email', () => {
    expect(maskAccountId(ACCOUNT)).toBe(MASKED_ACCOUNT);
  });

  it('returns null for an absent account', () => {
    expect(maskAccountId(null)).toBeNull();
  });

  it('reveals nothing when the value is not email-shaped', () => {
    expect(maskAccountId('not-an-email')).toBe('***');
    expect(maskAccountId('@leading-at')).toBe('***');
  });
});

// --- kia_session_status -----------------------------------------------------

describe('kia_session_status', () => {
  it('reports a configured, bootstrapped account without leaking the address or device id', async () => {
    await mount();
    const result = await harness.callTool('kia_session_status');
    expect(result.isError).toBeFalsy();
    const data = parseToolResult<Record<string, unknown>>(result);
    expect(data.configured).toBe(true);
    expect(data.hasSession).toBe(true);
    expect(data.account).toBe(MASKED_ACCOUNT);
    expect(data.deviceIdPrefix).toBe('fakedevi…');
    expect(String(data.nextStep)).toMatch(/ready/i);
    // The raw email and the full device id must never reach a transcript.
    expect(textOf(result)).not.toContain(ACCOUNT);
    expect(textOf(result)).not.toContain(DEVICE_ID);
  });

  it('tells an unconfigured server how to configure itself', async () => {
    stub.describeConfig.mockReturnValue({
      accountId: null,
      deviceId: DEVICE_ID,
      configured: false,
      hasSession: false,
    });
    await mount();
    const data = parseToolResult<Record<string, unknown>>(await harness.callTool('kia_session_status'));
    expect(data.configured).toBe(false);
    expect(data.account).toBeNull();
    expect(String(data.nextStep)).toContain('KIA_USERNAME');
  });

  it('points a configured-but-unbootstrapped account at the MFA flow', async () => {
    stub.describeConfig.mockReturnValue({
      accountId: ACCOUNT,
      deviceId: DEVICE_ID,
      configured: true,
      hasSession: false,
    });
    await mount();
    const data = parseToolResult<Record<string, unknown>>(await harness.callTool('kia_session_status'));
    expect(data.hasSession).toBe(false);
    expect(String(data.nextStep)).toContain('kia_start_login');
  });

  it('reports the write mode that was resolved at registration time', async () => {
    process.env.KIA_WRITE_MODE = 'all';
    await mount();
    // Changing the env AFTER registration must not change the report: the tools
    // that exist were decided at startup.
    process.env.KIA_WRITE_MODE = 'none';
    const data = parseToolResult<Record<string, unknown>>(await harness.callTool('kia_session_status'));
    expect(data.writeMode).toBe('all');
  });
});

// --- kia_start_login --------------------------------------------------------

describe('kia_start_login', () => {
  it('makes NO network call without confirm and previews what would be sent', async () => {
    await mount();
    const result = await harness.callTool('kia_start_login', {});
    const data = parseToolResult<Record<string, unknown>>(result);
    expect(data.dryRun).toBe(true);
    expect(data.method).toBe('POST');
    expect(String(data.endpoint)).toContain('authUser');
    expect(String(data.risk)).toMatch(/recaptcha/i);
    expect(stub.beginLogin).not.toHaveBeenCalled();
    // The preview describes the password without carrying it.
    expect(textOf(result)).toContain('KIA_PASSWORD');
    expect(data.account).toBe(MASKED_ACCOUNT);
  });

  it('starts the MFA challenge with confirm and reports the masked destinations', async () => {
    await mount();
    const result = await harness.callTool('kia_start_login', { confirm: true });
    expect(result.isError).toBeFalsy();
    const data = parseToolResult<Record<string, unknown>>(result);
    expect(stub.beginLogin).toHaveBeenCalledTimes(1);
    expect(data.otpKey).toBe(OTP_KEY);
    expect(data.xid).toBe(XID);
    expect(data.mfaRequired).toBe(true);
    expect(data.destinations).toEqual({
      hasEmail: true,
      hasPhone: true,
      maskedEmail: 'd***@example.invalid',
      maskedPhone: '***-***-0000',
    });
    expect(String(data.nextStep)).toContain('kia_send_otp');
  });

  it('still previews (without naming an account) when no credentials are configured', async () => {
    stub.describeConfig.mockReturnValue({
      accountId: null,
      deviceId: DEVICE_ID,
      configured: false,
      hasSession: false,
    });
    await mount();
    const data = parseToolResult<Record<string, unknown>>(await harness.callTool('kia_start_login', {}));
    expect(data.dryRun).toBe(true);
    expect(data.account).toBeNull();
    expect(String(data.action)).toContain('the configured account');
    expect(stub.beginLogin).not.toHaveBeenCalled();
  });

  it('surfaces a credential rejection instead of retrying it', async () => {
    stub.beginLogin.mockRejectedValue(new Error('prof/authUser failed — credentials rejected'));
    await mount();
    const result = await harness.callTool('kia_start_login', { confirm: true });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/credentials rejected/i);
    expect(stub.beginLogin).toHaveBeenCalledTimes(1);
  });
});

// --- kia_send_otp -----------------------------------------------------------

describe('kia_send_otp', () => {
  it('forwards the handshake values and the chosen channel', async () => {
    await mount();
    const result = await harness.callTool('kia_send_otp', {
      otpKey: OTP_KEY,
      xid: XID,
      notifyType: 'SMS',
    });
    expect(result.isError).toBeFalsy();
    expect(stub.sendLoginOtp).toHaveBeenCalledWith({ otpKey: OTP_KEY, xid: XID, notifyType: 'SMS' });
    const data = parseToolResult<Record<string, unknown>>(result);
    expect(data.sent).toBe(true);
    expect(data.notifyType).toBe('SMS');
    expect(data.maskedPhone).toBe('***-***-0000');
    // `expiresIn` is an epoch-ms instant — rendered, not echoed as a duration.
    expect(data.expiresAt).toBe('2026-07-27T20:02:00.000Z');
    expect(data.expiresIn).toBeUndefined();
    expect(String(data.nextStep)).toContain('kia_verify_otp');
  });

  it('drops an expiry Kia did not send, or sent as an unusable number', async () => {
    await mount();
    stub.sendLoginOtp.mockResolvedValueOnce({ message: 'sent', maskedPhone: undefined, expiresIn: undefined });
    const absent = parseToolResult<Record<string, unknown>>(
      await harness.callTool('kia_send_otp', { otpKey: OTP_KEY, xid: XID, notifyType: 'EMAIL' }),
    );
    expect(absent.expiresAt).toBeUndefined();

    stub.sendLoginOtp.mockResolvedValueOnce({ message: 'sent', maskedPhone: undefined, expiresIn: Number.NaN });
    const junk = parseToolResult<Record<string, unknown>>(
      await harness.callTool('kia_send_otp', { otpKey: OTP_KEY, xid: XID, notifyType: 'EMAIL' }),
    );
    expect(junk.expiresAt).toBeUndefined();
  });

  it('rejects a header-injecting otpKey before any call', async () => {
    await mount();
    const result = await harness.callTool('kia_send_otp', {
      otpKey: 'FAKE\r\nx-injected: 1',
      xid: XID,
      notifyType: 'EMAIL',
    });
    expect(result.isError).toBe(true);
    expect(stub.sendLoginOtp).not.toHaveBeenCalled();
  });
});

// --- kia_verify_otp ---------------------------------------------------------

describe('kia_verify_otp', () => {
  it('completes the bootstrap and returns no secret', async () => {
    await mount();
    const result = await harness.callTool('kia_verify_otp', { otpKey: OTP_KEY, xid: XID, otp: '123456' });
    expect(result.isError).toBeFalsy();
    expect(stub.completeLogin).toHaveBeenCalledWith({ otpKey: OTP_KEY, xid: XID, otp: '123456' });
    const data = parseToolResult<Record<string, unknown>>(result);
    expect(data.verified).toBe(true);
    expect(data.persisted).toBe(true);
    expect(data.account).toBe(MASKED_ACCOUNT);
    const text = textOf(result);
    expect(text).not.toContain(ACCOUNT);
    expect(text).not.toContain(RMTOKEN);
  });

  it('rejects a non-numeric passcode before any call', async () => {
    await mount();
    const result = await harness.callTool('kia_verify_otp', { otpKey: OTP_KEY, xid: XID, otp: 'abcdef' });
    expect(result.isError).toBe(true);
    expect(stub.completeLogin).not.toHaveBeenCalled();
  });
});

// --- kia_export_refresh_token ----------------------------------------------

describe('kia_export_refresh_token', () => {
  it('returns NO token without confirm and does not read it', async () => {
    await mount();
    const result = await harness.callTool('kia_export_refresh_token', {});
    const data = parseToolResult<Record<string, unknown>>(result);
    expect(data.dryRun).toBe(true);
    expect(textOf(result)).not.toContain(RMTOKEN);
    expect(String(data.warning)).toMatch(/credential/i);
    expect(stub.exportRmToken).not.toHaveBeenCalled();
  });

  it('previews without naming an account when nothing is configured', async () => {
    stub.describeConfig.mockReturnValue({
      accountId: null,
      deviceId: DEVICE_ID,
      configured: false,
      hasSession: false,
    });
    await mount();
    const data = parseToolResult<Record<string, unknown>>(await harness.callTool('kia_export_refresh_token', {}));
    expect(data.dryRun).toBe(true);
    expect(data.account).toBeNull();
    expect(data.hasSession).toBe(false);
    expect(String(data.action)).toContain('the configured account');
    expect(stub.exportRmToken).not.toHaveBeenCalled();
  });

  it('returns the token with confirm, labelled as a credential', async () => {
    await mount();
    const result = await harness.callTool('kia_export_refresh_token', { confirm: true });
    expect(result.isError).toBeFalsy();
    const data = parseToolResult<Record<string, unknown>>(result);
    expect(data.rmtoken).toBe(RMTOKEN);
    expect(data.account).toBe(MASKED_ACCOUNT);
    expect(String(data.warning)).toMatch(/bypass/i);
  });

  it('explains the missing bootstrap when the account has no stored token', async () => {
    stub.exportRmToken.mockReturnValue(null);
    stub.describeConfig.mockReturnValue({
      accountId: ACCOUNT,
      deviceId: DEVICE_ID,
      configured: true,
      hasSession: false,
    });
    await mount();
    const result = await harness.callTool('kia_export_refresh_token', { confirm: true });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('kia_start_login');
  });

  it('explains the missing configuration when no credentials are set', async () => {
    stub.exportRmToken.mockReturnValue(null);
    stub.describeConfig.mockReturnValue({
      accountId: null,
      deviceId: DEVICE_ID,
      configured: false,
      hasSession: false,
    });
    await mount();
    const result = await harness.callTool('kia_export_refresh_token', { confirm: true });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('KIA_USERNAME');
  });
});

// --- kia_forget_session -----------------------------------------------------

describe('kia_forget_session', () => {
  it('deletes nothing without confirm and previews what would be discarded', async () => {
    await mount();
    const result = await harness.callTool('kia_forget_session', {});
    const data = parseToolResult<Record<string, unknown>>(result);
    expect(data.dryRun).toBe(true);
    expect(data.account).toBe(MASKED_ACCOUNT);
    expect(data.hasSession).toBe(true);
    expect(String(data.hint)).toMatch(/confirm/);
    expect(stub.forgetSession).not.toHaveBeenCalled();
  });

  it('previews without naming an account when nothing is configured', async () => {
    stub.describeConfig.mockReturnValue({
      accountId: null,
      deviceId: DEVICE_ID,
      configured: false,
      hasSession: false,
    });
    await mount();
    const data = parseToolResult<Record<string, unknown>>(await harness.callTool('kia_forget_session', {}));
    expect(data.dryRun).toBe(true);
    expect(data.account).toBeNull();
    expect(String(data.action)).toContain('the configured account');
    expect(stub.forgetSession).not.toHaveBeenCalled();
  });

  it('discards the stored token with confirm and points at the bootstrap', async () => {
    await mount();
    const result = await harness.callTool('kia_forget_session', { confirm: true });
    expect(result.isError).toBeFalsy();
    const data = parseToolResult<Record<string, unknown>>(result);
    expect(stub.forgetSession).toHaveBeenCalledTimes(1);
    expect(data.forgotten).toBe(true);
    expect(data.hadStoredSession).toBe(true);
    expect(data.account).toBe(MASKED_ACCOUNT);
    expect(String(data.nextStep)).toContain('kia_start_login');
    // Never echoes the credential it just discarded.
    expect(textOf(result)).not.toContain(RMTOKEN);
  });

  it('is a no-op that says so when there was nothing stored', async () => {
    stub.describeConfig.mockReturnValue({
      accountId: null,
      deviceId: DEVICE_ID,
      configured: false,
      hasSession: false,
    });
    await mount();
    const data = parseToolResult<Record<string, unknown>>(
      await harness.callTool('kia_forget_session', { confirm: true }),
    );
    expect(data.hadStoredSession).toBe(false);
    expect(data.account).toBeNull();
    expect(stub.forgetSession).toHaveBeenCalledTimes(1);
  });
});

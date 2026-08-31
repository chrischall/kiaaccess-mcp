import { describe, it, expect, vi } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import type { KiaClient } from '../src/client.js';

interface Result {
  ok: boolean;
  credential: { source: string | null; resolved: boolean; detail?: Record<string, unknown> };
  error?: { kind: string; message: string };
  hint: string;
}

function clientWith(
  config: { configured: boolean; hasSession: boolean; accountId?: string | null },
  listVehicles: () => Promise<unknown> = async () => [{ vehicleKey: 'v1' }],
) {
  return {
    describeConfig: () => ({
      accountId: config.accountId ?? 'someone@example.com',
      deviceId: 'device-1234567890',
      configured: config.configured,
      hasSession: config.hasSession,
    }),
    listVehicles,
  } as unknown as KiaClient;
}

async function call(client: KiaClient): Promise<Result> {
  const h = await createTestHarness((server) => registerHealthcheckTools(server, client));
  const res = await h.client.callTool({ name: 'kia_healthcheck', arguments: {} });
  await h.close?.();
  return parseToolResult<Result>(res as never);
}

describe('kia_healthcheck', () => {
  it('reports ok when Kia accepts the stored session', async () => {
    const r = await call(clientWith({ configured: true, hasSession: true }));
    expect(r.ok).toBe(true);
    expect(r.credential.resolved).toBe(true);
  });

  it('masks the account and never carries a session id or token', async () => {
    const r = await call(clientWith({ configured: true, hasSession: true }));
    expect(JSON.stringify(r)).not.toContain('someone@example.com');
    expect(JSON.stringify(r)).not.toContain('device-1234567890');
  });

  it('reports no_credential when nothing is configured', async () => {
    const r = await call(clientWith({ configured: false, hasSession: false }));
    expect(r.ok).toBe(false);
    expect(r.credential.source).toBeNull();
  });

  // The load-bearing one. Kia counts failed sign-ins and eventually enforces
  // reCAPTCHA on the account PERMANENTLY, so a healthcheck must never be able
  // to cause a sign-in attempt.
  it('REFUSES to probe when configured but not bootstrapped, and calls nothing', async () => {
    const listVehicles = vi.fn(async () => [{ vehicleKey: 'v1' }]);
    const r = await call(clientWith({ configured: true, hasSession: false }, listVehicles));
    expect(listVehicles).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('no_session');
    expect(r.credential.detail?.has_session).toBe(false);
    expect(r.hint).toMatch(/kia_start_login/);
    expect(r.hint).toMatch(/reCAPTCHA/);
  });

  it('classifies a rejected session and warns against retry loops', async () => {
    const r = await call(
      clientWith({ configured: true, hasSession: true }, async () => {
        throw Object.assign(new Error('Kia 401'), { status: 401 });
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.hint).toMatch(/reCAPTCHA/);
  });
});

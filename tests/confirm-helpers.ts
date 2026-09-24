/**
 * Helpers for the confirm-token flow every write tool goes through. A harness
 * created WITHOUT an elicitation handler is a client that cannot be prompted,
 * so under the default MCP_CONFIRM_MODE (ask-user) the first call returns a
 * preview plus a `confirmToken` and only a repeat call with it proceeds.
 */
import { expect } from 'vitest';
import { parseToolResult, type TestHarness } from '@chrischall/mcp-utils/test';
import type { CallToolResult } from '@modelcontextprotocol/server';

/** Phase 1's body. */
export interface ConfirmationRequired {
  status: 'confirmation-required';
  confirmed: false;
  dispatched: false;
  action: string;
  preview: Record<string, unknown>;
  confirmToken: string;
  expiresAt: string;
  ttlSeconds: number;
  instruction: string;
}

/** Call phase 1 and assert it asked for confirmation rather than acting. */
export async function requestConfirmation(
  harness: TestHarness,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ConfirmationRequired> {
  const result = await harness.callTool(name, args);
  expect(result.isError, `${name} phase 1 must not be an error`).toBeFalsy();
  const body = parseToolResult<ConfirmationRequired>(result);
  expect(body.status).toBe('confirmation-required');
  expect(body.dispatched).toBe(false);
  expect(typeof body.confirmToken).toBe('string');
  return body;
}

/** Phase 1's preview, for assertions that used to read the dry-run response. */
export async function previewOf(
  harness: TestHarness,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return (await requestConfirmation(harness, name, args)).preview;
}

/** Run both phases and return phase 2's result — the real write. */
export async function callConfirmed(
  harness: TestHarness,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  const { confirmToken } = await requestConfirmation(harness, name, args);
  return harness.callTool(name, { ...args, confirmToken });
}

/** The environment variables the confirm flow reads, snapshotted for restore. */
const CONFIRM_ENV = ['MCP_CONFIRM_MODE', 'MCP_CONFIRM_TTL_SECONDS', 'MCP_CONFIRM_SECRET'] as const;

export function snapshotConfirmEnv(): () => void {
  const saved = Object.fromEntries(CONFIRM_ENV.map((k) => [k, process.env[k]]));
  return () => {
    for (const key of CONFIRM_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
}

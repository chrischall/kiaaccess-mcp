/**
 * The fleet annotation meta-test: every tool decides what it is.
 *
 * `destructiveHint` DEFAULTS TO TRUE whenever `readOnlyHint` is false, so a
 * write that forgets to declare it is published as destructive and nothing
 * fails — a considered `false` and a forgotten one leave identical
 * annotations. This reads the annotations off the REGISTERED tools (the same
 * `TOOL_REGISTRARS` the server serves, under `KIA_WRITE_MODE=all` so the door
 * commands are included) rather than a hand-kept list.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import type { KiaClient } from '../src/client.js';
import { TOOL_REGISTRARS } from '../src/registrars.js';

const stubClient = {} as unknown as KiaClient;
const originalWriteMode = process.env.KIA_WRITE_MODE;

afterEach(() => {
  if (originalWriteMode === undefined) delete process.env.KIA_WRITE_MODE;
  else process.env.KIA_WRITE_MODE = originalWriteMode;
});

interface Ann {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
  openWorldHint?: unknown;
}

async function servedAnnotations(): Promise<Record<string, Ann | undefined>> {
  process.env.KIA_WRITE_MODE = 'all';
  const harness = await createTestHarness(async (server) => {
    for (const register of TOOL_REGISTRARS) await register(server, stubClient);
  });
  try {
    const { tools } = await harness.client.listTools();
    return Object.fromEntries(tools.map((t) => [t.name, t.annotations as Ann | undefined]));
  } finally {
    await harness.close();
  }
}

describe('every tool declares what it is', () => {
  it('covers the full surface (guards against a registrar being dropped)', async () => {
    expect(Object.keys(await servedAnnotations())).toHaveLength(18);
  });

  it('sets an explicit boolean readOnlyHint and openWorldHint on all of them', async () => {
    const missing = Object.entries(await servedAnnotations())
      .filter(([, a]) => typeof a?.readOnlyHint !== 'boolean' || typeof a?.openWorldHint !== 'boolean')
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('sets an explicit boolean destructiveHint on every write', async () => {
    const undeclared = Object.entries(await servedAnnotations())
      .filter(([, a]) => a?.readOnlyHint === false && typeof a?.destructiveHint !== 'boolean')
      .map(([name]) => name);
    expect(undeclared).toEqual([]);
  });

  it('never lets a read claim to be destructive', async () => {
    const contradictory = Object.entries(await servedAnnotations())
      .filter(([, a]) => a?.readOnlyHint === true && a?.destructiveHint === true)
      .map(([name]) => name);
    expect(contradictory).toEqual([]);
  });

  it('holds the destructive set to the tools with no inverse', async () => {
    // start_login / send_otp / verify_otp spend login attempts and one-time
    // codes on an account that escalates to reCAPTCHA; unlock_doors reduces
    // the car's security and leaves it reduced. Everything else has an
    // inverse in this tool set (lock/unlock aside, start/stop, set again,
    // re-login after forget_session). Growing this set should be a decision.
    const destructive = Object.entries(await servedAnnotations())
      .filter(([, a]) => a?.readOnlyHint === false && a?.destructiveHint === true)
      .map(([name]) => name)
      .sort();
    expect(destructive).toEqual(['kia_send_otp', 'kia_start_login', 'kia_unlock_doors', 'kia_verify_otp']);
  });

  it('marks only the no-network tools as closed-world', async () => {
    const closed = Object.entries(await servedAnnotations())
      .filter(([, a]) => a?.openWorldHint === false)
      .map(([name]) => name)
      .sort();
    expect(closed).toEqual(['kia_forget_session', 'kia_session_status']);
  });
});

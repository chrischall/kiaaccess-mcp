/**
 * `_meta.mint` context-group hints (mcp-host's context-groups contract), read
 * off the SERVED tool list — the same `TOOL_REGISTRARS` the entry point hands
 * to `runMcp`, under `KIA_WRITE_MODE=all` so the door commands are included.
 *
 * What this asserts is the contract's reviewer rules, not just this server's
 * table: every tool but the healthcheck is in the `home` group with a valid
 * intent; nothing is canonical (a car answers no "what's new / due / on"
 * question, so it ships lookup and write hints only); aliases are short,
 * lowercase spoken words; and no tool names a `subject` (vehicle keys are
 * session-scoped and cannot be listed at start without a sign-in — see
 * src/tools/hints.ts).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import type { KiaClient } from '../src/client.js';
import { TOOL_REGISTRARS } from '../src/registrars.js';

type Mint = {
  domain?: string;
  intent?: string;
  canonical?: boolean;
  subject?: string;
  when?: { start: string; end: string };
  aliases?: string[];
};
type Listed = {
  name: string;
  inputSchema: { properties?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean };
  _meta?: { mint?: Mint };
};

const stubClient = {} as unknown as KiaClient;
const originalWriteMode = process.env.KIA_WRITE_MODE;

afterEach(() => {
  if (originalWriteMode === undefined) delete process.env.KIA_WRITE_MODE;
  else process.env.KIA_WRITE_MODE = originalWriteMode;
});

async function served(): Promise<Listed[]> {
  process.env.KIA_WRITE_MODE = 'all';
  const harness = await createTestHarness(async (server) => {
    for (const register of TOOL_REGISTRARS) await register(server, stubClient);
  });
  try {
    const { tools } = await harness.client.listTools();
    return tools as Listed[];
  } finally {
    await harness.close();
  }
}

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];

/** The intent each tool answers. A new tool must be placed here deliberately. */
const EXPECTED_INTENT: Record<string, string> = {
  kia_session_status: 'lookup',
  kia_start_login: 'other',
  kia_send_otp: 'other',
  kia_verify_otp: 'other',
  kia_forget_session: 'other',
  kia_list_vehicles: 'lookup',
  kia_vehicle_status: 'lookup',
  kia_vehicle_location: 'lookup',
  kia_charge_targets: 'lookup',
  kia_refresh_status: 'other',
  kia_start_climate: 'turn-on-off',
  kia_stop_climate: 'turn-on-off',
  kia_start_charge: 'turn-on-off',
  kia_stop_charge: 'turn-on-off',
  kia_lock_doors: 'turn-on-off',
  kia_unlock_doors: 'turn-on-off',
  kia_set_charge_limits: 'change',
};

describe('_meta.mint context-group hints', () => {
  it('gives every served tool except the healthcheck a home-group hint in the contract’s shape', async () => {
    const tools = await served();
    expect(tools).toHaveLength(18);
    for (const t of tools) {
      if (t.name === 'kia_healthcheck') {
        // Registered by mcp-utils' registerCredentialHealthcheckTool, which takes no _meta.
        continue;
      }
      const m = t._meta?.mint;
      expect(m, t.name).toBeDefined();
      expect(Object.keys(m!).filter((k) => !KEYS.includes(k)), t.name).toEqual([]);
      expect(DOMAINS).toContain(m!.domain);
      expect(m!.domain, t.name).toBe('home');
      expect(INTENTS, t.name).toContain(m!.intent);
    }
  });

  it('places each tool under the intent that fits what it does', async () => {
    const tools = await served();
    const actual = Object.fromEntries(
      tools.filter((t) => t.name !== 'kia_healthcheck').map((t) => [t.name, t._meta?.mint?.intent]),
    );
    expect(actual).toEqual(EXPECTED_INTENT);
  });

  it('marks nothing canonical: a car answers no what’s-new / what’s-due / what’s-on question', async () => {
    const tools = await served();
    for (const t of tools) {
      const m = t._meta?.mint;
      expect(m?.canonical, t.name).toBeUndefined();
      expect(['whats-new', 'whats-due', 'whats-on'], t.name).not.toContain(m?.intent);
    }
    // Rule check that would bind if a canonical read were ever added: at most
    // one per intent, read-only only.
    const canonical = tools.filter((t) => t._meta?.mint?.canonical);
    for (const t of canonical) expect(t.annotations?.readOnlyHint, t.name).toBe(true);
    const intents = canonical.map((t) => t._meta!.mint!.intent);
    expect(new Set(intents).size).toBe(intents.length);
  });

  it('names no subject and no range: vehicles cannot be listed at start without a sign-in', async () => {
    for (const t of await served()) {
      expect(t._meta?.mint?.subject, t.name).toBeUndefined();
      expect(t._meta?.mint?.when, t.name).toBeUndefined();
    }
  });

  it('keeps aliases to the words a person says: ≤ 8, lowercase, ≤ 40 chars, never a tool name', async () => {
    const tools = await served();
    const names = tools.map((t) => t.name);
    let withAliases = 0;
    for (const t of tools) {
      const aliases = t._meta?.mint?.aliases;
      if (!aliases) continue;
      withAliases++;
      expect(aliases.length, t.name).toBeGreaterThan(0);
      expect(aliases.length, t.name).toBeLessThanOrEqual(8);
      for (const a of aliases) {
        expect(a.length, `${t.name}: ${a}`).toBeLessThanOrEqual(40);
        expect(a, t.name).toBe(a.toLowerCase());
        expect(names, t.name).not.toContain(a);
      }
    }
    expect(withAliases).toBeGreaterThan(0);
  });

  it('gives the switches the everyday words for what they reach', async () => {
    const tools = await served();
    const aliasesOf = (name: string) => tools.find((t) => t.name === name)?._meta?.mint?.aliases ?? [];
    expect(aliasesOf('kia_start_climate')).toContain('warm up the car');
    expect(aliasesOf('kia_start_charge')).toContain('charging');
    expect(aliasesOf('kia_lock_doors')).toContain('lock the car');
    expect(aliasesOf('kia_vehicle_location')).toContain('where is my car');
  });
});

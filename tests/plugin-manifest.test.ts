/**
 * Plugin manifest guard.
 *
 * Claude Code reads a plugin's MCP config from `mcpServers` in
 * `.claude-plugin/plugin.json`. Any other key (this repo used to say `mcp`) is
 * ignored at load time; it only appeared to work because `./.mcp.json` is the
 * default location anyway. Copies of the pattern elsewhere in the fleet used a
 * non-default path and broke their plugin installs, so pin the right key here.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const plugin = JSON.parse(
  readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'),
) as Record<string, unknown>;

describe('plugin.json', () => {
  it('declares its MCP config under the `mcpServers` key Claude Code reads', () => {
    expect(plugin).toHaveProperty('mcpServers');
  });

  it('has no `mcp` key, which Claude Code ignores', () => {
    expect(plugin).not.toHaveProperty('mcp');
  });

  it('points `mcpServers` at a file that exists', () => {
    expect(typeof plugin.mcpServers).toBe('string');
    expect(existsSync(join(ROOT, plugin.mcpServers as string))).toBe(true);
  });
});

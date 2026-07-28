/**
 * Release-please drift guard.
 *
 * Every file that carries a version must be listed in
 * `release-please-config.json`'s `extra-files`, or release-please silently
 * leaves it behind on the next release and the package ships advertising a
 * version it isn't. That has happened repeatedly in this fleet (resy-mcp
 * v0.2.0; opentable-mcp every release after v0.9.1), and it is invisible until
 * someone reads a manifest.
 *
 * So this test asserts the whole set at once: `package.json#version` is the
 * source of truth, and every other version literal in the repo — the
 * `x-release-please-version` marker in `src/`, plus each `extra-files`
 * jsonpath — must equal it. The `src/` half is the fleet-shared
 * `versionSyncTest`; the manifest half is spelled out below so a NEW
 * version-bearing file is a deliberate edit here rather than a silent omission.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { versionSyncTest } from '@chrischall/mcp-utils/test';
import { VERSION } from '../src/version.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8')) as T;
}

const pkg = readJson<{ version: string }>('package.json');

describe('version sync', () => {
  it('has a semver version in package.json to compare against', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/);
  });

  it('every `x-release-please-version` annotation in src/ matches package.json', () => {
    // Covers src/version.ts, the single source of truth every module imports.
    const mismatches = versionSyncTest({
      srcDir: join(ROOT, 'src'),
      pkgPath: join(ROOT, 'package.json'),
    });
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });

  it('exports the package version as VERSION — what the server reports to the host', () => {
    // src/index.ts advertises this value over MCP, so a drift here is what a
    // host would actually display.
    expect(VERSION).toBe(pkg.version);
  });

  it('src/version.ts carries the marker so release-please keeps bumping it', () => {
    const source = readFileSync(join(ROOT, 'src', 'version.ts'), 'utf8');
    expect(source).toMatch(/export const VERSION = '[^']+';\s*\/\/ x-release-please-version/);
  });

  it('every versioned manifest matches package.json', () => {
    const manifest = readJson<{ version: string }>('manifest.json');
    const server = readJson<{ version: string; packages: { version: string }[] }>('server.json');
    const plugin = readJson<{ version: string }>('.claude-plugin/plugin.json');
    const marketplace = readJson<{
      metadata: { version: string };
      plugins: { version: string }[];
    }>('.claude-plugin/marketplace.json');

    // One assertion per release-please `extra-files` jsonpath, so a failure
    // names the file that drifted.
    const found = {
      'manifest.json $.version': manifest.version,
      'server.json $.version': server.version,
      ...Object.fromEntries(
        server.packages.map((p, i) => [`server.json $.packages[${i}].version`, p.version]),
      ),
      '.claude-plugin/plugin.json $.version': plugin.version,
      '.claude-plugin/marketplace.json $.metadata.version': marketplace.metadata.version,
      ...Object.fromEntries(
        marketplace.plugins.map((p, i) => [`.claude-plugin/marketplace.json $.plugins[${i}].version`, p.version]),
      ),
    };
    const expected = Object.fromEntries(Object.keys(found).map((key) => [key, pkg.version]));
    expect(found).toEqual(expected);
  });

  it('registers every versioned file in release-please extra-files', () => {
    const config = readJson<{
      packages: Record<string, { 'extra-files': (string | { path: string; jsonpath?: string })[] }>;
    }>('release-please-config.json');
    const entries = config.packages['.']['extra-files'].map((entry) =>
      typeof entry === 'string' ? entry : `${entry.path}${entry.jsonpath ? ` ${entry.jsonpath}` : ''}`,
    );
    // Miss one of these and the file below silently stops being bumped.
    expect(entries).toEqual(
      expect.arrayContaining([
        'src/version.ts',
        'manifest.json $.version',
        'server.json $.version',
        'server.json $.packages[*].version',
        '.claude-plugin/plugin.json $.version',
        '.claude-plugin/marketplace.json $.plugins[*].version',
        '.claude-plugin/marketplace.json $.metadata.version',
      ]),
    );
  });
});

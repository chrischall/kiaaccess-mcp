import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * The Workers-runtime suite (`npm run worker:test`).
 *
 * `tests/worker*.test.ts` runs inside real workerd (via Miniflare) against
 * `wrangler.jsonc`'s bindings — the `KiaMcpAgent` Durable Object and `OAUTH_KV`.
 * That is not redundant with the Node suite: the two runtimes disagree in ways
 * that a Node test and a `wrangler deploy --dry-run` both miss, most notably a
 * detached `globalThis.fetch` (which throws `Illegal invocation` on every
 * request in workerd and never in Node). The "workerd runtime traps" block in
 * `tests/worker.test.ts` exists specifically to catch that.
 *
 * Kept entirely separate from `vitest.config.ts` / `npm test`, which runs under
 * Node and excludes these files.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
  test: {
    include: ['tests/worker*.test.ts'],
  },
});

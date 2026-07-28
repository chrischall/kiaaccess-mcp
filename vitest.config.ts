import { configDefaults, defineConfig } from 'vitest/config';

// Coverage-enforced: `npm run test:coverage` (wired into CI) fails the build on
// any regression below 100%. Genuinely-unreachable defensive branches are
// excluded inline with `/* v8 ignore next */`. The bare `npm test` stays
// coverage-free for fast local iteration.
export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      // Nested checkouts of this same repo — agent worktrees under
      // `.claude/worktrees/<branch>/`. The default `include` is recursive, so
      // without this every test file gets collected twice.
      '**/.claude/**',
      '**/worktrees/**',
      // The hosted-connector suites run ONLY under the Workers runtime pool
      // (`vitest.workers.config.ts` / `npm run worker:test`), which supplies the
      // virtual `cloudflare:test` and `cloudflare:workers` modules they and
      // `src/worker.ts` depend on. They cannot load under Node at all.
      'tests/worker*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts', // stdio entry point — not unit-testable
        // Worker-only entry point: imports @chrischall/mcp-connector →
        // agents/mcp → cloudflare:workers, none of which resolve under the node
        // pool. It is exercised by the Workers pool suite instead
        // (tests/worker.test.ts via `npm run worker:test`).
        'src/worker.ts',
      ],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});

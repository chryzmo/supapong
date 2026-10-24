import { execSync } from 'node:child_process';
import { defineConfig } from 'vitest/config';

/** The commit being built, for feedback reports: CI's, or the local checkout's. */
function appVersion(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion()),
  },
  server: {
    // Match auth.site_url in supabase/config.toml.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  test: {
    projects: [
      {
        // Pure code: no network, no DOM.  `npm test`
        test: {
          name: 'unit',
          // Plus the Edge Functions' pure modules, tested alongside them.
          include: ['src/**/*.test.ts', 'supabase/functions/**/*.test.ts'],
        },
      },
      {
        // App code against the local Supabase stack.  `npm run test:integration`
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          globalSetup: ['tests/integration/globalSetup.ts'],
          // One file at a time: the lobby subscription sees every room change,
          // so rooms created by other files would skew its counts.
          fileParallelism: false,
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
    ],
  },
});

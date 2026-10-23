import { defineConfig } from 'vitest/config';

export default defineConfig({
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
          include: ['src/**/*.test.ts'],
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

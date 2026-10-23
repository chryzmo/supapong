import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: {
    // Match auth.site_url in supabase/config.toml.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});

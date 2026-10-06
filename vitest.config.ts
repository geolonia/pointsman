import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // Only for the KvProfileStore tests.
      miniflare: { kvNamespaces: ['TEST_KV'] },
    }),
  ],
  test: {
    include: ['test/worker/**/*.test.ts'],
  },
});

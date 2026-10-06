import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Only for the KvProfileStore tests.
        kvNamespaces: ['TEST_KV'],
        // Applied to the DB binding by test/worker/apply-migrations.ts.
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
          CALLBACK_SECRET: 'test-callback-secret',
        },
      },
    })),
  ],
  test: {
    include: ['test/worker/**/*.test.ts'],
    setupFiles: ['./test/worker/apply-migrations.ts'],
  },
});

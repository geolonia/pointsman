import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // TEST_KV: KvProfileStore tests; TEST_OAUTH_KV: OAuth tests, which pass it as OAUTH_KV (test/worker/oauth.test.ts).
        kvNamespaces: ['TEST_KV', 'TEST_OAUTH_KV'],
        // Applied to the DB binding by test/worker/apply-migrations.ts.
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
          CALLBACK_SECRET: 'test-callback-secret',
        },
      },
    })),
  ],
  test: {
    include: ['test/worker/**/*.test.ts', 'test/bridge/**/*.test.ts'],
    setupFiles: ['./test/worker/apply-migrations.ts'],
  },
});

import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

type Migrations = Parameters<typeof applyD1Migrations>[1];
const { DB, TEST_MIGRATIONS } = env as unknown as { DB: D1Database; TEST_MIGRATIONS: Migrations };
await applyD1Migrations(DB, TEST_MIGRATIONS);

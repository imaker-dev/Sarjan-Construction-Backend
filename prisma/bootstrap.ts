// One-time operator bootstrap — initialize the platform: sentinel platform
// company + PLATFORM_ADMIN role + first Platform Admin. Run manually:
//   npm run db:bootstrap
// Credentials come from env only (BOOTSTRAP_ADMIN_*), never CLI args, never
// logged. Idempotent: an existing platform company reports ALREADY_COMPLETE.
// Existing customer companies are preserved untouched.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { bootstrapPlatform } from '../src/modules/setup/bootstrap.js';

const required = (key: string): string => {
  const v = process.env[key];
  if (v === undefined || v.trim() === '') {
    console.error(`Missing required env ${key}`);
    process.exit(1);
  }
  return v;
};

const DATABASE_URL = required('DATABASE_URL');
const input = {
  adminLoginId: required('BOOTSTRAP_ADMIN_LOGIN_ID').toLowerCase().trim(),
  adminPassword: required('BOOTSTRAP_ADMIN_PASSWORD'),
};

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

prisma
  .$transaction((tx) => bootstrapPlatform(tx, input))
  .then((r) => {
    console.log(`bootstrap ${r.status} — company ${r.companyId}`);
  })
  .catch((err: unknown) => {
    console.error('bootstrap failed:', err instanceof Error ? err.message : 'unknown error');
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect().then(() => {
      void pool.end();
    });
  });

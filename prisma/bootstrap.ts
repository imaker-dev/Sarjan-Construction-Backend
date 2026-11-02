// One-time operator bootstrap — run manually: `npm run db:bootstrap`.
// Credentials come from env only (BOOTSTRAP_OWNER_*), never CLI args, and are
// never printed. Idempotent: a completed bootstrap reports ALREADY_COMPLETE.
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { bootstrapOrganization } from '../src/modules/setup/bootstrap.js';

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
  companyCode: required('BOOTSTRAP_COMPANY_CODE').toUpperCase().trim(),
  companyName: required('BOOTSTRAP_COMPANY_NAME').trim(),
  ownerLoginId: required('BOOTSTRAP_OWNER_LOGIN_ID').toLowerCase().trim(),
  ownerPassword: required('BOOTSTRAP_OWNER_PASSWORD'),
};

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

prisma
  .$transaction((tx) => bootstrapOrganization(tx, input))
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

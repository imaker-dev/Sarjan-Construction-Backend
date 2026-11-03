// Idempotent owner-permission reconcile — run manually after catalogue adds:
//   npm run db:reconcile
// Adds only the two EMPLOYEE_* grants to COMPANY_OWNER system roles.
// Never removes or broadens other grants; audits only real changes.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { reconcileHoAdminRoles, reconcileOwnerPermissions } from '../src/modules/setup/reconcile.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (DATABASE_URL === undefined || DATABASE_URL.trim() === '') {
  console.error('Missing required env DATABASE_URL');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

prisma
  .$transaction((tx) => reconcileOwnerPermissions(tx).then(async (a) => a + (await reconcileHoAdminRoles(tx))))
  .then((changed) => {
    console.log(`reconcile complete — ${changed} grant(s) added`);
  })
  .catch((err: unknown) => {
    console.error('reconcile failed:', err instanceof Error ? err.message : 'unknown error');
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect().then(() => {
      void pool.end();
    });
  });

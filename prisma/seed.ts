// Idempotent permission-catalogue seed. Upserts only — unknown client-created
// permission rows are never deleted (rule.md §7). No users, roles, or demo
// data are created here; this file must stay production-safe.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PERMISSIONS } from '../src/modules/access-control/catalogue.js';

import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Missing required env DATABASE_URL');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  for (const key of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key },
      update: {},
      create: { key },
    });
  }
  console.log(`Seeded ${PERMISSIONS.length} permission keys (idempotent).`);
}

main()
  .catch((err: unknown) => {
    console.error('Seed failed:', err instanceof Error ? err.message : 'unknown error');
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect().then(() => {
      void pool.end();
    });
  });

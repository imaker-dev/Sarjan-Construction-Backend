import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Prisma 7: connection URL and seed live here — the schema datasource is
// provider-only, and package.json#prisma is removed.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: env('DATABASE_URL') },
  migrations: { seed: 'tsx prisma/seed.ts' },
});

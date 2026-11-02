import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { ComplianceService } from '../../src/modules/compliance/service.js';
import { resolveTestDbUrl } from './test-db-url.js';
import type { ActorContext } from '../../src/modules/organization/types.js';

const url = resolveTestDbUrl(process.env.TEST_DATABASE_URL);
const run = url === null ? it.skip : it;
let prisma: PrismaClient | undefined;
let pool: pg.Pool | undefined;
let svc: ComplianceService;
const actor: ActorContext = { actorId: 'adm', actorType: 'USER' };
let companyId = '';
const ids: string[] = [];

beforeAll(async () => {
  if (url === null) return;
  pool = new pg.Pool({ connectionString: url });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  svc = new ComplianceService(prisma);
  const c = await prisma.company.create({ data: { code: 'CMP', name: 'Compliance Co' } });
  companyId = c.id;
});
afterAll(async () => {
  if (prisma !== undefined && pool !== undefined) {
    await prisma.auditLog.deleteMany({ where: { companyId } });
    await prisma.complianceRecord.deleteMany({ where: { companyId } });
    await prisma.company.deleteMany({ where: { id: companyId } });
    await prisma.$disconnect();
    await pool.end();
  }
});

describe('compliance records (real PostgreSQL)', () => {
  run('create + list + multiple GSTINs + duplicate rejected', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const g1 = await svc.create(actor, companyId, {
      category: 'GST',
      identifier: '29ABCDE1234F1Z5',
      jurisdiction: 'KA',
    });
    ids.push(g1.id);
    // Same category, different GSTIN — allowed (multi-state registrations).
    const g2 = await svc.create(actor, companyId, {
      category: 'GST',
      identifier: '27ABCDE1234F1Z6',
      jurisdiction: 'MH',
    });
    ids.push(g2.id);
    // Duplicate identifier in same company+category → 409.
    await expect(
      svc.create(actor, companyId, {
        category: 'GST',
        identifier: '29ABCDE1234F1Z5',
      }),
    ).rejects.toThrow('already registered');
    expect((await svc.list(companyId)).length).toBe(2);
    // Identifier masked in audit changedFields.
    const audits = await prisma.auditLog.findMany({
      where: { companyId, action: 'COMPLIANCE_RECORD_CREATED' },
    });
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits.map((a) => a.changedFields))).not.toContain('29ABCDE1234F1Z5');
  });

  run('update optimistic version + status transition + archive', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const rec = await svc.create(actor, companyId, {
      category: 'EPFO',
      identifier: 'EP-123',
    });
    ids.push(rec.id);
    const updated = await svc.update(actor, companyId, rec.id, { jurisdiction: 'KA' }, 0);
    expect(updated.version).toBe(1);
    // Stale version → 409.
    await expect(svc.update(actor, companyId, rec.id, { jurisdiction: 'TN' }, 0)).rejects.toThrow(
      'record changed',
    );
    const active = await svc.transition(actor, companyId, rec.id, 'ACTIVE', 1);
    expect(active.status).toBe('ACTIVE');
    const archived = await svc.transition(actor, companyId, rec.id, 'ARCHIVED', 2);
    expect(archived.status).toBe('ARCHIVED');
    expect((await svc.list(companyId)).every((r) => r.status !== 'ARCHIVED')).toBe(true);
  });
});

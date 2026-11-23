import { describe, it, expect, beforeEach } from 'vitest';
import { AuditService } from '../../../src/modules/audit/service.js';
import type { ActorContext } from '../../../src/modules/organization/types.js';
import type { PrismaClient } from '@prisma/client';
import { DomainValidationError, NotFoundError } from '../../../src/common/errors/app-error.js';

// Fakes for AuditService.listScopedActivity — scope is proven only from the
// entity tables below; anything unlisted is unresolvable and must be excluded.

const companyId = '00000000-0000-4000-8000-0000000000c0';
const otherCompanyId = '00000000-0000-4000-8000-0000000000c9';
const projectA = '00000000-0000-4000-8000-0000000000a1';
const projectB = '00000000-0000-4000-8000-0000000000a2';
const site1 = '00000000-0000-4000-8000-000000000051';
const site2 = '00000000-0000-4000-8000-000000000052';
const deptA = '00000000-0000-4000-8000-0000000000d1';
const deptS1 = '00000000-0000-4000-8000-0000000000d2';
const opA = '00000000-0000-4000-8000-0000000000e1';
const wiA = '00000000-0000-4000-8000-0000000000f1';
const taskA = '00000000-0000-4000-8000-0000000000f2';
const session1 = '00000000-0000-4000-8000-000000000071';
const break1 = '00000000-0000-4000-8000-000000000072';
const membershipA = '00000000-0000-4000-8000-000000000061';
const siteDoc1 = '00000000-0000-4000-8000-000000000081';
const actor: ActorContext = { actorId: '00000000-0000-4000-8000-000000000099', actorType: 'USER' };

interface AuditRow {
  id: string;
  eventKey: string;
  action: string;
  entityType: string;
  entityId: string;
  companyId: string;
  actorId: string;
  actorType: string;
  correlationId: string | null;
  occurredAt: Date;
  statusBefore: string | null;
  statusAfter: string | null;
  changedFields: unknown;
  metadata: unknown;
}

let logSeq = 0;
const log = (entityType: string, entityId: string, extra: Partial<AuditRow> = {}): AuditRow => ({
  id: `00000000-0000-4000-8000-${String(1 + logSeq++).padStart(12, '0')}`,
  eventKey: `ev-${logSeq}`,
  action: extra.action ?? `${entityType}_CHANGED`,
  entityType,
  entityId,
  companyId,
  actorId: actor.actorId,
  actorType: 'USER',
  correlationId: null,
  occurredAt: new Date(1_700_000_000_000 + logSeq * 1000),
  statusBefore: null,
  statusAfter: null,
  changedFields: null,
  metadata: null,
  ...extra,
});

let auditLogs: AuditRow[] = [];
let authorized = true;
const authCalls: { key: string; target: { scopeType: string; scopeId: string } }[] = [];

const tables: Record<string, { id: string; companyId?: string; [k: string]: unknown }[]> = {
  project: [
    { id: projectA, companyId },
    { id: projectB, companyId },
    { id: '00000000-0000-4000-8000-0000000000ff', companyId: otherCompanyId },
  ],
  site: [
    { id: site1, companyId, projectId: projectA },
    { id: site2, companyId, projectId: projectB },
  ],
  department: [
    { id: deptA, companyId, projectId: projectA, siteId: null },
    { id: deptS1, companyId, projectId: null, siteId: site1 },
  ],
  departmentMembership: [{ id: membershipA, companyId, departmentId: deptA }],
  operation: [{ id: opA, companyId, departmentId: deptA }],
  workflowInstance: [{ id: wiA, companyId, operationId: opA }],
  approvalTask: [{ id: taskA, companyId, workflowInstanceId: wiA }],
  attendanceSession: [{ id: session1, companyId, siteId: site1 }],
  attendanceBreak: [{ id: break1, companyId, sessionId: session1 }],
  siteDocument: [{ id: siteDoc1, companyId, siteId: site1 }],
};

const mkTable = (rows: { id: string; companyId?: string }[]) => ({
  findMany: async ({ where }: { where: { id?: { in: string[] }; companyId?: string } }) =>
    rows.filter(
      (r) =>
        (where.id === undefined || where.id.in.includes(r.id)) &&
        (where.companyId === undefined || r.companyId === where.companyId),
    ),
  findFirst: async ({ where }: { where: { id: string; companyId?: string } }) =>
    rows.find(
      (r) =>
        r.id === where.id && (where.companyId === undefined || r.companyId === where.companyId),
    ) ?? null,
});

function makeService(): AuditService {
  const auditLogTable = {
    findMany: async ({
      where,
      take,
    }: {
      where: {
        companyId: string;
        entityType?: string;
        action?: string;
        occurredAt?: { gte?: Date; lte?: Date };
        OR?: [{ occurredAt: { lt: Date } }, { occurredAt: Date; id: { lt: string } }];
      };
      take: number;
    }) => {
      let out = auditLogs.filter((r) => r.companyId === where.companyId);
      if (where.entityType) out = out.filter((r) => r.entityType === where.entityType);
      if (where.action) out = out.filter((r) => r.action === where.action);
      const gte = where.occurredAt?.gte;
      const lte = where.occurredAt?.lte;
      if (gte !== undefined) out = out.filter((r) => r.occurredAt >= gte);
      if (lte !== undefined) out = out.filter((r) => r.occurredAt <= lte);
      if (where.OR) {
        const [ltT, eqT] = where.OR;
        out = out.filter(
          (r) =>
            r.occurredAt < ltT.occurredAt.lt ||
            (r.occurredAt.getTime() === ltT.occurredAt.lt.getTime() && r.id < eqT.id.lt),
        );
      }
      out.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || (a.id < b.id ? 1 : -1));
      return out.slice(0, take);
    },
  };
  const prisma = new Proxy(
    { auditLog: auditLogTable },
    {
      get: (target, prop) =>
        prop in target
          ? (target as Record<string | symbol, unknown>)[prop]
          : mkTable(tables[prop as string] ?? []),
    },
  ) as unknown as PrismaClient;

  const authorizer = {
    assertPermission: async (
      _pid: string,
      key: string,
      target: { scopeType: string; scopeId: string },
    ) => {
      authCalls.push({ key, target });
      if (!authorized) throw new Error('Permission denied');
    },
  };
  return new AuditService(prisma, authorizer);
}

let service: AuditService;

beforeEach(() => {
  logSeq = 0;
  auditLogs = [];
  authorized = true;
  authCalls.length = 0;
  service = makeService();
});

describe('AuditService.listScopedActivity', () => {
  it('project feed includes project + child-site events; excludes sibling, company-wide, security and unresolvable types', async () => {
    auditLogs = [
      log('PROJECT', projectA),
      log('SITE', site1), // child site of project A
      log('SITE', site2), // sibling — project B
      log('DEPARTMENT', deptA),
      log('DEPARTMENT_MEMBERSHIP', membershipA), // hop → deptA
      log('APPROVAL_TASK', taskA), // hop → WI → op → deptA
      log('ATTENDANCE_SESSION', session1), // site1
      log('ATTENDANCE_BREAK', break1), // session → site1
      log('SITE_DOCUMENT', siteDoc1), // site1
      log('SITE', '00000000-0000-4000-8000-0000000000ee'), // entity gone → excluded
      log('PRINCIPAL', actor.actorId), // security-sensitive — no resolver
      log('EMPLOYEE', '00000000-0000-4000-8000-0000000000dd'), // unresolvable
      log('COMPANY', companyId), // company-wide
      log('LEAVE_REQUEST', '00000000-0000-4000-8000-0000000000cc'), // unresolvable
    ];
    const res = await service.listScopedActivity(
      actor,
      companyId,
      { scopeType: 'PROJECT', scopeId: projectA },
      {},
    );
    const types = res.items.map((i) => `${i.entityType}:${i.entityId}`);
    expect(types).toContain(`PROJECT:${projectA}`);
    expect(types).toContain(`SITE:${site1}`);
    expect(types).toContain(`DEPARTMENT:${deptA}`);
    expect(types).toContain(`DEPARTMENT_MEMBERSHIP:${membershipA}`);
    expect(types).toContain(`APPROVAL_TASK:${taskA}`);
    expect(types).toContain(`ATTENDANCE_SESSION:${session1}`);
    expect(types).toContain(`ATTENDANCE_BREAK:${break1}`);
    expect(types).toContain(`SITE_DOCUMENT:${siteDoc1}`);
    expect(types).toHaveLength(8);
    // scope attribution is present on every returned row
    expect(res.items.every((i) => i.scope.projectId === projectA)).toBe(true);
    expect(authCalls[0]?.key).toBe('ORG_PROJECT_READ');
    expect(authCalls[0]?.target.scopeType).toBe('PROJECT');
    expect(authCalls[0]?.target.scopeId).toBe(projectA);
  });

  it('site feed covers only that site', async () => {
    auditLogs = [
      log('SITE', site1),
      log('SITE', site2),
      log('PROJECT', projectA), // project-level — not a site event
      log('DEPARTMENT', deptS1),
      log('DEPARTMENT', deptA),
      log('ATTENDANCE_SESSION', session1),
    ];
    const res = await service.listScopedActivity(
      actor,
      companyId,
      { scopeType: 'SITE', scopeId: site1 },
      {},
    );
    const ids = res.items.map((i) => i.entityId);
    expect(ids.sort()).toEqual([deptS1, session1, site1].sort());
    expect(res.items.every((i) => i.scope.siteId === site1)).toBe(true);
    expect(authCalls[0]?.key).toBe('ORG_SITE_READ');
  });

  it('rejects cross-company and missing scopes with not-found', async () => {
    await expect(
      service.listScopedActivity(
        actor,
        companyId,
        { scopeType: 'PROJECT', scopeId: '00000000-0000-4000-8000-0000000000ff' },
        {},
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.listScopedActivity(
        actor,
        companyId,
        { scopeType: 'SITE', scopeId: '00000000-0000-4000-8000-0000000000fe' },
        {},
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('propagates authorization failure', async () => {
    authorized = false;
    await expect(
      service.listScopedActivity(actor, companyId, { scopeType: 'PROJECT', scopeId: projectA }, {}),
    ).rejects.toThrow('Permission denied');
  });

  it('redacts sensitive changedFields, drops metadata, and hides loginId', async () => {
    auditLogs = [
      log('PROJECT', projectA, {
        changedFields: {
          name: { before: 'A', after: 'B' },
          landParcelId: { before: null, after: '00000000-0000-4000-8000-0000000000e9' },
          bankAccountNo: { before: '111', after: '222' },
          panNumber: { before: 'X', after: 'Y' },
          internalNotes: { before: 'q', after: 'r' }, // harmless but not allowlisted → hidden
        },
        metadata: { password: 'should-never-leak' },
      }),
    ];
    const res = await service.listScopedActivity(
      actor,
      companyId,
      { scopeType: 'PROJECT', scopeId: projectA },
      {},
    );
    const item = res.items[0];
    expect(item).toBeDefined();
    expect(item?.changedFields?.name).toEqual({ before: 'A', after: 'B' });
    expect(item?.changedFields?.bankAccountNo).toEqual({
      before: '[REDACTED]',
      after: '[REDACTED]',
    });
    expect(item?.changedFields?.panNumber).toEqual({
      before: '[REDACTED]',
      after: '[REDACTED]',
    });
    // Structural keys pass through; everything else fails closed.
    expect(item?.changedFields?.landParcelId).toEqual({
      before: null,
      after: '00000000-0000-4000-8000-0000000000e9',
    });
    expect(item?.changedFields?.internalNotes).toEqual({
      before: '[REDACTED]',
      after: '[REDACTED]',
    });
    expect(item).not.toHaveProperty('metadata');
    expect(item?.actor).not.toHaveProperty('loginId');
  });

  it('applies entityType/action/date filters and rejects bad ranges and cursors', async () => {
    const t = (s: number) => new Date(1_700_000_000_000 + s * 1000);
    auditLogs = [
      log('PROJECT', projectA, { occurredAt: t(1), action: 'ORG_PROJECT_CREATED' }),
      log('SITE', site1, { occurredAt: t(2), action: 'ORG_SITE_CREATED' }),
      log('PROJECT', projectA, { occurredAt: t(3), action: 'ORG_PROJECT_UPDATED' }),
    ];
    const byType = await service.listScopedActivity(
      actor,
      companyId,
      { scopeType: 'PROJECT', scopeId: projectA },
      { entityType: 'PROJECT' },
    );
    expect(byType.items.map((i) => i.action)).toEqual([
      'ORG_PROJECT_UPDATED',
      'ORG_PROJECT_CREATED',
    ]);
    const byAction = await service.listScopedActivity(
      actor,
      companyId,
      { scopeType: 'PROJECT', scopeId: projectA },
      { action: 'ORG_PROJECT_CREATED' },
    );
    expect(byAction.items).toHaveLength(1);
    const byRange = await service.listScopedActivity(
      actor,
      companyId,
      { scopeType: 'PROJECT', scopeId: projectA },
      { from: t(2).toISOString(), to: t(2).toISOString() },
    );
    expect(byRange.items.map((i) => i.entityId)).toEqual([site1]);
    await expect(
      service.listScopedActivity(
        actor,
        companyId,
        { scopeType: 'PROJECT', scopeId: projectA },
        { from: t(3).toISOString(), to: t(1).toISOString() },
      ),
    ).rejects.toBeInstanceOf(DomainValidationError);
    await expect(
      service.listScopedActivity(
        actor,
        companyId,
        { scopeType: 'PROJECT', scopeId: projectA },
        { cursor: 'not-a-cursor' },
      ),
    ).rejects.toBeInstanceOf(DomainValidationError);
  });

  it('keyset cursor paginates without duplication or loss', async () => {
    // 6 site events in one project feed, page size 2 → 3 pages.
    auditLogs = Array.from({ length: 6 }, (_, i) =>
      log('SITE', site1, { occurredAt: new Date(1_700_000_000_000 + i * 1000) }),
    );
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await service.listScopedActivity(
        actor,
        companyId,
        { scopeType: 'PROJECT', scopeId: projectA },
        { limit: 2, ...(cursor !== undefined ? { cursor } : {}) },
      );
      seen.push(...res.items.map((i) => i.id));
      if (res.nextCursor === null) break;
      cursor = res.nextCursor;
    }
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    // descending occurredAt order preserved across pages
    const times = seen.map((id) => auditLogs.find((r) => r.id === id)?.occurredAt.getTime() ?? -1);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});

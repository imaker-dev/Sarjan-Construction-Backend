import { describe, it, expect, beforeEach } from 'vitest';
import { AuditService, recordCompanyAuditLog } from '../../../src/modules/audit/service.js';
import type { ActorContext } from '../../../src/modules/organization/types.js';
import type { PrismaClient } from '@prisma/client';
import { NotFoundError } from '../../../src/common/errors/app-error.js';

interface FakeAuditRow {
  id: string;
  eventKey: string;
  action: string;
  entityType: string;
  entityId: string;
  companyId: string | null;
  actorId: string;
  actorType: string;
  correlationId: string | null;
  occurredAt: Date;
  statusBefore: string | null;
  statusAfter: string | null;
  changedFields: unknown;
  metadata: unknown;
}

interface FakePrincipalRow {
  id: string;
  type: 'USER' | 'SYSTEM' | 'SERVICE';
  loginId: string | null;
  employees: {
    displayName: string;
    employeeCode: string;
  }[];
}

const actor: ActorContext = { actorId: 'principal-1', actorType: 'USER' };
const companyId = 'company-1';

describe('AuditService', () => {
  let auditLogs: FakeAuditRow[];
  let principals: FakePrincipalRow[];
  let authorized: boolean;
  let service: AuditService;

  beforeEach(() => {
    auditLogs = [];
    principals = [
      {
        id: 'principal-1',
        type: 'USER',
        loginId: 'admin@imaker.com',
        employees: [
          {
            displayName: 'iMaker Admin',
            employeeCode: 'ADM-001',
          },
        ],
      },
    ];
    authorized = true;

    const fakePrisma = {
      auditLog: {
        create: async ({ data }: { data: Record<string, string | null | undefined | object> }) => {
          const row: FakeAuditRow = {
            id: `log-${String(auditLogs.length + 1)}`,
            eventKey: (data.eventKey as string | undefined) ?? '',
            action: (data.action as string | undefined) ?? '',
            entityType: (data.entityType as string | undefined) ?? '',
            entityId: (data.entityId as string | undefined) ?? '',
            companyId: (data.companyId as string | undefined) ?? null,
            actorId: (data.actorId as string | undefined) ?? '',
            actorType: (data.actorType as string | undefined) ?? '',
            correlationId: (data.correlationId as string | undefined) ?? null,
            occurredAt: new Date(),
            statusBefore: (data.statusBefore as string | undefined) ?? null,
            statusAfter: (data.statusAfter as string | undefined) ?? null,
            changedFields: data.changedFields ?? null,
            metadata: data.metadata ?? null,
          };
          auditLogs.push(row);
          return row;
        },
        findMany: async ({
          where,
          take,
        }: {
          where: { companyId?: string; entityType?: string; action?: string };
          take: number;
        }) => {
          let filtered = auditLogs.filter((r) => {
            if (where.companyId && r.companyId !== where.companyId) return false;
            if (where.entityType && r.entityType !== where.entityType) return false;
            if (where.action && r.action !== where.action) return false;
            return true;
          });
          if (take) filtered = filtered.slice(0, take);
          return filtered;
        },
        findFirst: async ({ where }: { where: { id: string; companyId: string } }) => {
          return (
            auditLogs.find((r) => r.id === where.id && r.companyId === where.companyId) ?? null
          );
        },
      },
      principal: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
          return principals.filter((p) => where.id.in.includes(p.id));
        },
      },
    } as unknown as PrismaClient;

    const authorizer = {
      assertPermission: async () => {
        if (!authorized) throw new Error('Permission denied');
      },
    };

    service = new AuditService(fakePrisma, authorizer);
  });

  it('records an audit log via recordCompanyLog and standalone recordCompanyAuditLog', async () => {
    const id1 = await service.recordCompanyLog({
      companyId,
      actor,
      action: 'EMPLOYEE_CREATED',
      entityType: 'EMPLOYEE',
      entityId: 'emp-123',
      changedFields: { displayName: { before: null, after: 'John Doe' } },
    });
    expect(id1).toBe('log-1');
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0]?.action).toBe('EMPLOYEE_CREATED');
    expect(auditLogs[0]?.companyId).toBe(companyId);
    expect(auditLogs[0]?.actorId).toBe('principal-1');

    const id2 = await recordCompanyAuditLog(
      {
        auditLog: {
          create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'log-2', ...data }),
        },
      } as never,
      {
        companyId,
        actor,
        action: 'DEPARTMENT_UPDATED',
        entityType: 'DEPARTMENT',
        entityId: 'dept-456',
      },
    );
    expect(id2).toBe('log-2');
  });

  it('lists company audit logs with actor display details resolved', async () => {
    await service.recordCompanyLog({
      companyId,
      actor,
      action: 'ORG_PROJECT_CREATED',
      entityType: 'PROJECT',
      entityId: 'proj-1',
    });

    const result = await service.listCompanyLogs(actor, companyId, { limit: 10 });
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item?.action).toBe('ORG_PROJECT_CREATED');
    expect(item?.actor.displayName).toBe('iMaker Admin');
    expect(item?.actor.loginId).toBe('admin@imaker.com');
    expect(item?.actor.employeeCode).toBe('ADM-001');
  });

  it('filters company audit logs by entityType and action', async () => {
    await service.recordCompanyLog({
      companyId,
      actor,
      action: 'EMPLOYEE_CREATED',
      entityType: 'EMPLOYEE',
      entityId: 'emp-1',
    });
    await service.recordCompanyLog({
      companyId,
      actor,
      action: 'DEPARTMENT_CREATED',
      entityType: 'DEPARTMENT',
      entityId: 'dept-1',
    });

    const employeesOnly = await service.listCompanyLogs(actor, companyId, {
      entityType: 'EMPLOYEE',
    });
    expect(employeesOnly.items).toHaveLength(1);
    expect(employeesOnly.items[0]?.entityType).toBe('EMPLOYEE');
  });

  it('fetches a single audit log by id', async () => {
    await service.recordCompanyLog({
      companyId,
      actor,
      action: 'OPERATION_ASSIGNED_TO_EMPLOYEE',
      entityType: 'EMPLOYEE_OPERATION',
      entityId: 'op-1',
    });

    const log = await service.getCompanyLogById(actor, companyId, 'log-1');
    expect(log.id).toBe('log-1');
    expect(log.action).toBe('OPERATION_ASSIGNED_TO_EMPLOYEE');
    expect(log.actor.displayName).toBe('iMaker Admin');
  });

  it('throws NotFoundError when audit log does not exist or belongs to another company', async () => {
    await expect(service.getCompanyLogById(actor, companyId, 'non-existent')).rejects.toThrow(
      NotFoundError,
    );
  });
});

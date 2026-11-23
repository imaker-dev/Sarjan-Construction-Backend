import { describe, it, expect, beforeEach } from 'vitest';
import { DelegationService } from '../../../src/modules/organization/delegation.js';
import { VersionConflictError } from '../../../src/modules/organization/errors.js';
import type { ActorContext } from '../../../src/modules/organization/types.js';
import type { PrismaClient } from '@prisma/client';

const actor: ActorContext = { actorId: 'principal-1', actorType: 'USER' };
const companyId = '00000000-0000-4000-8000-0000000000c1';

interface PolicyRow {
  id: string;
  companyId: string;
  siteCreate: boolean;
  siteUpdate: boolean;
  deptManage: boolean;
  placement: boolean;
  version: number;
}

let rows: PolicyRow[];
let auditRows: Record<string, unknown>[];
let authorized: boolean;
const authCalls: { key: string }[] = [];

const fakePrisma = {
  companyDelegationPolicy: {
    findUnique: async ({ where }: { where: { companyId: string } }) =>
      rows.find((r) => r.companyId === where.companyId) ?? null,
    create: async ({ data }: { data: Omit<PolicyRow, 'id' | 'version'> }) => {
      const row: PolicyRow = { id: 'pol-1', version: 0, ...data };
      rows.push(row);
      return row;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { companyId: string; version: number };
      data: {
        siteCreate: boolean;
        siteUpdate: boolean;
        deptManage: boolean;
        placement: boolean;
        version: { increment: number };
      };
    }) => {
      const row = rows.find((r) => r.companyId === where.companyId);
      if (row?.version !== where.version) return { count: 0 };
      row.siteCreate = data.siteCreate;
      row.siteUpdate = data.siteUpdate;
      row.deptManage = data.deptManage;
      row.placement = data.placement;
      row.version += data.version.increment;
      return { count: 1 };
    },
  },
  auditLog: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      auditRows.push(data);
      return { id: `log-${auditRows.length}` };
    },
  },
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakePrisma),
} as unknown as PrismaClient;

const authorizer = {
  assertPermission: async (_pid: string, key: string) => {
    authCalls.push({ key });
    if (!authorized) throw new Error('Permission denied');
  },
};

let service: DelegationService;

beforeEach(() => {
  rows = [];
  auditRows = [];
  authCalls.length = 0;
  authorized = true;
  service = new DelegationService(fakePrisma, authorizer);
});

describe('DelegationService', () => {
  it('missing row → all switches OFF with version 0 (fail closed)', async () => {
    const dto = await service.getPolicy(actor, companyId);
    expect(dto).toEqual({
      siteCreate: false,
      siteUpdate: false,
      deptManage: false,
      employeeOnboard: false,
      placement: false,
      memberSuspend: false,
      memberExit: false,
      version: 0,
    });
    expect(await service.isEnabled(companyId, 'siteCreate')).toBe(false);
    expect(await service.isEnabled(companyId, 'deptManage')).toBe(false);
  });

  it('update creates the row, bumps version, audits only changed flags', async () => {
    const dto = await service.updatePolicy(actor, companyId, {
      expectedVersion: 0,
      siteCreate: true,
    });
    expect(dto).toEqual({
      siteCreate: true,
      siteUpdate: false,
      deptManage: false,
      employeeOnboard: false,
      placement: false,
      memberSuspend: false,
      memberExit: false,
      version: 0,
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'DELEGATION_POLICY_UPDATED',
      changedFields: { siteCreate: { before: false, after: true } },
    });
  });

  it('subsequent update merges flags and increments version', async () => {
    await service.updatePolicy(actor, companyId, { expectedVersion: 0, siteCreate: true });
    const dto = await service.updatePolicy(actor, companyId, {
      expectedVersion: 0,
      deptManage: true,
    });
    expect(dto).toEqual({
      siteCreate: true,
      siteUpdate: false,
      deptManage: true,
      employeeOnboard: false,
      placement: false,
      memberSuspend: false,
      memberExit: false,
      version: 1,
    });
    expect(await service.isEnabled(companyId, 'deptManage')).toBe(true);
  });

  it('stale expectedVersion → VERSION_CONFLICT; no write, no audit row', async () => {
    await service.updatePolicy(actor, companyId, { expectedVersion: 0, siteCreate: true });
    auditRows.length = 0;
    await expect(
      service.updatePolicy(actor, companyId, { expectedVersion: 5, siteUpdate: true }),
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect(rows[0]?.siteUpdate).toBe(false);
    expect(auditRows).toHaveLength(0);
  });

  it('unauthorized update writes nothing and audits nothing', async () => {
    authorized = false;
    await expect(
      service.updatePolicy(actor, companyId, { expectedVersion: 0, siteCreate: true }),
    ).rejects.toThrow();
    expect(rows).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });

  it('all-defaults patch with no row keeps the canonical empty state', async () => {
    const dto = await service.updatePolicy(actor, companyId, {
      expectedVersion: 0,
      siteCreate: false,
    });
    expect(dto.version).toBe(0);
    expect(rows).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });

  it('get requires ORG_COMPANY_READ; update requires ORG_COMPANY_UPDATE', async () => {
    await service.getPolicy(actor, companyId);
    expect(authCalls.at(-1)?.key).toBe('ORG_COMPANY_READ');
    await service.updatePolicy(actor, companyId, { expectedVersion: 0, siteCreate: true });
    expect(authCalls.at(-1)?.key).toBe('ORG_COMPANY_UPDATE');
    authorized = false;
    await expect(service.getPolicy(actor, companyId)).rejects.toThrow();
    await expect(
      service.updatePolicy(actor, companyId, { expectedVersion: 0, siteCreate: true }),
    ).rejects.toThrow();
  });
});

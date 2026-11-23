import type { PrismaClient } from '@prisma/client';

/**
 * Trusted audit-scope provenance.
 *
 * A project/site activity feed may only include events whose scope is proven
 * from server-controlled data — never from caller-supplied metadata. Each
 * entity type gets an explicit batched resolver from audit `entityId` to the
 * scope columns that actually exist on its table. Entity types absent from
 * this map are unresolved and fail closed (excluded from scoped feeds).
 */

export interface ScopeRef {
  projectId: string | null;
  siteId: string | null;
}

export interface ScopeEvidence {
  id: string;
  entityType: string;
  entityId: string;
}

type Resolver = (
  prisma: PrismaClient,
  companyId: string,
  ids: string[],
) => Promise<Map<string, ScopeRef>>;

const proven = (projectId: string | null, siteId: string | null): ScopeRef | null =>
  projectId === null && siteId === null ? null : { projectId, siteId };

const collect = <T extends { id: string }>(
  rows: T[],
  scopeOf: (row: T) => ScopeRef | null,
): Map<string, ScopeRef> => {
  const map = new Map<string, ScopeRef>();
  for (const row of rows) {
    const scope = scopeOf(row);
    if (scope !== null) map.set(row.id, scope);
  }
  return map;
};

const deptScopes = async (
  prisma: PrismaClient,
  companyId: string,
  deptIds: string[],
): Promise<Map<string, ScopeRef>> => {
  if (deptIds.length === 0) return new Map();
  const rows = await prisma.department.findMany({
    where: { id: { in: deptIds }, companyId },
    select: { id: true, projectId: true, siteId: true },
  });
  return collect(rows, (d) => proven(d.projectId, d.siteId));
};

const siteScopes = async (
  prisma: PrismaClient,
  companyId: string,
  siteIds: string[],
): Promise<Map<string, ScopeRef>> => {
  if (siteIds.length === 0) return new Map();
  const rows = await prisma.site.findMany({
    where: { id: { in: siteIds }, companyId },
    select: { id: true, projectId: true },
  });
  return collect(rows, (s) => proven(s.projectId, s.id));
};

const operationScopes = async (
  prisma: PrismaClient,
  companyId: string,
  operationIds: string[],
): Promise<Map<string, ScopeRef>> => {
  if (operationIds.length === 0) return new Map();
  const ops = await prisma.operation.findMany({
    where: { id: { in: operationIds }, companyId },
    select: { id: true, departmentId: true },
  });
  const depts = await deptScopes(
    prisma,
    companyId,
    ops.map((o) => o.departmentId),
  );
  return collect(ops, (o) => depts.get(o.departmentId) ?? null);
};

const workflowInstanceScopes = async (
  prisma: PrismaClient,
  companyId: string,
  instanceIds: string[],
): Promise<Map<string, ScopeRef>> => {
  if (instanceIds.length === 0) return new Map();
  const instances = await prisma.workflowInstance.findMany({
    where: { id: { in: instanceIds }, companyId },
    select: { id: true, operationId: true },
  });
  const opScopes = await operationScopes(
    prisma,
    companyId,
    instances.map((i) => i.operationId),
  );
  return collect(instances, (i) => opScopes.get(i.operationId) ?? null);
};

const documentScopes = async (
  prisma: PrismaClient,
  companyId: string,
  documentIds: string[],
): Promise<Map<string, ScopeRef>> => {
  if (documentIds.length === 0) return new Map();
  const docs = await prisma.document.findMany({
    where: { id: { in: documentIds }, companyId },
    select: { id: true, projectId: true, siteId: true },
  });
  return collect(docs, (d) => proven(d.projectId, d.siteId));
};

const scheduleScopes = async (
  prisma: PrismaClient,
  companyId: string,
  scheduleIds: string[],
): Promise<Map<string, ScopeRef>> => {
  if (scheduleIds.length === 0) return new Map();
  const rows = await prisma.workSchedule.findMany({
    where: { id: { in: scheduleIds }, companyId },
    select: { id: true, projectId: true, siteId: true },
  });
  return collect(rows, (r) => proven(r.projectId, r.siteId));
};

const sessionScopes = async (
  prisma: PrismaClient,
  companyId: string,
  sessionIds: string[],
): Promise<Map<string, ScopeRef>> => {
  if (sessionIds.length === 0) return new Map();
  const sessions = await prisma.attendanceSession.findMany({
    where: { id: { in: sessionIds }, companyId },
    select: { id: true, siteId: true },
  });
  const sites = await siteScopes(
    prisma,
    companyId,
    sessions.flatMap((s) => (s.siteId !== null ? [s.siteId] : [])),
  );
  return collect(sessions, (s) => (s.siteId === null ? null : (sites.get(s.siteId) ?? null)));
};

/** Resolve entityId → hop ids, then reuse the hop's resolver. */
const viaHop =
  (
    hopIds: (
      prisma: PrismaClient,
      companyId: string,
      ids: string[],
    ) => Promise<Map<string, string>>,
    hopResolver: Resolver,
  ): Resolver =>
  async (prisma, companyId, ids) => {
    const hops = await hopIds(prisma, companyId, ids);
    if (hops.size === 0) return new Map();
    const hopScopes = await hopResolver(prisma, companyId, [...hops.values()]);
    const out = new Map<string, ScopeRef>();
    for (const [entityId, hopId] of hops) {
      const scope = hopScopes.get(hopId);
      if (scope !== undefined) out.set(entityId, scope);
    }
    return out;
  };

const hopTo =
  <T extends { id: string }>(
    query: (prisma: PrismaClient, companyId: string, ids: string[]) => Promise<T[]>,
    pick: (row: T) => string | null,
  ) =>
  async (prisma: PrismaClient, companyId: string, ids: string[]) => {
    const rows = await query(prisma, companyId, ids);
    const map = new Map<string, string>();
    for (const row of rows) {
      const hop = pick(row);
      if (hop !== null) map.set(row.id, hop);
    }
    return map;
  };

/**
 * entityType → batched resolver. Only entity types whose project/site scope is
 * provable from a server-side column (directly or through a bounded hop) are
 * listed. Everything else — including PRINCIPAL, EMPLOYEE*, LEAVE_*, COMPANY,
 * HEAD_OFFICE, catalogue/policy/config types and COMPLIANCE_RECORD (scopeType
 * but no scope reference column) — is unresolvable and excluded.
 */
const RESOLVERS: Record<string, Resolver> = {
  PROJECT: async (p, c, ids) =>
    collect(
      await p.project.findMany({
        where: { id: { in: ids }, companyId: c },
        select: { id: true },
      }),
      (r) => proven(r.id, null),
    ),
  SITE: siteScopes,
  LAND_PARCEL: async (p, c, ids) =>
    collect(
      await p.projectLandParcel.findMany({
        where: { id: { in: ids }, companyId: c },
        select: { id: true, projectId: true },
      }),
      (r) => proven(r.projectId, null),
    ),
  PROJECT_DOCUMENT: async (p, c, ids) =>
    collect(
      await p.projectDocument.findMany({
        where: { id: { in: ids }, companyId: c },
        select: { id: true, projectId: true },
      }),
      (r) => proven(r.projectId, null),
    ),
  SITE_DOCUMENT: viaHop(
    hopTo(
      (p, c, ids) =>
        p.siteDocument.findMany({
          where: { id: { in: ids }, companyId: c },
          select: { id: true, siteId: true },
        }),
      (r) => r.siteId,
    ),
    siteScopes,
  ),
  PROJECT_APPROVAL: async (p, c, ids) =>
    collect(
      await p.projectApproval.findMany({
        where: { id: { in: ids }, companyId: c },
        select: { id: true, projectId: true },
      }),
      (r) => proven(r.projectId, null),
    ),
  DEPARTMENT: deptScopes,
  DEPARTMENT_OPERATION: viaHop(
    hopTo(
      (p, c, ids) =>
        p.departmentOperation.findMany({
          where: { id: { in: ids }, companyId: c },
          select: { id: true, departmentId: true },
        }),
      (r) => r.departmentId,
    ),
    deptScopes,
  ),
  DEPARTMENT_MEMBERSHIP: viaHop(
    hopTo(
      (p, c, ids) =>
        p.departmentMembership.findMany({
          where: { id: { in: ids }, companyId: c },
          select: { id: true, departmentId: true },
        }),
      (r) => r.departmentId,
    ),
    deptScopes,
  ),
  OPERATION: operationScopes,
  ROLE_ASSIGNMENT: async (p, c, ids) =>
    collect(
      await p.roleAssignment.findMany({
        where: { id: { in: ids }, companyId: c },
        select: { id: true, projectId: true, siteId: true },
      }),
      (r) => proven(r.projectId, r.siteId),
    ),
  PROJECT_BUDGET: async (p, c, ids) =>
    collect(
      await p.projectBudget.findMany({
        where: { id: { in: ids }, companyId: c },
        select: { id: true, projectId: true },
      }),
      (r) => proven(r.projectId, null),
    ),
  BUDGET_REVISION: viaHop(
    hopTo(
      (p, c, ids) =>
        p.budgetRevision.findMany({
          where: { id: { in: ids }, companyId: c },
          select: { id: true, budgetId: true },
        }),
      (r) => r.budgetId,
    ),
    async (p, c, ids) =>
      collect(
        await p.projectBudget.findMany({
          where: { id: { in: ids }, companyId: c },
          select: { id: true, projectId: true },
        }),
        (r) => proven(r.projectId, null),
      ),
  ),
  CASH_FLOW_FORECAST: async (p, c, ids) =>
    collect(
      await p.cashFlowForecast.findMany({
        where: { id: { in: ids }, companyId: c },
        select: { id: true, projectId: true },
      }),
      (r) => proven(r.projectId, null),
    ),
  ATTENDANCE_SESSION: sessionScopes,
  SAFETY_TVT_SESSION: viaHop(
    hopTo(
      (p, c, ids) =>
        p.safetyTvtSession.findMany({
          where: { id: { in: ids }, companyId: c },
          select: { id: true, siteId: true },
        }),
      (r) => r.siteId,
    ),
    siteScopes,
  ),
  ATTENDANCE_BREAK: viaHop(
    hopTo(
      (p, c, ids) =>
        p.attendanceBreak.findMany({
          where: { id: { in: ids }, companyId: c },
          select: { id: true, sessionId: true },
        }),
      (r) => r.sessionId,
    ),
    sessionScopes,
  ),
  DOCUMENT: documentScopes,
  DOCUMENT_LINK: viaHop(
    hopTo(
      (p, c, ids) =>
        p.documentLink.findMany({
          where: { id: { in: ids }, companyId: c },
          select: { id: true, documentId: true },
        }),
      (r) => r.documentId,
    ),
    documentScopes,
  ),
  WORK_SCHEDULE: scheduleScopes,
  WORK_SCHEDULE_REVISION: viaHop(
    hopTo(
      (p, c, ids) =>
        p.workScheduleRevision.findMany({
          where: { id: { in: ids }, companyId: c },
          select: { id: true, scheduleId: true },
        }),
      (r) => r.scheduleId,
    ),
    scheduleScopes,
  ),
  WORK_SCHEDULE_OVERRIDE: viaHop(
    hopTo(
      (p, c, ids) =>
        p.workScheduleOverride.findMany({
          where: { id: { in: ids }, companyId: c },
          select: { id: true, scheduleId: true },
        }),
      (r) => r.scheduleId,
    ),
    scheduleScopes,
  ),
  WORKFLOW_INSTANCE: workflowInstanceScopes,
  APPROVAL_TASK: viaHop(
    hopTo(
      (p, c, ids) =>
        p.approvalTask.findMany({
          where: { id: { in: ids }, companyId: c },
          select: { id: true, workflowInstanceId: true },
        }),
      (r) => r.workflowInstanceId,
    ),
    workflowInstanceScopes,
  ),
  FORM_SUBMISSION: viaHop(
    hopTo(
      (p, c, ids) =>
        p.formSubmission.findMany({
          where: { id: { in: ids }, companyId: c },
          select: { id: true, workflowInstanceId: true },
        }),
      (r) => r.workflowInstanceId,
    ),
    workflowInstanceScopes,
  ),
};

/**
 * Batch-resolve audit rows to proven scopes. Returns auditRowId → ScopeRef.
 * Rows whose entity type has no resolver, whose entity no longer exists, or
 * whose scope columns are company/head-office-only produce no entry — the
 * caller must treat them as excluded (fail closed).
 */
export async function resolveEventScopes(
  prisma: PrismaClient,
  companyId: string,
  events: ScopeEvidence[],
): Promise<Map<string, ScopeRef>> {
  const byType = new Map<string, Set<string>>();
  for (const ev of events) {
    if (!(ev.entityType in RESOLVERS)) continue;
    const set = byType.get(ev.entityType) ?? new Set<string>();
    set.add(ev.entityId);
    byType.set(ev.entityType, set);
  }
  if (byType.size === 0) return new Map();

  const entityScopes = new Map<string, Map<string, ScopeRef>>();
  await Promise.all(
    [...byType].map(async ([entityType, ids]) => {
      const resolver = RESOLVERS[entityType];
      if (resolver === undefined) return;
      entityScopes.set(entityType, await resolver(prisma, companyId, [...ids]));
    }),
  );

  const out = new Map<string, ScopeRef>();
  for (const ev of events) {
    const scope = entityScopes.get(ev.entityType)?.get(ev.entityId);
    if (scope !== undefined) out.set(ev.id, scope);
  }

  // Site-scoped entities (SITE departments, site role assignments, site
  // schedules/documents…) typically store siteId only — their project is
  // proven through the site row. Backfill projectId centrally so every
  // resolver benefits; if the site no longer resolves the row stays
  // site-provable only (fail closed for project feeds).
  const siteOnly = new Set(
    [...out.values()].flatMap((s) => (s.siteId !== null && s.projectId === null ? [s.siteId] : [])),
  );
  if (siteOnly.size > 0) {
    const sites = await prisma.site.findMany({
      where: { id: { in: [...siteOnly] }, companyId },
      select: { id: true, projectId: true },
    });
    const byId = new Map(sites.map((s) => [s.id, s.projectId]));
    for (const scope of out.values()) {
      if (scope.siteId !== null && scope.projectId === null) {
        scope.projectId = byId.get(scope.siteId) ?? null;
      }
    }
  }

  return out;
}

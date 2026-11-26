import type {
  BudgetRevision,
  Company,
  HeadOffice,
  Prisma,
  PrismaClient,
  Project,
  ProjectApproval,
  ProjectBudget,
  ProjectDocument,
  ProjectLandParcel,
  Site,
  SiteDocument,
} from '@prisma/client';
import type { OrgNodeStatus, ProjectStatus } from '@prisma/client';
import { VersionConflictError, mapOrgWriteError } from './errors.js';
import type { AuditRecord, InitialBudgetLineInput } from './types.js';

// ---------------------------------------------------------------------------
// Repository contracts. Every query is scope-first: scope predicates are part
// of the database query, never post-filtered.
// ---------------------------------------------------------------------------

export interface CompanyRepository {
  findById(companyId: string, id: string): Promise<Company | null>;
  findByCode(code: string): Promise<Company | null>;
  create(data: { code: string; name: string; legalName?: string }): Promise<Company>;
  update(
    companyId: string,
    id: string,
    data: Record<string, unknown>,
    expectedVersion?: number,
  ): Promise<Company>;
}

export interface HeadOfficeRepository {
  findById(companyId: string, id: string): Promise<HeadOffice | null>;
  list(companyId: string, filter?: { status?: OrgNodeStatus }): Promise<HeadOffice[]>;
  create(
    companyId: string,
    data: { code: string; name: string; isPrimary?: boolean },
  ): Promise<HeadOffice>;
  update(
    companyId: string,
    id: string,
    data: Record<string, unknown>,
    expectedVersion?: number,
  ): Promise<HeadOffice>;
  /** Demote every other primary before promoting a new one (same tx). */
  clearOtherPrimaries(companyId: string, exceptId?: string): Promise<void>;
}

export interface OrgScopeFilter {
  projectIds: string[];
  headOfficeIds: string[];
  siteIds: string[];
}

export interface ProjectRepository {
  findById(companyId: string, id: string): Promise<Project | null>;
  list(
    companyId: string,
    filter?: { status?: ProjectStatus; headOfficeId?: string; scopeFilter?: OrgScopeFilter },
  ): Promise<Project[]>;
  create(
    companyId: string,
    headOfficeId: string,
    data: Record<string, unknown> & { code: string; name: string; timezone: string },
  ): Promise<Project>;
  update(
    companyId: string,
    id: string,
    data: Record<string, unknown>,
    expectedVersion?: number,
  ): Promise<Project>;
}

export interface SiteRepository {
  findById(companyId: string, id: string): Promise<Site | null>;
  list(
    companyId: string,
    filter?: { status?: OrgNodeStatus; projectId?: string; scopeFilter?: OrgScopeFilter },
  ): Promise<Site[]>;
  create(
    companyId: string,
    projectId: string,
    data: Record<string, unknown> & { code: string; name: string },
  ): Promise<Site>;
  update(
    companyId: string,
    id: string,
    data: Record<string, unknown>,
    expectedVersion?: number,
  ): Promise<Site>;
}

// Append-only: no update or delete methods by design.
export interface AuditRepository {
  record: (entry: AuditRecord) => Promise<void>;
}

// ---- Project/Site profile milestone repositories ---------------------------

export interface LandParcelRepository {
  create(
    companyId: string,
    projectId: string,
    data: Record<string, unknown>,
  ): Promise<ProjectLandParcel>;
  list(companyId: string, projectId: string): Promise<ProjectLandParcel[]>;
  findById(companyId: string, id: string): Promise<ProjectLandParcel | null>;
}

export interface OrgDocumentLinkRepository<TRow = { id: string }> {
  create(companyId: string, ownerId: string, data: Record<string, unknown>): Promise<TRow>;
  list(companyId: string, ownerId: string): Promise<TRow[]>;
  findById(companyId: string, id: string): Promise<TRow | null>;
  update(
    companyId: string,
    id: string,
    data: Record<string, unknown>,
    expectedVersion?: number,
  ): Promise<TRow>;
}

export interface ProjectApprovalRepository {
  create(
    companyId: string,
    projectId: string,
    data: Record<string, unknown>,
  ): Promise<ProjectApproval>;
  list(companyId: string, projectId: string): Promise<ProjectApproval[]>;
  findById(companyId: string, id: string): Promise<ProjectApproval | null>;
  update(
    companyId: string,
    id: string,
    data: Record<string, unknown>,
    expectedVersion?: number,
  ): Promise<ProjectApproval>;
}

// Minimal write surface for the nested initialBudget flow — the authoritative
// budget API stays in the finance module; this segment exists so project
// creation can write the draft budget atomically in the same transaction.
export interface InitialBudgetRepository {
  createBudget(
    companyId: string,
    projectId: string,
    data: { code: string; name: string; description?: string; currency: string },
  ): Promise<ProjectBudget>;
  createRevision(
    companyId: string,
    budgetId: string,
    revision: number,
    totalAmount: string,
    input: { notes?: string; lines: InitialBudgetLineInput[] },
  ): Promise<BudgetRevision>;
}

export interface OrgDocumentScopeInfo {
  id: string;
  status: string;
  scopeType: string;
  projectId: string | null;
  siteId: string | null;
}

export interface OrgRepos {
  companies: CompanyRepository;
  headOffices: HeadOfficeRepository;
  projects: ProjectRepository;
  sites: SiteRepository;
  audit: AuditRepository;
  departments: {
    countByCategory(companyId: string, scopeType: string, categories: string[]): Promise<number>;
  };
  landParcels: LandParcelRepository;
  projectDocuments: OrgDocumentLinkRepository<ProjectDocument>;
  siteDocuments: OrgDocumentLinkRepository<SiteDocument>;
  approvals: ProjectApprovalRepository;
  budgets: InitialBudgetRepository;
  documents: {
    findScopeInfo(companyId: string, id: string): Promise<OrgDocumentScopeInfo | null>;
  };
  outbox: {
    record(entry: {
      companyId: string;
      eventType: string;
      aggregateType: string;
      aggregateId: string;
      eventKey: string;
      recipientPrincipalIds: string[];
      summary: Record<string, unknown>;
    }): Promise<unknown>;
  };
}

export interface OrgUnitOfWork {
  run<T>(fn: (repos: OrgRepos) => Promise<T>): Promise<T>;
}

type Tx = Prisma.TransactionClient;

// Shared scoped-update helper: updateMany with version predicate gives atomic
// optimistic-concurrency; count 0 means version conflict or out-of-scope row.
export async function scopedUpdate<TRow>(
  entityType: string,
  where: Record<string, unknown>,
  data: Record<string, unknown>,
  expectedVersion: number | undefined,
  updateMany: (args: {
    where: object;
    data: Record<string, unknown>;
  }) => Promise<{ count: number }>,
  reload: () => Promise<TRow | null>,
): Promise<TRow> {
  const guardedWhere = {
    ...where,
    ...(expectedVersion !== undefined ? { version: expectedVersion } : {}),
  };
  const guardedData = { ...data, version: { increment: 1 } };
  try {
    const { count } = await updateMany({ where: guardedWhere, data: guardedData });
    if (count === 0) {
      // Row vanished between the scope check and the write, or the supplied
      // version was stale. Either way the caller must reload and retry.
      throw new VersionConflictError(entityType);
    }
  } catch (error) {
    mapOrgWriteError(error, entityType);
  }
  const row = await reload();
  if (row === null) throw new VersionConflictError(entityType);
  return row;
}

export function makeOrgRepos(tx: Tx): OrgRepos {
  return {
    companies: {
      // companyId must equal the record id; a company is its own scope.
      findById: (companyId, id) =>
        companyId === id ? tx.company.findUnique({ where: { id } }) : Promise.resolve(null),
      findByCode: (code) => tx.company.findUnique({ where: { code } }),
      create: async (data) => {
        try {
          return await tx.company.create({ data });
        } catch (error) {
          mapOrgWriteError(error, 'COMPANY');
        }
      },
      update: (companyId, id, data, expectedVersion) =>
        // companyId === id is guaranteed by the service's scoped findById.
        scopedUpdate(
          'COMPANY',
          { id },
          data,
          expectedVersion,
          (args) => tx.company.updateMany(args),
          () => tx.company.findUnique({ where: { id } }),
        ),
    },
    headOffices: {
      findById: (companyId, id) => tx.headOffice.findFirst({ where: { id, companyId } }),
      list: (companyId, filter) =>
        tx.headOffice.findMany({
          where: { companyId, ...(filter?.status ? { status: filter.status } : {}) },
          orderBy: { id: 'asc' },
        }),
      create: async (companyId, data) => {
        try {
          return await tx.headOffice.create({ data: { ...data, companyId } });
        } catch (error) {
          mapOrgWriteError(error, 'HEAD_OFFICE');
        }
      },
      update: (companyId, id, data, expectedVersion) =>
        scopedUpdate(
          'HEAD_OFFICE',
          { id, companyId },
          data,
          expectedVersion,
          (args) => tx.headOffice.updateMany(args),
          () => tx.headOffice.findFirst({ where: { id, companyId } }),
        ),
      clearOtherPrimaries: (companyId, exceptId) =>
        tx.headOffice
          .updateMany({
            where: { companyId, isPrimary: true, ...(exceptId ? { id: { not: exceptId } } : {}) },
            data: { isPrimary: false },
          })
          .then(() => undefined),
    },
    projects: {
      findById: (companyId, id) => tx.project.findFirst({ where: { id, companyId } }),
      list: (companyId, filter) => {
        const sf = filter?.scopeFilter;
        const scopeOr = sf
          ? [
              ...(sf.projectIds.length > 0 ? [{ id: { in: sf.projectIds } }] : []),
              ...(sf.headOfficeIds.length > 0 ? [{ headOfficeId: { in: sf.headOfficeIds } }] : []),
              ...(sf.siteIds.length > 0 ? [{ sites: { some: { id: { in: sf.siteIds } } } }] : []),
            ]
          : null;
        return tx.project.findMany({
          where: {
            companyId,
            ...(filter?.status ? { status: filter.status } : {}),
            ...(filter?.headOfficeId ? { headOfficeId: filter.headOfficeId } : {}),
            ...(scopeOr !== null ? { OR: scopeOr } : {}),
          },
          orderBy: { id: 'asc' },
        });
      },
      create: async (companyId, headOfficeId, data) => {
        try {
          // (headOfficeId, companyId) composite FK guarantees the HO belongs to
          // this company even if the service check were bypassed.
          return await tx.project.create({ data: { ...data, companyId, headOfficeId } });
        } catch (error) {
          mapOrgWriteError(error, 'PROJECT');
        }
      },
      update: (companyId, id, data, expectedVersion) =>
        scopedUpdate(
          'PROJECT',
          { id, companyId },
          data,
          expectedVersion,
          (args) => tx.project.updateMany(args),
          () => tx.project.findFirst({ where: { id, companyId } }),
        ),
    },
    sites: {
      findById: (companyId, id) => tx.site.findFirst({ where: { id, companyId } }),
      list: (companyId, filter) => {
        const sf = filter?.scopeFilter;
        const scopeOr = sf
          ? [
              ...(sf.siteIds.length > 0 ? [{ id: { in: sf.siteIds } }] : []),
              ...(sf.projectIds.length > 0 ? [{ projectId: { in: sf.projectIds } }] : []),
              ...(sf.headOfficeIds.length > 0
                ? [{ project: { headOfficeId: { in: sf.headOfficeIds } } }]
                : []),
            ]
          : null;
        return tx.site.findMany({
          where: {
            companyId,
            ...(filter?.status ? { status: filter.status } : {}),
            ...(filter?.projectId ? { projectId: filter.projectId } : {}),
            ...(scopeOr !== null ? { OR: scopeOr } : {}),
          },
          orderBy: { id: 'asc' },
        });
      },
      create: async (companyId, projectId, data) => {
        try {
          return await tx.site.create({ data: { ...data, companyId, projectId } });
        } catch (error) {
          mapOrgWriteError(error, 'SITE');
        }
      },
      update: (companyId, id, data, expectedVersion) =>
        scopedUpdate(
          'SITE',
          { id, companyId },
          data,
          expectedVersion,
          (args) => tx.site.updateMany(args),
          () => tx.site.findFirst({ where: { id, companyId } }),
        ),
    },
    departments: {
      countByCategory: (companyId, scopeType, categories) =>
        tx.department.count({
          where: {
            companyId,
            scopeType: scopeType as never,
            category: { in: categories as never },
          },
        }),
    },
    landParcels: {
      create: async (companyId, projectId, data) => {
        try {
          return await tx.projectLandParcel.create({
            data: {
              ...data,
              companyId,
              projectId,
            } as Prisma.ProjectLandParcelUncheckedCreateInput,
          });
        } catch (error) {
          mapOrgWriteError(error, 'LAND_PARCEL');
        }
      },
      list: (companyId, projectId) =>
        tx.projectLandParcel.findMany({ where: { companyId, projectId }, orderBy: { id: 'asc' } }),
      findById: (companyId, id) => tx.projectLandParcel.findFirst({ where: { id, companyId } }),
    },
    projectDocuments: {
      create: async (companyId, projectId, data) => {
        try {
          return await tx.projectDocument.create({
            data: { ...data, companyId, projectId } as Prisma.ProjectDocumentUncheckedCreateInput,
          });
        } catch (error) {
          mapOrgWriteError(error, 'PROJECT_DOCUMENT');
        }
      },
      list: (companyId, projectId) =>
        tx.projectDocument.findMany({ where: { companyId, projectId }, orderBy: { id: 'asc' } }),
      findById: (companyId, id) => tx.projectDocument.findFirst({ where: { id, companyId } }),
      update: (companyId, id, data, expectedVersion) =>
        scopedUpdate(
          'PROJECT_DOCUMENT',
          { id, companyId },
          data,
          expectedVersion,
          (args) => tx.projectDocument.updateMany(args),
          () => tx.projectDocument.findFirst({ where: { id, companyId } }),
        ),
    },
    siteDocuments: {
      create: async (companyId, siteId, data) => {
        try {
          return await tx.siteDocument.create({
            data: { ...data, companyId, siteId } as Prisma.SiteDocumentUncheckedCreateInput,
          });
        } catch (error) {
          mapOrgWriteError(error, 'SITE_DOCUMENT');
        }
      },
      list: (companyId, siteId) =>
        tx.siteDocument.findMany({ where: { companyId, siteId }, orderBy: { id: 'asc' } }),
      findById: (companyId, id) => tx.siteDocument.findFirst({ where: { id, companyId } }),
      update: (companyId, id, data, expectedVersion) =>
        scopedUpdate(
          'SITE_DOCUMENT',
          { id, companyId },
          data,
          expectedVersion,
          (args) => tx.siteDocument.updateMany(args),
          () => tx.siteDocument.findFirst({ where: { id, companyId } }),
        ),
    },
    approvals: {
      create: async (companyId, projectId, data) => {
        try {
          return await tx.projectApproval.create({
            data: { ...data, companyId, projectId } as Prisma.ProjectApprovalUncheckedCreateInput,
          });
        } catch (error) {
          mapOrgWriteError(error, 'PROJECT_APPROVAL');
        }
      },
      list: (companyId, projectId) =>
        tx.projectApproval.findMany({ where: { companyId, projectId }, orderBy: { id: 'asc' } }),
      findById: (companyId, id) => tx.projectApproval.findFirst({ where: { id, companyId } }),
      update: (companyId, id, data, expectedVersion) =>
        scopedUpdate(
          'PROJECT_APPROVAL',
          { id, companyId },
          data,
          expectedVersion,
          (args) => tx.projectApproval.updateMany(args),
          () => tx.projectApproval.findFirst({ where: { id, companyId } }),
        ),
    },
    budgets: {
      createBudget: async (companyId, projectId, data) => {
        try {
          return await tx.projectBudget.create({
            data: { ...data, companyId, projectId },
          });
        } catch (error) {
          mapOrgWriteError(error, 'PROJECT_BUDGET');
        }
      },
      createRevision: (companyId, budgetId, revision, totalAmount, input) =>
        tx.budgetRevision.create({
          data: {
            companyId,
            budgetId,
            revision,
            totalAmount,
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
            lines: {
              create: input.lines.map((line, i) => ({
                category: line.category as never,
                description: line.description,
                amount: line.amount,
                sortOrder: i,
              })),
            },
          },
        }),
    },
    documents: {
      findScopeInfo: (companyId, id) =>
        tx.document.findFirst({
          where: { id, companyId },
          select: { id: true, status: true, scopeType: true, projectId: true, siteId: true },
        }),
    },
    outbox: {
      record: (entry) =>
        tx.outboxEvent.create({
          data: {
            companyId: entry.companyId,
            eventType: entry.eventType,
            aggregateType: entry.aggregateType,
            aggregateId: entry.aggregateId,
            eventKey: entry.eventKey,
            payload: {
              recipientPrincipalIds: entry.recipientPrincipalIds,
              summary: entry.summary,
            } as never,
          },
        }),
    },
    audit: {
      record: async (entry) => {
        await tx.auditLog.create({
          data: {
            eventKey: entry.eventKey,
            action: entry.action,
            entityType: entry.entityType,
            entityId: entry.entityId,
            actorId: entry.actorId,
            actorType: entry.actorType,
            companyId: entry.companyId ?? null,
            correlationId: entry.correlationId ?? null,
            statusBefore: entry.statusBefore ?? null,
            statusAfter: entry.statusAfter ?? null,
            ...(entry.changedFields !== undefined
              ? { changedFields: entry.changedFields as Prisma.InputJsonValue }
              : {}),
            ...(entry.metadata !== undefined
              ? { metadata: entry.metadata as Prisma.InputJsonValue }
              : {}),
          },
        });
      },
    },
  };
}

export class PrismaOrgUnitOfWork implements OrgUnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}

  run<T>(fn: (repos: OrgRepos) => Promise<T>): Promise<T> {
    // Single transaction: business write + audit write commit or roll back together.
    return this.prisma.$transaction((tx) => fn(makeOrgRepos(tx)));
  }
}

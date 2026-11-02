import type { Company, HeadOffice, Prisma, PrismaClient, Project, Site } from '@prisma/client';
import type { OrgNodeStatus, ProjectStatus } from '@prisma/client';
import { VersionConflictError, mapOrgWriteError } from './errors.js';
import type { AuditRecord } from './types.js';

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

export interface ProjectRepository {
  findById(companyId: string, id: string): Promise<Project | null>;
  list(
    companyId: string,
    filter?: { status?: ProjectStatus; headOfficeId?: string },
  ): Promise<Project[]>;
  create(
    companyId: string,
    headOfficeId: string,
    data: {
      code: string;
      name: string;
      description?: string;
      timezone: string;
      startDate?: Date;
      endDate?: Date;
    },
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
  list(companyId: string, filter?: { status?: OrgNodeStatus; projectId?: string }): Promise<Site[]>;
  create(
    companyId: string,
    projectId: string,
    data: {
      code: string;
      name: string;
      address?: string;
      geoLatitude?: number;
      geoLongitude?: number;
      geoFenceRadiusM?: number;
      timezone?: string;
    },
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
  record(entry: AuditRecord): Promise<void>;
}

export interface OrgRepos {
  companies: CompanyRepository;
  headOffices: HeadOfficeRepository;
  projects: ProjectRepository;
  sites: SiteRepository;
  audit: AuditRepository;
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
      list: (companyId, filter) =>
        tx.project.findMany({
          where: {
            companyId,
            ...(filter?.status ? { status: filter.status } : {}),
            ...(filter?.headOfficeId ? { headOfficeId: filter.headOfficeId } : {}),
          },
          orderBy: { id: 'asc' },
        }),
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
      list: (companyId, filter) =>
        tx.site.findMany({
          where: {
            companyId,
            ...(filter?.status ? { status: filter.status } : {}),
            ...(filter?.projectId ? { projectId: filter.projectId } : {}),
          },
          orderBy: { id: 'asc' },
        }),
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

import type {
  Department,
  DepartmentStatus,
  Employee,
  HeadOffice,
  PrismaClient,
  ScopeType,
} from '@prisma/client';
import type { DepartmentCategory, Prisma } from '@prisma/client';
import { mapOrgWriteError } from '../organization/errors.js';
import {
  makeOrgRepos,
  scopedUpdate,
  type AuditRepository,
  type CompanyRepository,
  type OrgRepos,
  type ProjectRepository,
  type SiteRepository,
} from '../organization/repository.js';

type Tx = Prisma.TransactionClient;

/** Department row + embedded base head office for detail reads. */
export interface DepartmentDetail extends Department {
  baseHeadOffice: { id: string; code: string; name: string; isPrimary: boolean } | null;
}

export interface DepartmentScopeFilter {
  projectIds: string[];
  headOfficeIds: string[];
  siteIds: string[];
}

export interface DepartmentRepository {
  findById(companyId: string, id: string): Promise<Department | null>;
  /** Detail read: the row plus a slim baseHeadOffice embed. */
  findDetail(companyId: string, id: string): Promise<DepartmentDetail | null>;
  list(
    companyId: string,
    filter?: {
      status?: DepartmentStatus;
      projectId?: string;
      siteId?: string;
      scopeFilter?: DepartmentScopeFilter;
    },
  ): Promise<DepartmentDetail[]>;
  create(
    companyId: string,
    data: {
      scopeType: ScopeType;
      projectId?: string;
      siteId?: string;
      code: string;
      name: string;
      category?: DepartmentCategory;
      categoryLabel?: string;
      capabilityKey?: string;
      headEmployeeId?: string;
      baseHeadOfficeId?: string;
    },
  ): Promise<Department>;
  update(
    companyId: string,
    id: string,
    data: Record<string, unknown>,
    expectedVersion?: number,
  ): Promise<Department>;
  /** Enable the reviewed leadership-inheritable operation set on a new
   *  PROJECT/SITE department — PI/PD role coverage and member inheritance
   *  both derive from these rows. Called inside the create transaction. */
  seedDefaultOperations(
    companyId: string,
    departmentId: string,
    scopeType: ScopeType,
  ): Promise<number>;
  /** Clear headEmployeeId only when the given employee currently holds it —
   *  used when their membership in this department ends/transfers. */
  clearHeadIf(companyId: string, id: string, employeeId: string): Promise<{ count: number }>;
}

export interface EmployeeRepository {
  findById(companyId: string, id: string): Promise<Employee | null>;
}

// Department repos reuse the organization's scope-first repos (parent lookups,
// audit) inside the same transaction client.
export interface DepartmentRepos {
  departments: DepartmentRepository;
  employees: EmployeeRepository;
  /** Minimal membership probe for head-eligibility checks — scoped to one
   *  department, never a general roster. */
  memberships: {
    hasActive(
      companyId: string,
      departmentId: string,
      employeeId: string,
      at: Date,
    ): Promise<boolean>;
  };
  companies: CompanyRepository;
  projects: ProjectRepository;
  sites: SiteRepository;
  headOffices: { findById(companyId: string, id: string): Promise<HeadOffice | null> };
  audit: AuditRepository;
}

export interface DepartmentUnitOfWork {
  run<T>(fn: (repos: DepartmentRepos) => Promise<T>): Promise<T>;
}

export function makeDepartmentRepos(tx: Tx): DepartmentRepos {
  const org: OrgRepos = makeOrgRepos(tx);
  return {
    companies: org.companies,
    projects: org.projects,
    sites: org.sites,
    headOffices: org.headOffices,
    audit: org.audit,
    departments: {
      findById: (companyId, id) => tx.department.findFirst({ where: { id, companyId } }),
      findDetail: (companyId, id) =>
        tx.department.findFirst({
          where: { id, companyId },
          include: {
            baseHeadOffice: { select: { id: true, code: true, name: true, isPrimary: true } },
          },
        }),
      list: (companyId, filter) => {
        const sf = filter?.scopeFilter;
        const scopeOr = sf
          ? [
              ...(sf.siteIds.length > 0 ? [{ siteId: { in: sf.siteIds } }] : []),
              ...(sf.projectIds.length > 0
                ? [{ projectId: { in: sf.projectIds } }, { site: { projectId: { in: sf.projectIds } } }]
                : []),
              ...(sf.headOfficeIds.length > 0
                ? [{ baseHeadOfficeId: { in: sf.headOfficeIds } }]
                : []),
            ]
          : null;
        return tx.department.findMany({
          where: {
            companyId,
            ...(filter?.status ? { status: filter.status } : {}),
            // A project filter covers the project's own departments plus
            // departments scoped to its child sites.
            ...(filter?.projectId
              ? { OR: [{ projectId: filter.projectId }, { site: { projectId: filter.projectId } }] }
              : {}),
            ...(filter?.siteId ? { siteId: filter.siteId } : {}),
            ...(scopeOr !== null ? { OR: scopeOr } : {}),
          },
          include: {
            baseHeadOffice: { select: { id: true, code: true, name: true, isPrimary: true } },
          },
          orderBy: { id: 'asc' },
        });
      },
      create: async (companyId, data) => {
        try {
          return await tx.department.create({ data: { ...data, companyId } });
        } catch (error) {
          mapOrgWriteError(error, 'DEPARTMENT');
        }
      },
      update: (companyId, id, data, expectedVersion) =>
        scopedUpdate(
          'DEPARTMENT',
          { id, companyId },
          data,
          expectedVersion,
          (args) => tx.department.updateMany(args),
          () => tx.department.findFirst({ where: { id, companyId } }),
        ),
      clearHeadIf: (companyId, id, employeeId) =>
        tx.department.updateMany({
          where: { id, companyId, headEmployeeId: employeeId },
          data: { headEmployeeId: null, version: { increment: 1 } },
        }),
      seedDefaultOperations: (companyId, departmentId, scopeType) =>
        tx.$executeRaw`
          INSERT INTO "DepartmentOperation" ("id", "companyId", "departmentId", "operationKey")
          SELECT gen_random_uuid(), ${companyId}::uuid, ${departmentId}::uuid, "key"
          FROM "OperationCatalogueEntry"
          WHERE "sensitive" = FALSE
            AND "leadershipInheritable" = TRUE
            AND ${scopeType}::"ScopeType" = ANY("appliesTo")
          ON CONFLICT ("companyId", "departmentId", "operationKey") DO NOTHING`,
    },
    memberships: {
      hasActive: async (companyId, departmentId, employeeId, at) =>
        (await tx.departmentMembership.count({
          where: {
            companyId,
            departmentId,
            employeeId,
            startedAt: { lte: at },
            OR: [{ endedAt: null }, { endedAt: { gt: at } }],
          },
        })) > 0,
    },
    employees: {
      findById: (companyId, id) => tx.employee.findFirst({ where: { id, companyId } }),
    },
  };
}

export class PrismaDepartmentUnitOfWork implements DepartmentUnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}

  run<T>(fn: (repos: DepartmentRepos) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(makeDepartmentRepos(tx)));
  }
}

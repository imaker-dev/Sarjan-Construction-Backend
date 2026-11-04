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

export interface DepartmentRepository {
  findById(companyId: string, id: string): Promise<Department | null>;
  list(
    companyId: string,
    filter?: { status?: DepartmentStatus; projectId?: string; siteId?: string },
  ): Promise<Department[]>;
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
}

export interface EmployeeRepository {
  findById(companyId: string, id: string): Promise<Employee | null>;
}

// Department repos reuse the organization's scope-first repos (parent lookups,
// audit) inside the same transaction client.
export interface DepartmentRepos {
  departments: DepartmentRepository;
  employees: EmployeeRepository;
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
      list: (companyId, filter) =>
        tx.department.findMany({
          where: {
            companyId,
            ...(filter?.status ? { status: filter.status } : {}),
            ...(filter?.projectId ? { projectId: filter.projectId } : {}),
            ...(filter?.siteId ? { siteId: filter.siteId } : {}),
          },
          orderBy: { id: 'asc' },
        }),
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

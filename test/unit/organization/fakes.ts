import type { Company, HeadOffice, Project, Site } from '@prisma/client';
import type {
  AuditRepository,
  CompanyRepository,
  HeadOfficeRepository,
  OrgRepos,
  OrgUnitOfWork,
  ProjectRepository,
  SiteRepository,
} from '../../../src/modules/organization/repository.js';
import {
  DuplicateCodeError,
  VersionConflictError,
} from '../../../src/modules/organization/errors.js';
import type { AuditRecord } from '../../../src/modules/organization/types.js';

// Minimal row shape — the service only reads these fields. Test rows are cast
// to Prisma model types at the repository boundary.
export interface Row {
  id: string;
  companyId?: string;
  headOfficeId?: string;
  projectId?: string;
  code?: string;
  name?: string;
  status: string;
  version: number;
  [key: string]: unknown;
}

export interface Store {
  companies: Row[];
  headOffices: Row[];
  projects: Row[];
  sites: Row[];
  departments: Row[];
  auditLog: AuditRecord[];
}

export function emptyStore(): Store {
  return { companies: [], headOffices: [], projects: [], sites: [], departments: [], auditLog: [] };
}

let nextId = 0;
function genId() {
  return `id-${++nextId}`;
}

const asCompany = (r: Row) => r as unknown as Company;
const asCompanyOrNull = (r: Row | undefined | null) =>
  r == null ? null : (r as unknown as Company);
const asHeadOffice = (r: Row) => r as unknown as HeadOffice;
const asHeadOfficeOrNull = (r: Row | undefined | null) =>
  r == null ? null : (r as unknown as HeadOffice);
const asProject = (r: Row) => r as unknown as Project;
const asProjectOrNull = (r: Row | undefined | null) =>
  r == null ? null : (r as unknown as Project);
const asSite = (r: Row) => r as unknown as Site;
const asSiteOrNull = (r: Row | undefined | null) => (r == null ? null : (r as unknown as Site));

function findScoped(rows: Row[], companyId: string, id: string): Row | undefined {
  const row = rows.find((r) => r.id === id && (r.companyId ?? r.id) === companyId);
  // Return a copy so callers never share mutable row state with the store.
  return row === undefined ? undefined : { ...row };
}

function updateScoped(
  rows: Row[],
  companyId: string,
  id: string,
  data: Record<string, unknown>,
  expectedVersion: number | undefined,
  entityType: 'COMPANY' | 'HEAD_OFFICE' | 'PROJECT' | 'SITE',
): Row {
  const row = rows.find((r) => r.id === id && (r.companyId ?? r.id) === companyId);
  if (!row) throw new VersionConflictError(entityType);
  if (expectedVersion !== undefined && row.version !== expectedVersion) {
    throw new VersionConflictError(entityType);
  }
  Object.assign(row, data);
  row.version += 1;
  return { ...row };
}

export function makeFakeRepos(
  store: Store,
  auditBehavior?: (entry: AuditRecord) => void,
): OrgRepos {
  const audit: AuditRepository = {
    record: async (entry) => {
      auditBehavior?.(entry);
      store.auditLog.push(entry);
    },
  };

  const companies: CompanyRepository = {
    findById: async (companyId, id) => asCompanyOrNull(findScoped(store.companies, companyId, id)),
    findByCode: async (code) => asCompanyOrNull(store.companies.find((r) => r.code === code)),
    create: async (data) => {
      if (store.companies.some((r) => r.code === data.code)) {
        throw new DuplicateCodeError('COMPANY');
      }
      const row: Row = { id: genId(), status: 'ACTIVE', version: 0, ...data };
      store.companies.push(row);
      return asCompany({ ...row });
    },
    update: async (companyId, id, data, expectedVersion) =>
      asCompany(updateScoped(store.companies, companyId, id, data, expectedVersion, 'COMPANY')),
  };

  const headOffices: HeadOfficeRepository = {
    findById: async (companyId, id) =>
      asHeadOfficeOrNull(findScoped(store.headOffices, companyId, id)),
    list: async (companyId, filter) =>
      store.headOffices
        .filter((r) => r.companyId === companyId && (!filter?.status || r.status === filter.status))
        .map(asHeadOffice),
    create: async (companyId, data) => {
      if (store.headOffices.some((r) => r.companyId === companyId && r.code === data.code)) {
        throw new DuplicateCodeError('HEAD_OFFICE');
      }
      const row: Row = { id: genId(), companyId, status: 'ACTIVE', version: 0, ...data };
      store.headOffices.push(row);
      return asHeadOffice({ ...row });
    },
    update: async (companyId, id, data, expectedVersion) =>
      asHeadOffice(
        updateScoped(store.headOffices, companyId, id, data, expectedVersion, 'HEAD_OFFICE'),
      ),
    clearOtherPrimaries: async (companyId, exceptId) => {
      for (const r of store.headOffices) {
        if (r.companyId === companyId && r.isPrimary && r.id !== exceptId) r.isPrimary = false;
      }
    },
  };

  const projects: ProjectRepository = {
    findById: async (companyId, id) => asProjectOrNull(findScoped(store.projects, companyId, id)),
    list: async (companyId, filter) =>
      store.projects
        .filter(
          (r) =>
            r.companyId === companyId &&
            (!filter?.status || r.status === filter.status) &&
            (!filter?.headOfficeId || r.headOfficeId === filter.headOfficeId),
        )
        .map(asProject),
    create: async (companyId, headOfficeId, data) => {
      if (store.projects.some((r) => r.companyId === companyId && r.code === data.code)) {
        throw new DuplicateCodeError('PROJECT');
      }
      const row: Row = {
        id: genId(),
        companyId,
        headOfficeId,
        status: 'PLANNED',
        version: 0,
        ...data,
      };
      store.projects.push(row);
      return asProject({ ...row });
    },
    update: async (companyId, id, data, expectedVersion) =>
      asProject(updateScoped(store.projects, companyId, id, data, expectedVersion, 'PROJECT')),
  };

  const sites: SiteRepository = {
    findById: async (companyId, id) => asSiteOrNull(findScoped(store.sites, companyId, id)),
    list: async (companyId, filter) =>
      store.sites
        .filter(
          (r) =>
            r.companyId === companyId &&
            (!filter?.status || r.status === filter.status) &&
            (!filter?.projectId || r.projectId === filter.projectId),
        )
        .map(asSite),
    create: async (companyId, projectId, data) => {
      if (store.sites.some((r) => r.projectId === projectId && r.code === data.code)) {
        throw new DuplicateCodeError('SITE');
      }
      const row: Row = {
        id: genId(),
        companyId,
        projectId,
        status: 'ACTIVE',
        version: 0,
        ...data,
      };
      store.sites.push(row);
      return asSite({ ...row });
    },
    update: async (companyId, id, data, expectedVersion) =>
      asSite(updateScoped(store.sites, companyId, id, data, expectedVersion, 'SITE')),
  };

  const departments = {
    countByCategory: async (companyId: string, scopeType: string, categories: string[]) =>
      store.departments.filter(
        (d) =>
          d.companyId === companyId &&
          d.scopeType === scopeType &&
          categories.includes(d.category as string),
      ).length,
  };
  return { companies, headOffices, projects, sites, departments, audit };
}

// Simulates transaction semantics: a snapshot restore on failure, so a failed
// write leaves the store exactly as before (audit included).
export class FakeUnitOfWork implements OrgUnitOfWork {
  constructor(
    public readonly store: Store,
    private readonly auditBehavior?: (entry: AuditRecord) => void,
  ) {}

  async run<T>(fn: (repos: OrgRepos) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.store);
    try {
      return await fn(makeFakeRepos(this.store, this.auditBehavior));
    } catch (error) {
      this.store.companies = snapshot.companies;
      this.store.headOffices = snapshot.headOffices;
      this.store.projects = snapshot.projects;
      this.store.sites = snapshot.sites;
      this.store.auditLog = snapshot.auditLog;
      throw error;
    }
  }
}

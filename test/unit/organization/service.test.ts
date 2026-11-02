import { describe, it, expect, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { OrganizationService } from '../../../src/modules/organization/service.js';
import {
  DuplicateCodeError,
  InvalidStatusTransitionError,
  OrgEntityNotFoundError,
  OrgValidationError,
  VersionConflictError,
  mapOrgWriteError,
} from '../../../src/modules/organization/errors.js';
import {
  assertValidTimezone,
  normalizeCode,
  normalizeName,
} from '../../../src/modules/organization/validation.js';
import {
  COMPANY_TRANSITIONS,
  ORG_NODE_TRANSITIONS,
  PROJECT_TRANSITIONS,
} from '../../../src/modules/organization/lifecycle.js';
import type { ActorContext } from '../../../src/modules/organization/types.js';
import { emptyStore, FakeUnitOfWork, makeFakeRepos, type Store } from './fakes.js';

const actor: ActorContext = { actorId: 'actor-1', actorType: 'SYSTEM', correlationId: 'corr-1' };

let store: Store;
let service: OrganizationService;

beforeEach(() => {
  store = emptyStore();
  service = new OrganizationService(new FakeUnitOfWork(store));
});

describe('code and name validation', () => {
  it('normalizes codes to trimmed uppercase', () => {
    expect(normalizeCode('  hq-01 ')).toBe('HQ-01');
    expect(normalizeCode('site_a')).toBe('SITE_A');
  });

  it('rejects invalid codes', () => {
    for (const bad of ['', '   ', '-ABC', 'a'.repeat(31), 'has space', 'tamilஅ']) {
      expect(() => normalizeCode(bad)).toThrow(OrgValidationError);
    }
  });

  it('trims names and rejects empty/oversized names', () => {
    expect(normalizeName('  Head Office ')).toBe('Head Office');
    expect(() => normalizeName('   ')).toThrow(OrgValidationError);
    expect(() => normalizeName('x'.repeat(201))).toThrow(OrgValidationError);
  });
});

describe('timezone validation', () => {
  it('accepts valid IANA names and rejects others', () => {
    expect(assertValidTimezone('Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(assertValidTimezone('UTC')).toBe('UTC');
    expect(() => assertValidTimezone('Mars/Olympus')).toThrow(OrgValidationError);
    expect(() => assertValidTimezone('')).toThrow(OrgValidationError);
  });
});

describe('status transitions', () => {
  it('defines no outgoing transitions from terminal states', () => {
    expect(COMPANY_TRANSITIONS.ARCHIVED).toEqual([]);
    expect(ORG_NODE_TRANSITIONS.ARCHIVED).toEqual([]);
    expect(PROJECT_TRANSITIONS.ARCHIVED).toEqual([]);
  });

  it('applies valid transitions and rejects invalid ones', async () => {
    const company = await service.createCompany(actor, { code: 'c1', name: 'Co' });
    const suspended = await service.transitionCompanyStatus(actor, company.id, 'SUSPENDED');
    expect(suspended.status).toBe('SUSPENDED');

    await expect(
      service.transitionCompanyStatus(actor, company.id, 'ACTIVE'),
    ).resolves.toBeDefined();
    await expect(service.transitionCompanyStatus(actor, company.id, 'BOGUS')).rejects.toThrow(
      InvalidStatusTransitionError,
    );
  });

  it('rejects direct PLANNED -> COMPLETED for projects', async () => {
    const company = await service.createCompany(actor, { code: 'c1', name: 'Co' });
    const ho = await service.createHeadOffice(actor, company.id, { code: 'ho', name: 'HO' });
    const project = await service.createProject(actor, company.id, ho.id, {
      code: 'p1',
      name: 'P1',
      timezone: 'Asia/Kolkata',
    });
    await expect(
      service.transitionProjectStatus(actor, company.id, project.id, 'COMPLETED'),
    ).rejects.toThrow(InvalidStatusTransitionError);
    await service.transitionProjectStatus(actor, company.id, project.id, 'ACTIVE');
    const completed = await service.transitionProjectStatus(
      actor,
      company.id,
      project.id,
      'COMPLETED',
    );
    expect(completed.status).toBe('COMPLETED');
  });
});

describe('uniqueness and conflict mapping', () => {
  it('maps Prisma P2002 to DuplicateCodeError', () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: '6.19.3',
    });
    expect(() => mapOrgWriteError(p2002, 'COMPANY')).toThrow(DuplicateCodeError);
    const other = new Error('boom');
    expect(() => mapOrgWriteError(other, 'COMPANY')).toThrow(other);
  });

  it('rejects duplicate company codes', async () => {
    await service.createCompany(actor, { code: 'dup', name: 'One' });
    await expect(service.createCompany(actor, { code: 'DUP', name: 'Two' })).rejects.toThrow(
      DuplicateCodeError,
    );
  });

  it('allows the same head-office code in different companies', async () => {
    const a = await service.createCompany(actor, { code: 'ca', name: 'A' });
    const b = await service.createCompany(actor, { code: 'cb', name: 'B' });
    await service.createHeadOffice(actor, a.id, { code: 'ho', name: 'HO A' });
    await expect(
      service.createHeadOffice(actor, b.id, { code: 'ho', name: 'HO B' }),
    ).resolves.toBeDefined();
    await expect(
      service.createHeadOffice(actor, a.id, { code: 'HO', name: 'Again' }),
    ).rejects.toThrow(DuplicateCodeError);
  });
});

describe('tenant isolation', () => {
  it('rejects a project under a head office from another company', async () => {
    const a = await service.createCompany(actor, { code: 'ca', name: 'A' });
    const b = await service.createCompany(actor, { code: 'cb', name: 'B' });
    const hoA = await service.createHeadOffice(actor, a.id, { code: 'ho', name: 'HO A' });
    // hoA belongs to company A; creating under company B's scope must fail.
    await expect(
      service.createProject(actor, b.id, hoA.id, {
        code: 'p1',
        name: 'P',
        timezone: 'UTC',
      }),
    ).rejects.toThrow(OrgEntityNotFoundError);
  });

  it('rejects a site under a project from another company', async () => {
    const a = await service.createCompany(actor, { code: 'ca', name: 'A' });
    const b = await service.createCompany(actor, { code: 'cb', name: 'B' });
    const ho = await service.createHeadOffice(actor, a.id, { code: 'ho', name: 'HO' });
    const project = await service.createProject(actor, a.id, ho.id, {
      code: 'p1',
      name: 'P',
      timezone: 'UTC',
    });
    await expect(
      service.createSite(actor, b.id, project.id, { code: 's1', name: 'S' }),
    ).rejects.toThrow(OrgEntityNotFoundError);
  });

  it("scoped lookups do not return another tenant's record", async () => {
    const a = await service.createCompany(actor, { code: 'ca', name: 'A' });
    const b = await service.createCompany(actor, { code: 'cb', name: 'B' });
    const ho = await service.createHeadOffice(actor, a.id, { code: 'ho', name: 'HO' });
    expect(await service.getCompany(b.id, a.id)).toBeNull();
    expect(
      await service.listHeadOffices(b.id).then((rows) => rows.find((r) => r.id === ho.id)),
    ).toBeUndefined();
    await expect(
      service.transitionHeadOfficeStatus(actor, b.id, ho.id, 'INACTIVE'),
    ).rejects.toThrow(OrgEntityNotFoundError);
  });
});

describe('audit and transaction semantics', () => {
  it('writes an audit record for each successful mutation', async () => {
    const company = await service.createCompany(actor, { code: 'c1', name: 'Co' });
    expect(store.auditLog).toHaveLength(1);
    const entry = store.auditLog[0];
    expect(entry?.action).toBe('ORG_COMPANY_CREATED');
    expect(entry?.entityType).toBe('COMPANY');
    expect(entry?.entityId).toBe(company.id);
    expect(entry?.companyId).toBe(company.id);
    expect(entry?.actorId).toBe('actor-1');
    expect(entry?.correlationId).toBe('corr-1');
    expect(entry?.eventKey).toBeTruthy();
    expect(entry?.statusAfter).toBe('ACTIVE');
  });

  it('rolls back the business write when the audit write fails', async () => {
    const failing = new OrganizationService(
      new FakeUnitOfWork(store, () => {
        throw new Error('audit write failed');
      }),
    );
    await expect(failing.createCompany(actor, { code: 'c1', name: 'Co' })).rejects.toThrow(
      'audit write failed',
    );
    expect(store.companies).toHaveLength(0);
    expect(store.auditLog).toHaveLength(0);
  });

  it('rejects stale-version updates', async () => {
    const company = await service.createCompany(actor, { code: 'c1', name: 'Co' });
    await service.updateCompany(actor, company.id, { name: 'Renamed' }, company.version);
    await expect(
      service.updateCompany(actor, company.id, { name: 'Again' }, company.version),
    ).rejects.toThrow(VersionConflictError);
  });
});

describe('repository safety surface', () => {
  it('exposes no delete methods', () => {
    const repos = makeFakeRepos(store);
    for (const repo of Object.values(repos) as object[]) {
      for (const key of Object.keys(repo)) {
        expect(key.toLowerCase()).not.toContain('delete');
        expect(key.toLowerCase()).not.toContain('remove');
      }
    }
    expect('update' in repos.audit).toBe(false);
    expect('delete' in repos.audit).toBe(false);
  });
});

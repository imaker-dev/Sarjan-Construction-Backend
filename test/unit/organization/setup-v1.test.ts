import { describe, it, expect, beforeEach } from 'vitest';
import { OrganizationService } from '../../../src/modules/organization/service.js';
import { DepartmentService } from '../../../src/modules/department/service.js';
import { emptyStore, FakeUnitOfWork } from './fakes.js';
import { emptyDeptStore, FakeDeptUoW, FakeAuthorizer } from '../department/fakes.js';
import {
  OrgEntityNotFoundError,
  OrgValidationError,
} from '../../../src/modules/organization/errors.js';
import type { HeadOffice } from '@prisma/client';
import type { ActorContext } from '../../../src/modules/organization/types.js';

const actor: ActorContext = { actorId: 'p1', actorType: 'USER' };

const seedCompany = (store: ReturnType<typeof emptyStore>) =>
  store.companies.push({ id: 'c1', status: 'ACTIVE', version: 0 });

describe('primary head office', () => {
  it('promoting a new primary demotes the incumbent in the same tx', async () => {
    const store = emptyStore();
    seedCompany(store);
    const svc = new OrganizationService(new FakeUnitOfWork(store));
    const ho1 = await svc.createHeadOffice(actor, 'c1', {
      code: 'HO1',
      name: 'H1',
      isPrimary: true,
    });
    const ho2 = await svc.createHeadOffice(actor, 'c1', {
      code: 'HO2',
      name: 'H2',
      isPrimary: true,
    });
    const primaries = store.headOffices.filter((h) => (h as HeadOffice).isPrimary);
    expect(primaries).toHaveLength(1);
    expect((primaries[0] as HeadOffice).id).toBe(ho2.id);
    // update path: promote ho1 again
    await svc.updateHeadOffice(actor, 'c1', ho1.id, { isPrimary: true });
    expect(
      store.headOffices.filter((h) => (h as HeadOffice).isPrimary).map((h) => (h as HeadOffice).id),
    ).toEqual([ho1.id]);
  });

  it('rejects archiving the last primary head office', async () => {
    const store = emptyStore();
    seedCompany(store);
    const svc = new OrganizationService(new FakeUnitOfWork(store));
    const ho = await svc.createHeadOffice(actor, 'c1', {
      code: 'HO',
      name: 'HQ',
      isPrimary: true,
    });
    await expect(svc.transitionHeadOfficeStatus(actor, 'c1', ho.id, 'ARCHIVED')).rejects.toThrow(
      OrgValidationError,
    );
  });
});

describe('department baseHeadOfficeId (location, not scope)', () => {
  let store: ReturnType<typeof emptyDeptStore>;
  let svc: DepartmentService;
  beforeEach(() => {
    store = emptyDeptStore();
    svc = new DepartmentService(new FakeDeptUoW(store), new FakeAuthorizer());
  });

  it('accepts a same-company head office as base location', async () => {
    store.headOffices.push({ id: 'ho1', companyId: 'c1' } as HeadOffice);
    const dept = await svc.createDepartment(actor, 'c1', {
      scopeType: 'COMPANY',
      code: 'FIN',
      name: 'Finance',
      baseHeadOfficeId: 'ho1',
    });
    expect(dept.baseHeadOfficeId).toBe('ho1');
    expect(dept.scopeType).toBe('COMPANY');
  });

  it('rejects an unknown or cross-company head office', async () => {
    store.headOffices.push({ id: 'ho-x', companyId: 'c2' } as HeadOffice);
    await expect(
      svc.createDepartment(actor, 'c1', {
        scopeType: 'COMPANY',
        code: 'FIN',
        name: 'Finance',
        baseHeadOfficeId: 'ho-x',
      }),
    ).rejects.toThrow(OrgEntityNotFoundError);
  });
});

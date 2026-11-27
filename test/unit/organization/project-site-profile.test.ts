import { describe, it, expect, beforeEach } from 'vitest';
import { OrganizationService } from '../../../src/modules/organization/service.js';
import {
  OrgValidationError,
  OrgEntityNotFoundError,
} from '../../../src/modules/organization/errors.js';
import type { ActorContext } from '../../../src/modules/organization/types.js';
import { emptyStore, FakeUnitOfWork, type Store } from './fakes.js';

const actor: ActorContext = { actorId: 'actor-1', actorType: 'SYSTEM', correlationId: 'corr-1' };

let store: Store;
let service: OrganizationService;

const seedCompany = async () => {
  const company = await service.createCompany(actor, { code: 'c1', name: 'Co' });
  await service.createHeadOffice(actor, company.id, { code: 'ho', name: 'HO', isPrimary: true });
  store.departments.push(
    {
      companyId: company.id,
      scopeType: 'COMPANY',
      category: 'FINANCE',
      id: 'd1',
      status: 'ACTIVE',
      version: 0,
    },
    {
      companyId: company.id,
      scopeType: 'COMPANY',
      category: 'ADMINISTRATION',
      id: 'd2',
      status: 'ACTIVE',
      version: 0,
    },
  );
  return company.id;
};

beforeEach(() => {
  store = emptyStore();
  service = new OrganizationService(new FakeUnitOfWork(store));
});

describe('extended project profile', () => {
  it('persists comprehensive fields on create', async () => {
    const companyId = await seedCompany();
    const project = await service.createProject(actor, companyId, {
      code: 'p1',
      name: 'Skyline',
      timezone: 'Asia/Kolkata',
      projectSubtype: 'High-rise',
      contractType: 'LUMPSUM',
      clientContactEmail: 'pm@client.example',
      contractValue: '142500000.00',
      contractCurrency: 'INR',
      landArea: '12500.00',
      landAreaUnit: 'SQM',
      numBuildings: 2,
      geoLatitude: 25.56,
      geoLongitude: 84.86,
      ntpDate: new Date('2026-12-01'),
    });
    expect(project.projectSubtype).toBe('High-rise');
    expect(project.contractValue).toBe('142500000.00');
    expect(store.auditLog.some((a) => a.action === 'ORG_PROJECT_CREATED')).toBe(true);
  });

  it('rejects contractValue without currency and landArea without unit', async () => {
    const companyId = await seedCompany();
    await expect(
      service.createProject(actor, companyId, {
        code: 'p1',
        name: 'P',
        timezone: 'Asia/Kolkata',
        contractValue: '100.00',
      }),
    ).rejects.toThrow(OrgValidationError);
    await expect(
      service.createProject(actor, companyId, {
        code: 'p1',
        name: 'P',
        timezone: 'Asia/Kolkata',
        landArea: '500.00',
      }),
    ).rejects.toThrow(OrgValidationError);
    expect(store.projects).toHaveLength(0); // atomic: nothing persisted
  });

  it('rejects malformed decimals and half geo pairs', async () => {
    const companyId = await seedCompany();
    await expect(
      service.createProject(actor, companyId, {
        code: 'p1',
        name: 'P',
        timezone: 'Asia/Kolkata',
        builtUpArea: '-12',
      }),
    ).rejects.toThrow(OrgValidationError);
    await expect(
      service.createProject(actor, companyId, {
        code: 'p1',
        name: 'P',
        timezone: 'Asia/Kolkata',
        geoLatitude: 25.5,
      }),
    ).rejects.toThrow(OrgValidationError);
  });

  it('clears fields with explicit null on update and keeps merged invariants', async () => {
    const companyId = await seedCompany();
    const project = await service.createProject(actor, companyId, {
      code: 'p1',
      name: 'P',
      timezone: 'Asia/Kolkata',
      contractValue: '1000.00',
      contractCurrency: 'INR',
    });
    // Clearing the currency while a value remains must fail merged check.
    await expect(
      service.updateProject(actor, companyId, project.id, { contractCurrency: null }),
    ).rejects.toThrow(OrgValidationError);
    const updated = (await service.updateProject(actor, companyId, project.id, {
      contractValue: null,
      contractCurrency: null,
      projectSubtype: 'Villa',
    })) as { contractValue: string | null; projectSubtype: string | null };
    expect(updated.contractValue).toBeNull();
    expect(updated.projectSubtype).toBe('Villa');
  });
});

describe('initialBudget', () => {
  const budget = {
    code: 'base',
    name: 'Initial estimate',
    currency: 'INR',
    lines: [
      { category: 'MATERIAL', description: 'Materials', amount: '80000000.00' },
      { category: 'LABOUR', description: 'Labour', amount: '30000000.00' },
    ],
  };

  it('fails closed when the finance gate is not wired', async () => {
    const companyId = await seedCompany();
    await expect(
      service.createProject(actor, companyId, {
        code: 'p1',
        name: 'P',
        timezone: 'Asia/Kolkata',
        initialBudget: budget,
      }),
    ).rejects.toThrow(OrgValidationError);
    expect(store.projects).toHaveLength(0);
  });

  it('denies when the actor lacks budget authority — project rolls back', async () => {
    service = new OrganizationService(new FakeUnitOfWork(store), {
      assertInitialBudgetAuthority: async () => {
        throw new Error('forbidden');
      },
    });
    const companyId = await seedCompany();
    await expect(
      service.createProject(actor, companyId, {
        code: 'p1',
        name: 'P',
        timezone: 'Asia/Kolkata',
        initialBudget: budget,
      }),
    ).rejects.toThrow('forbidden');
    expect(store.projects).toHaveLength(0);
    expect(store.budgets).toHaveLength(0);
  });

  it('creates a DRAFT budget+revision atomically with server-side total', async () => {
    const calls: string[] = [];
    service = new OrganizationService(new FakeUnitOfWork(store), {
      assertInitialBudgetAuthority: async (_a, cid) => {
        calls.push(cid);
      },
    });
    const companyId = await seedCompany();
    const result = await service.createProject(actor, companyId, {
      code: 'p1',
      name: 'P',
      timezone: 'Asia/Kolkata',
      initialBudget: { ...budget, notes: 'per tender' },
    });
    expect(calls).toEqual([companyId]);
    const created = result as unknown as { id: string; initialBudget: { totalAmount: string } };
    expect(created.initialBudget.totalAmount).toBe('110000000.00');
    expect(store.budgets).toHaveLength(1);
    expect(store.budgets[0]?.projectId).toBe(created.id);
    expect(store.revisions).toHaveLength(1);
    expect(store.revisions[0]?.status).toBe('DRAFT');
    expect(
      store.auditLog.filter((a) => a.action === 'FINANCE_BUDGET_REVISION_CREATED'),
    ).toHaveLength(1);
    expect(store.outbox).toHaveLength(2);
  });
});

describe('land parcels and approvals', () => {
  it('creates nested parcels and approvals in the project transaction', async () => {
    const companyId = await seedCompany();
    await service.createProject(actor, companyId, {
      code: 'p1',
      name: 'P',
      timezone: 'Asia/Kolkata',
      landParcels: [
        {
          surveyNo: 'KH-112',
          area: '8500.00',
          areaUnit: 'SQM',
          possessionDate: new Date('2026-11-01'),
        },
      ],
      approvals: [
        {
          approvalType: 'RERA',
          referenceNo: 'BRERA/1',
          status: 'APPLIED',
          issuingAuthority: 'Bihar RERA',
        },
      ],
    });
    expect(store.landParcels).toHaveLength(1);
    expect(store.approvals).toHaveLength(1);
    expect(store.auditLog.some((a) => a.action === 'ORG_LAND_PARCEL_ADDED')).toBe(true);
    expect(store.auditLog.some((a) => a.action === 'ORG_PROJECT_APPROVAL_RECORDED')).toBe(true);
  });

  it('requires customType when approvalType is OTHER', async () => {
    const companyId = await seedCompany();
    const project = await service.createProject(actor, companyId, {
      code: 'p1',
      name: 'P',
      timezone: 'Asia/Kolkata',
    });
    await expect(
      service.createApproval(actor, companyId, project.id, { approvalType: 'OTHER' }),
    ).rejects.toThrow(OrgValidationError);
    const ok = await service.createApproval(actor, companyId, project.id, {
      approvalType: 'OTHER',
      customType: 'Coastal regulation',
    });
    expect(ok.customType).toBe('Coastal regulation');
  });
});

describe('document register links', () => {
  const linkInput = (documentId: string) => ({
    documentId,
    documentType: 'DRAWING',
    title: 'GA Plan',
    discipline: 'ARCHITECTURAL',
    revision: 'R2',
  });

  it('links an AVAILABLE company-scoped document', async () => {
    const companyId = await seedCompany();
    const project = await service.createProject(actor, companyId, {
      code: 'p1',
      name: 'P',
      timezone: 'Asia/Kolkata',
    });
    store.documents.push({
      id: 'doc-1',
      companyId,
      status: 'AVAILABLE',
      scopeType: 'COMPANY',
      version: 0,
    });
    const link = await service.attachProjectDocument(
      actor,
      companyId,
      project.id,
      linkInput('doc-1'),
    );
    expect(link.title).toBe('GA Plan');
    expect(store.projectDocuments).toHaveLength(1);
  });

  it('rejects non-AVAILABLE and out-of-scope documents', async () => {
    const companyId = await seedCompany();
    const project = await service.createProject(actor, companyId, {
      code: 'p1',
      name: 'P',
      timezone: 'Asia/Kolkata',
    });
    store.documents.push(
      { id: 'doc-draft', companyId, status: 'UPLOADING', scopeType: 'COMPANY', version: 0 },
      {
        id: 'doc-other',
        companyId,
        status: 'AVAILABLE',
        scopeType: 'PROJECT',
        projectId: 'other-project',
        version: 0,
      },
      {
        id: 'doc-ghost',
        companyId: 'other-company',
        status: 'AVAILABLE',
        scopeType: 'COMPANY',
        version: 0,
      },
    );
    await expect(
      service.attachProjectDocument(actor, companyId, project.id, linkInput('doc-draft')),
    ).rejects.toThrow(OrgValidationError);
    await expect(
      service.attachProjectDocument(actor, companyId, project.id, linkInput('doc-other')),
    ).rejects.toThrow(OrgValidationError);
    await expect(
      service.attachProjectDocument(actor, companyId, project.id, linkInput('doc-ghost')),
    ).rejects.toThrow(OrgEntityNotFoundError);
    expect(store.projectDocuments).toHaveLength(0);
  });

  it('site links accept site-scoped and parent-project-scoped documents', async () => {
    const companyId = await seedCompany();
    const project = await service.createProject(actor, companyId, {
      code: 'p1',
      name: 'P',
      timezone: 'Asia/Kolkata',
    });
    const site = (await service.createSite(actor, companyId, project.id, {
      code: 's1',
      name: 'Main',
    })) as { id: string };
    store.documents.push(
      {
        id: 'doc-proj',
        companyId,
        status: 'AVAILABLE',
        scopeType: 'PROJECT',
        projectId: project.id,
        version: 0,
      },
      {
        id: 'doc-site',
        companyId,
        status: 'AVAILABLE',
        scopeType: 'SITE',
        siteId: site.id,
        version: 0,
      },
      {
        id: 'doc-wrong',
        companyId,
        status: 'AVAILABLE',
        scopeType: 'SITE',
        siteId: 'other-site',
        version: 0,
      },
    );
    await expect(
      service.attachSiteDocument(actor, companyId, site.id, linkInput('doc-proj')),
    ).resolves.toBeDefined();
    await expect(
      service.attachSiteDocument(actor, companyId, site.id, linkInput('doc-site')),
    ).resolves.toBeDefined();
    await expect(
      service.attachSiteDocument(actor, companyId, site.id, linkInput('doc-wrong')),
    ).rejects.toThrow(OrgValidationError);
  });
});

describe('site profile and sensitive fields', () => {
  it('persists extended fields; parcel must belong to the same project', async () => {
    const companyId = await seedCompany();
    const p1 = await service.createProject(actor, companyId, {
      code: 'p1',
      name: 'P1',
      timezone: 'Asia/Kolkata',
    });
    const p2 = await service.createProject(actor, companyId, {
      code: 'p2',
      name: 'P2',
      timezone: 'Asia/Kolkata',
    });
    const parcel = await service.createParcel(actor, companyId, p1.id, {
      area: '100.00',
      areaUnit: 'SQM',
    });
    await expect(
      service.createSite(actor, companyId, p2.id, {
        code: 's1',
        name: 'S',
        landParcelId: parcel.id,
      }),
    ).rejects.toThrow(OrgValidationError);
    const site = await service.createSite(actor, companyId, p1.id, {
      code: 's1',
      name: 'S',
      landParcelId: parcel.id,
      siteType: 'MAIN_CONSTRUCTION',
      plotArea: '8500.00',
      areaUnit: 'SQM',
      scopeSummary: 'Tower A',
      accessInstructions: 'Gate code 1234',
      emergencyDetails: 'Assembly at gate 2',
    });
    expect(site.siteType).toBe('MAIN_CONSTRUCTION');
    // Default service has no hasPermission dep → sensitive fields stripped.
    expect('accessInstructions' in site).toBe(false);
    expect('emergencyDetails' in site).toBe(false);
    expect(store.sites[0]?.accessInstructions).toBe('Gate code 1234');
  });

  it('always strips sensitive fields from list responses', async () => {
    const companyId = await seedCompany();
    const project = await service.createProject(actor, companyId, {
      code: 'p1',
      name: 'P',
      timezone: 'Asia/Kolkata',
    });
    await service.createSite(actor, companyId, project.id, {
      code: 's1',
      name: 'S',
      accessInstructions: 'secret gate info',
    });
    const listed = await service.listSites(actor, companyId, { projectId: project.id });
    expect(listed).toHaveLength(1);
    expect('accessInstructions' in (listed[0] ?? {})).toBe(false);
  });

  it('gates sensitive fields on ORG_SITE_SENSITIVE_READ for getSite', async () => {
    service = new OrganizationService(new FakeUnitOfWork(store), {
      hasPermission: async (_pid, key) => key === 'ORG_SITE_SENSITIVE_READ',
    });
    const companyId = await seedCompany();
    const project = await service.createProject(actor, companyId, {
      code: 'p1',
      name: 'P',
      timezone: 'Asia/Kolkata',
    });
    const site = (await service.createSite(actor, companyId, project.id, {
      code: 's1',
      name: 'S',
      accessInstructions: 'Gate code 1234',
    })) as { id: string };
    const detail = (await service.getSite(actor, companyId, site.id)) as {
      accessInstructions?: string;
    };
    expect(detail.accessInstructions).toBe('Gate code 1234');
  });
});

describe('update site validation', () => {
  it('enforces merged plotArea/areaUnit and geo-pair invariants', async () => {
    const companyId = await seedCompany();
    const project = await service.createProject(actor, companyId, {
      code: 'p1',
      name: 'P',
      timezone: 'Asia/Kolkata',
    });
    const site = (await service.createSite(actor, companyId, project.id, {
      code: 's1',
      name: 'S',
      geoLatitude: 25.5,
      geoLongitude: 84.8,
      geoFenceRadiusM: 300,
    })) as { id: string };
    // Clearing longitude while latitude stays must fail the merged pair check.
    await expect(
      service.updateSite(actor, companyId, site.id, { geoLongitude: null }),
    ).rejects.toThrow(OrgValidationError);
    // Clearing the radius + latitude together keeps a valid state.
    const updated = await service.updateSite(actor, companyId, site.id, {
      geoLatitude: null,
      geoLongitude: null,
      geoFenceRadiusM: null,
      plotArea: '500.00',
      areaUnit: 'SQFT',
    });
    expect(updated.geoLatitude).toBeNull();
    expect(updated.plotArea).toBe('500.00');
  });
});

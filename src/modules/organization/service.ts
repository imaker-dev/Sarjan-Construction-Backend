import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type {
  ActorContext,
  AuditRecord,
  CreateCompanyInput,
  CreateHeadOfficeInput,
  CreateProjectInput,
  CreateSiteInput,
  InitialBudgetInput,
  LandParcelInput,
  OrgDocumentLinkInput,
  OrgEntityType,
  ProjectApprovalInput,
  UpdateCompanyInput,
  UpdateHeadOfficeInput,
  UpdateOrgDocumentLinkInput,
  UpdateProjectApprovalInput,
  UpdateProjectInput,
  UpdateSiteInput,
} from './types.js';
import type { OrgDocumentScopeInfo, OrgRepos, OrgUnitOfWork } from './repository.js';
import type { OrgNodeStatus, ProjectStatus } from '@prisma/client';
import type { ScopeTarget } from '../access-control/service.js';
import { OrgEntityNotFoundError, OrgValidationError } from './errors.js';
import {
  assertTransition,
  COMPANY_TRANSITIONS,
  ORG_NODE_TRANSITIONS,
  PROJECT_TRANSITIONS,
} from './lifecycle.js';
import {
  assertCurrencyCode,
  assertDecimalString,
  assertNonNegativeInt,
  assertValidGeoFenceRadius,
  assertValidLatitude,
  assertValidLongitude,
  assertValidTimezone,
  normalizeCode,
  normalizeName,
} from './validation.js';

// Site access instructions / emergency details are security-sensitive: stored
// on Site but serialized only for holders of this permission.
export const ORG_SITE_SENSITIVE_READ = 'ORG_SITE_SENSITIVE_READ';

export interface OrganizationServiceDeps {
  /** Permission probe — used for the site sensitive-field read gate. */
  hasPermission?: (
    principalId: string,
    permissionKey: string,
    target: ScopeTarget,
  ) => Promise<boolean>;
  /**
   * Finance authority gate for nested `initialBudget` creation. Must assert
   * FINANCE_BUDGET_MANAGE + the budget create/revise operations — wired from
   * FinanceService.assertInitialBudgetAuthority in app.ts. Absent → nested
   * budgets fail closed.
   */
  assertInitialBudgetAuthority?: (actor: ActorContext, companyId: string) => Promise<void>;
}

export function auditEntry(
  actor: ActorContext,
  base: Omit<AuditRecord, 'eventKey' | 'actorId' | 'actorType' | 'correlationId'>,
): AuditRecord {
  return {
    eventKey: randomUUID(),
    actorId: actor.actorId,
    actorType: actor.actorType,
    ...(actor.correlationId !== undefined ? { correlationId: actor.correlationId } : {}),
    ...base,
  };
}

export function changedFields(
  patch: Record<string, unknown>,
  existing: Record<string, unknown>,
): Record<string, { before: unknown; after: unknown }> | undefined {
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  for (const [key, after] of Object.entries(patch)) {
    if (after === undefined) continue;
    const before = existing[key];
    // Sensitive identifiers are redacted in audit before/after snapshots.
    if (['pan', 'cin', 'llpin', 'regNumber', 'identifier'].includes(key)) {
      if (before !== after) diff[key] = { before: null, after: '***REDACTED***' };
      continue;
    }
    if (before !== after) diff[key] = { before: before ?? null, after };
  }
  return Object.keys(diff).length > 0 ? diff : undefined;
}

export class OrganizationService {
  constructor(
    private readonly uow: OrgUnitOfWork,
    private readonly deps?: OrganizationServiceDeps,
  ) {}

  // ------------------------------------------------------------------ Company

  async createCompany(actor: ActorContext, input: CreateCompanyInput) {
    const code = normalizeCode(input.code);
    const name = normalizeName(input.name);
    const legalName = input.legalName !== undefined ? input.legalName.trim() : undefined;

    return this.uow.run(async ({ companies, audit }) => {
      const company = await companies.create({
        code,
        name,
        ...(legalName !== undefined && legalName !== '' ? { legalName } : {}),
      });
      await audit.record(
        auditEntry(actor, {
          action: 'ORG_COMPANY_CREATED',
          entityType: 'COMPANY',
          entityId: company.id,
          companyId: company.id,
          statusAfter: company.status,
          changedFields: {
            code: { before: null, after: code },
            name: { before: null, after: name },
          },
        }),
      );
      return company;
    });
  }

  async updateCompany(
    actor: ActorContext,
    companyId: string,
    patch: UpdateCompanyInput,
    expectedVersion?: number,
  ) {
    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data.name = normalizeName(patch.name);
    if (patch.legalName !== undefined) {
      const trimmed = patch.legalName?.trim();
      data.legalName = trimmed !== undefined && trimmed !== '' ? trimmed : null;
    }
    // Profile passthrough — format-checked at the route; PAN/CIN masked in audit.
    const PROFILE_KEYS = [
      'entityType',
      'tradeName',
      'formedOn',
      'pan',
      'cin',
      'llpin',
      'regNumber',
      'website',
      'description',
      'regAddressLine1',
      'regAddressLine2',
      'regLocality',
      'regCity',
      'regDistrict',
      'regStateUt',
      'regPin',
      'regCountry',
      'corrAddressLine1',
      'corrAddressLine2',
      'corrLocality',
      'corrCity',
      'corrDistrict',
      'corrStateUt',
      'corrPin',
      'corrCountry',
      'contactName',
      'contactDesignation',
      'contactEmail',
      'contactPhone',
    ] as const;
    for (const key of PROFILE_KEYS) {
      const v = (patch as Record<string, unknown>)[key];
      if (v !== undefined) data[key] = typeof v === 'string' && v.trim() === '' ? null : v;
    }

    return this.uow.run(async ({ companies, audit }) => {
      const existing = await companies.findById(companyId, companyId);
      if (!existing) throw new OrgEntityNotFoundError('COMPANY');
      // Empty patch: no write, no version bump, no audit row.
      if (Object.keys(data).length === 0) return existing;
      const updated = await companies.update(companyId, companyId, data, expectedVersion);
      await this.recordMutation(
        audit,
        actor,
        'COMPANY',
        'ORG_COMPANY_UPDATED',
        existing,
        updated,
        data,
      );
      return updated;
    });
  }

  async transitionCompanyStatus(
    actor: ActorContext,
    companyId: string,
    to: string,
    expectedVersion?: number,
  ) {
    return this.transition(actor, 'COMPANY', companyId, to, COMPANY_TRANSITIONS, expectedVersion);
  }

  // --------------------------------------------------------------- HeadOffice

  async createHeadOffice(actor: ActorContext, companyId: string, input: CreateHeadOfficeInput) {
    const code = normalizeCode(input.code);
    const name = normalizeName(input.name);

    return this.uow.run(async ({ companies, headOffices, audit }) => {
      const company = await companies.findById(companyId, companyId);
      if (!company) throw new OrgEntityNotFoundError('COMPANY');
      // Promote-by-replacement: demote the incumbent primary first so the
      // partial unique index (one primary per company) is never violated.
      if (input.isPrimary === true) await headOffices.clearOtherPrimaries(companyId);
      const headOffice = await headOffices.create(companyId, {
        code,
        name,
        ...(input.isPrimary !== undefined ? { isPrimary: input.isPrimary } : {}),
        ...(input.legalName !== undefined ? { legalName: input.legalName } : {}),
        ...(input.addressLine1 !== undefined ? { addressLine1: input.addressLine1 } : {}),
        ...(input.addressLine2 !== undefined ? { addressLine2: input.addressLine2 } : {}),
        ...(input.locality !== undefined ? { locality: input.locality } : {}),
        ...(input.city !== undefined ? { city: input.city } : {}),
        ...(input.district !== undefined ? { district: input.district } : {}),
        ...(input.state !== undefined ? { state: input.state } : {}),
        ...(input.pinCode !== undefined ? { pinCode: input.pinCode } : {}),
        ...(input.country !== undefined ? { country: input.country } : {}),
        ...(input.contactName !== undefined ? { contactName: input.contactName } : {}),
        ...(input.contactPhone !== undefined ? { contactPhone: input.contactPhone } : {}),
        ...(input.contactEmail !== undefined ? { contactEmail: input.contactEmail } : {}),
        ...(input.geoLatitude !== undefined ? { geoLatitude: input.geoLatitude } : {}),
        ...(input.geoLongitude !== undefined ? { geoLongitude: input.geoLongitude } : {}),
        ...(input.geoFenceRadiusM !== undefined ? { geoFenceRadiusM: input.geoFenceRadiusM } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      });
      await this.recordMutation(
        audit,
        actor,
        'HEAD_OFFICE',
        'ORG_HEAD_OFFICE_CREATED',
        null,
        headOffice,
        { code, name },
        companyId,
      );
      return headOffice;
    });
  }

  async updateHeadOffice(
    actor: ActorContext,
    companyId: string,
    id: string,
    patch: UpdateHeadOfficeInput,
    expectedVersion?: number,
  ) {
    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data.name = normalizeName(patch.name);
    if (patch.isPrimary !== undefined) data.isPrimary = patch.isPrimary;
    for (const f of [
      'legalName',
      'addressLine1',
      'addressLine2',
      'locality',
      'city',
      'district',
      'state',
      'pinCode',
      'country',
      'contactName',
      'contactPhone',
      'contactEmail',
      'geoLatitude',
      'geoLongitude',
      'geoFenceRadiusM',
      'timezone',
    ] as const) {
      if (patch[f] !== undefined) data[f] = patch[f];
    }

    if (patch.isPrimary === true) {
      // Demote incumbents inside the same transaction before promoting.
      return this.uow.run(async (repos) => {
        const existing = await repos.headOffices.findById(companyId, id);
        if (!existing) throw new OrgEntityNotFoundError('HEAD_OFFICE');
        await repos.headOffices.clearOtherPrimaries(companyId, id);
        const updated = await repos.headOffices.update(companyId, id, data, expectedVersion);
        await this.recordMutation(
          repos.audit,
          actor,
          'HEAD_OFFICE',
          'ORG_HEAD_OFFICE_UPDATED',
          existing,
          updated,
          data,
          companyId,
        );
        return updated;
      });
    }
    return this.updateScoped(
      actor,
      'HEAD_OFFICE',
      'ORG_HEAD_OFFICE_UPDATED',
      companyId,
      id,
      data,
      expectedVersion,
    );
  }

  async transitionHeadOfficeStatus(
    actor: ActorContext,
    companyId: string,
    id: string,
    to: string,
    expectedVersion?: number,
  ) {
    // Pre-check: a primary HO referenced by ACTIVE projects cannot leave
    // ACTIVE (the transition guard re-verifies isPrimary inside the tx; this
    // adds the project-dependency rule — small TOCTOU window, documented).
    if (to !== 'ACTIVE') {
      await this.uow.run(async (repos) => {
        const ho = await repos.headOffices.findById(companyId, id);
        if (!ho) throw new OrgEntityNotFoundError('HEAD_OFFICE');
        if (ho.isPrimary) {
          const active = await repos.projects.list(companyId, {
            headOfficeId: id,
            status: 'ACTIVE',
          });
          if (active.length > 0) {
            throw new OrgValidationError(
              'isPrimary',
              'primary head office is referenced by active projects',
            );
          }
        }
      });
    }
    return this.transition(
      actor,
      'HEAD_OFFICE',
      id,
      to,
      ORG_NODE_TRANSITIONS,
      expectedVersion,
      companyId,
      (existing) => {
        // The last primary Head Office cannot be archived or suspended while
        // it hosts projects — the shared-HO invariant requires a working HO.
        if (to !== 'ACTIVE' && (existing as { isPrimary?: boolean }).isPrimary === true) {
          throw new OrgValidationError(
            'isPrimary',
            'primary head office is referenced by projects and cannot leave ACTIVE',
          );
        }
      },
    );
  }

  // ------------------------------------------------------------------ Project

  async createProject(actor: ActorContext, companyId: string, input: CreateProjectInput) {
    const code = normalizeCode(input.code);
    const name = normalizeName(input.name);
    const timezone = assertValidTimezone(input.timezone);
    if (input.startDate && input.endDate && input.endDate < input.startDate) {
      throw new OrgValidationError('endDate', 'must not be before startDate');
    }
    this.assertProjectProfile(input);

    // Nested estimate requires finance authority — checked BEFORE opening the
    // transaction (fail fast, no dangling project row). ORG_PROJECT_CREATE
    // alone never implies budget rights.
    if (input.initialBudget !== undefined) {
      if (this.deps?.assertInitialBudgetAuthority === undefined) {
        throw new OrgValidationError('initialBudget', 'initial budget creation is unavailable');
      }
      this.assertInitialBudgetInput(input.initialBudget);
      await this.deps.assertInitialBudgetAuthority(actor, companyId);
    }

    return this.uow.run(async (repos) => {
      const { headOffices, projects, departments, audit } = repos;
      // Shared-HO derivation: the project binds to the company's ACTIVE primary
      // Head Office — never trusted from the client body.
      const headOfficesList = await headOffices.list(companyId, { status: 'ACTIVE' });
      const headOffice = headOfficesList.find((h) => h.isPrimary);
      if (!headOffice) {
        throw new OrgValidationError(
          'headOfficeId',
          'company must have an active primary head office before creating projects',
        );
      }
      // Setup prerequisite: company-wide Finance + Administration departments
      // must exist before the first project is created.
      const depts = await departments.countByCategory(companyId, 'COMPANY', [
        'FINANCE',
        'ADMINISTRATION',
      ]);
      if (depts < 2) {
        throw new OrgValidationError(
          'departments',
          'company-wide FINANCE and ADMINISTRATION departments must exist before creating projects',
        );
      }
      const headOfficeId = headOffice.id;
      const project = await projects.create(companyId, headOfficeId, {
        code,
        name,
        timezone,
        ...projectProfileData(input),
      });
      await this.recordMutation(
        audit,
        actor,
        'PROJECT',
        'ORG_PROJECT_CREATED',
        null,
        project,
        { code, name },
        companyId,
      );

      for (const parcel of input.landParcels ?? []) {
        const row = await this.createParcelRow(repos, actor, companyId, project.id, parcel);
        await this.recordMutation(
          audit,
          actor,
          'LAND_PARCEL',
          'ORG_LAND_PARCEL_ADDED',
          null,
          row,
          { projectId: project.id, surveyNo: parcel.surveyNo ?? null, area: parcel.area },
          companyId,
        );
      }
      for (const doc of input.documents ?? []) {
        const link = await this.attachDocumentRow(
          repos,
          actor,
          companyId,
          'PROJECT',
          project.id,
          doc,
        );
        await this.recordMutation(
          audit,
          actor,
          'PROJECT_DOCUMENT',
          'ORG_PROJECT_DOCUMENT_ATTACHED',
          null,
          link,
          { projectId: project.id, documentId: doc.documentId },
          companyId,
        );
      }
      for (const approval of input.approvals ?? []) {
        const row = await this.createApprovalRow(repos, actor, companyId, project.id, approval);
        await this.recordMutation(
          audit,
          actor,
          'PROJECT_APPROVAL',
          'ORG_PROJECT_APPROVAL_RECORDED',
          null,
          row,
          { projectId: project.id, approvalType: approval.approvalType },
          companyId,
        );
      }

      let initialBudget: { budgetId: string; revisionId: string; totalAmount: string } | undefined;
      if (input.initialBudget !== undefined) {
        const ib = input.initialBudget;
        // Server-side total — a client-supplied total is never accepted.
        const totalAmount = ib.lines
          .reduce(
            (acc, l) => acc.plus(assertDecimalString(l.amount, 'initialBudget.lines.amount')),
            new Prisma.Decimal(0),
          )
          .toFixed(2);
        const budget = await repos.budgets.createBudget(companyId, project.id, {
          code: normalizeCode(ib.code, 'initialBudget.code'),
          name: ib.name,
          ...(ib.description !== undefined ? { description: ib.description } : {}),
          currency: assertCurrencyCode(ib.currency, 'initialBudget.currency'),
        });
        const revision = await repos.budgets.createRevision(companyId, budget.id, 1, totalAmount, {
          ...(ib.notes !== undefined ? { notes: ib.notes } : {}),
          lines: ib.lines,
        });
        await repos.audit.record(
          auditEntry(actor, {
            action: 'FINANCE_BUDGET_CREATED',
            entityType: 'PROJECT_BUDGET',
            entityId: budget.id,
            companyId,
            statusAfter: 'ACTIVE',
            changedFields: {
              projectId: { before: null, after: project.id },
              code: { before: null, after: budget.code },
              currency: { before: null, after: budget.currency },
            },
          }),
        );
        await repos.outbox.record({
          companyId,
          eventType: 'FINANCE_BUDGET_CREATED',
          aggregateType: 'PROJECT_BUDGET',
          aggregateId: budget.id,
          eventKey: `evt:${budget.id}:FINANCE_BUDGET_CREATED`,
          recipientPrincipalIds: [],
          summary: { projectId: project.id, code: budget.code, currency: budget.currency },
        });
        await repos.audit.record(
          auditEntry(actor, {
            action: 'FINANCE_BUDGET_REVISION_CREATED',
            entityType: 'BUDGET_REVISION',
            entityId: revision.id,
            companyId,
            statusAfter: 'DRAFT',
            changedFields: {
              budgetId: { before: null, after: budget.id },
              revision: { before: null, after: 1 },
              totalAmount: { before: null, after: totalAmount },
            },
          }),
        );
        await repos.outbox.record({
          companyId,
          eventType: 'FINANCE_BUDGET_REVISION_CREATED',
          aggregateType: 'BUDGET_REVISION',
          aggregateId: revision.id,
          eventKey: `evt:${revision.id}:FINANCE_BUDGET_REVISION_CREATED`,
          recipientPrincipalIds: [],
          summary: { budgetId: budget.id, revision: 1, totalAmount },
        });
        initialBudget = { budgetId: budget.id, revisionId: revision.id, totalAmount };
      }
      return { ...project, ...(initialBudget !== undefined ? { initialBudget } : {}) };
    });
  }

  async updateProject(
    actor: ActorContext,
    companyId: string,
    id: string,
    patch: UpdateProjectInput,
    expectedVersion?: number,
  ) {
    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data.name = normalizeName(patch.name);
    if (patch.timezone !== undefined) data.timezone = assertValidTimezone(patch.timezone);
    if (patch.projectType !== undefined) data.projectType = patch.projectType;
    if (patch.contractType !== undefined) data.contractType = patch.contractType;
    if (patch.landAreaUnit !== undefined) data.landAreaUnit = patch.landAreaUnit;
    if (patch.contractCurrency !== undefined && patch.contractCurrency !== null) {
      data.contractCurrency = assertCurrencyCode(patch.contractCurrency, 'contractCurrency');
    } else if (patch.contractCurrency === null) {
      data.contractCurrency = null;
    }
    if (patch.geoLatitude !== undefined && patch.geoLatitude !== null) {
      assertValidLatitude(patch.geoLatitude);
    }
    if (patch.geoLongitude !== undefined && patch.geoLongitude !== null) {
      assertValidLongitude(patch.geoLongitude);
    }
    for (const key of [
      'description',
      'projectSubtype',
      'clientName',
      'clientContactName',
      'clientContactPhone',
      'clientContactEmail',
      'contractRef',
      'workOrderRef',
      'tenderRef',
      'locationAddressLine',
      'locationLocality',
      'locationCity',
      'locationDistrict',
      'locationState',
      'locationPin',
      'locationCountry',
      'scopeSummary',
      'geoLatitude',
      'geoLongitude',
      'startDate',
      'endDate',
      'ntpDate',
      'revisedEndDate',
      'actualStartDate',
      'actualEndDate',
      'contractDate',
      'workOrderDate',
      'numBuildings',
      'numFloorsMax',
      'numUnits',
    ] as const) {
      const v = patch[key];
      if (v === undefined) continue;
      data[key] = typeof v === 'string' ? v.trim() || null : v;
    }
    for (const key of [
      'contractValue',
      'landArea',
      'builtUpArea',
      'linearLengthKm',
      'carriagewayWidthM',
    ] as const) {
      const v = patch[key];
      if (v === undefined) continue;
      data[key] = v === null ? null : assertDecimalString(v, key);
    }
    if (patch.numBuildings !== undefined && patch.numBuildings !== null) {
      data.numBuildings = assertNonNegativeInt(patch.numBuildings, 'numBuildings');
    }
    if (patch.numFloorsMax !== undefined && patch.numFloorsMax !== null) {
      data.numFloorsMax = assertNonNegativeInt(patch.numFloorsMax, 'numFloorsMax');
    }
    if (patch.numUnits !== undefined && patch.numUnits !== null) {
      data.numUnits = assertNonNegativeInt(patch.numUnits, 'numUnits');
    }

    return this.updateScoped(
      actor,
      'PROJECT',
      'ORG_PROJECT_UPDATED',
      companyId,
      id,
      data,
      expectedVersion,
      (existing) => {
        const merged = (k: string) => (k in data ? data[k] : existing[k]);
        const start = merged('startDate') as Date | null;
        const end = merged('endDate') as Date | null;
        if (start && end && end < start) {
          throw new OrgValidationError('endDate', 'must not be before startDate');
        }
        const aStart = merged('actualStartDate') as Date | null;
        const aEnd = merged('actualEndDate') as Date | null;
        if (aStart && aEnd && aEnd < aStart) {
          throw new OrgValidationError('actualEndDate', 'must not be before actualStartDate');
        }
        if (merged('contractValue') != null && merged('contractCurrency') == null) {
          throw new OrgValidationError('contractCurrency', 'required when contractValue is set');
        }
        if (merged('landArea') != null && merged('landAreaUnit') == null) {
          throw new OrgValidationError('landAreaUnit', 'required when landArea is set');
        }
        if ((merged('geoLatitude') == null) !== (merged('geoLongitude') == null)) {
          throw new OrgValidationError(
            'geoCoordinates',
            'latitude and longitude must be provided together',
          );
        }
      },
    );
  }

  async transitionProjectStatus(
    actor: ActorContext,
    companyId: string,
    id: string,
    to: string,
    expectedVersion?: number,
  ) {
    return this.transition(
      actor,
      'PROJECT',
      id,
      to,
      PROJECT_TRANSITIONS,
      expectedVersion,
      companyId,
    );
  }

  // --------------------------------------------------------------------- Site

  async createSite(
    actor: ActorContext,
    companyId: string,
    projectId: string,
    input: CreateSiteInput,
  ) {
    const code = normalizeCode(input.code);
    const name = normalizeName(input.name);
    const timezone = input.timezone !== undefined ? assertValidTimezone(input.timezone) : undefined;
    if (input.geoLatitude !== undefined) assertValidLatitude(input.geoLatitude);
    if (input.geoLongitude !== undefined) assertValidLongitude(input.geoLongitude);
    // Coordinates are a pair — either both or neither.
    if ((input.geoLatitude === undefined) !== (input.geoLongitude === undefined)) {
      throw new OrgValidationError(
        'geoCoordinates',
        'latitude and longitude must be provided together',
      );
    }
    // Geofence requires coordinates to define the fenced point.
    if (input.geoFenceRadiusM !== undefined) {
      assertValidGeoFenceRadius(input.geoFenceRadiusM);
      if (input.geoLatitude === undefined) {
        throw new OrgValidationError('geoFenceRadiusM', 'geofence requires coordinates');
      }
    }
    if (input.plotArea !== undefined && input.areaUnit === undefined) {
      throw new OrgValidationError('areaUnit', 'required when plotArea is set');
    }

    return this.uow.run(async (repos) => {
      const { projects, sites, landParcels, audit } = repos;
      const project = await projects.findById(companyId, projectId);
      if (!project) throw new OrgEntityNotFoundError('PROJECT');
      if (input.landParcelId !== undefined) {
        const parcel = await landParcels.findById(companyId, input.landParcelId);
        if (parcel?.projectId !== projectId) {
          throw new OrgValidationError(
            'landParcelId',
            'parcel must belong to the same project as the site',
          );
        }
      }
      const site = await sites.create(companyId, projectId, {
        code,
        name,
        ...siteProfileData(input),
        timezone: timezone ?? project.timezone,
      });
      await this.recordMutation(
        audit,
        actor,
        'SITE',
        'ORG_SITE_CREATED',
        null,
        site,
        { code, name },
        companyId,
      );
      for (const doc of input.documents ?? []) {
        const link = await this.attachDocumentRow(
          repos,
          actor,
          companyId,
          'SITE',
          site.id,
          doc,
          projectId,
        );
        await this.recordMutation(
          audit,
          actor,
          'SITE_DOCUMENT',
          'ORG_SITE_DOCUMENT_ATTACHED',
          null,
          link,
          { siteId: site.id, documentId: doc.documentId },
          companyId,
        );
      }
      return this.siteView(actor, companyId, site);
    });
  }

  async updateSite(
    actor: ActorContext,
    companyId: string,
    id: string,
    patch: UpdateSiteInput,
    expectedVersion?: number,
  ) {
    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data.name = normalizeName(patch.name);
    if (patch.siteType !== undefined) data.siteType = patch.siteType;
    if (patch.areaUnit !== undefined) data.areaUnit = patch.areaUnit;
    if (patch.geoLatitude !== undefined && patch.geoLatitude !== null)
      assertValidLatitude(patch.geoLatitude);
    if (patch.geoLongitude !== undefined && patch.geoLongitude !== null)
      assertValidLongitude(patch.geoLongitude);
    if (patch.geoFenceRadiusM !== undefined && patch.geoFenceRadiusM !== null)
      assertValidGeoFenceRadius(patch.geoFenceRadiusM);
    if (patch.timezone !== undefined && patch.timezone !== null)
      assertValidTimezone(patch.timezone);
    if (patch.plotArea !== undefined && patch.plotArea !== null)
      data.plotArea = assertDecimalString(patch.plotArea, 'plotArea');
    else if (patch.plotArea === null) data.plotArea = null;
    for (const key of [
      'description',
      'address',
      'addressLine1',
      'addressLine2',
      'locality',
      'city',
      'district',
      'state',
      'pinCode',
      'country',
      'surveyNo',
      'scopeSummary',
      'accessArrangements',
      'siteContactName',
      'siteContactPhone',
      'siteContactEmail',
      'accessInstructions',
      'emergencyDetails',
      'geoLatitude',
      'geoLongitude',
      'geoFenceRadiusM',
      'timezone',
      'possessionDate',
      'handoverDate',
      'mobilizationDate',
      'facilities',
    ] as const) {
      if (patch[key] !== undefined) {
        const v = patch[key];
        data[key] = typeof v === 'string' ? v.trim() || null : v;
      }
    }
    if (patch.landParcelId !== undefined) data.landParcelId = patch.landParcelId;

    return this.uow.run(async (repos) => {
      const existing = await repos.sites.findById(companyId, id);
      if (!existing) throw new OrgEntityNotFoundError('SITE');
      if (patch.landParcelId !== undefined && patch.landParcelId !== null) {
        const parcel = await repos.landParcels.findById(companyId, patch.landParcelId);
        if (parcel?.projectId !== existing.projectId) {
          throw new OrgValidationError(
            'landParcelId',
            'parcel must belong to the same project as the site',
          );
        }
      }
      const merged = (k: string) => (k in data ? data[k] : (existing as never)[k]);
      if (merged('plotArea') != null && merged('areaUnit') == null) {
        throw new OrgValidationError('areaUnit', 'required when plotArea is set');
      }
      if (merged('geoFenceRadiusM') != null && merged('geoLatitude') == null) {
        throw new OrgValidationError('geoFenceRadiusM', 'geofence requires coordinates');
      }
      if ((merged('geoLatitude') == null) !== (merged('geoLongitude') == null)) {
        throw new OrgValidationError(
          'geoCoordinates',
          'latitude and longitude must be provided together',
        );
      }
      if (Object.keys(data).length === 0) return this.siteView(actor, companyId, existing);
      const updated = await repos.sites.update(companyId, id, data, expectedVersion);
      await this.recordMutation(
        repos.audit,
        actor,
        'SITE',
        'ORG_SITE_UPDATED',
        existing,
        updated,
        data,
        companyId,
      );
      return this.siteView(actor, companyId, updated);
    });
  }

  async transitionSiteStatus(
    actor: ActorContext,
    companyId: string,
    id: string,
    to: string,
    expectedVersion?: number,
  ) {
    return this.transition(actor, 'SITE', id, to, ORG_NODE_TRANSITIONS, expectedVersion, companyId);
  }

  // -------------------------------------------------------------------- reads

  getCompany(companyId: string, id: string) {
    return this.uow.run(({ companies }) => companies.findById(companyId, id));
  }

  listHeadOffices(companyId: string, filter?: { status?: OrgNodeStatus }) {
    return this.uow.run(({ headOffices }) => headOffices.list(companyId, filter));
  }

  listProjects(companyId: string, filter?: { status?: ProjectStatus; headOfficeId?: string }) {
    return this.uow.run(({ projects }) => projects.list(companyId, filter));
  }

  listSites(companyId: string, filter?: { status?: OrgNodeStatus; projectId?: string }) {
    // Broad list responses never expose security-sensitive site fields.
    return this.uow.run(async ({ sites }) =>
      (await sites.list(companyId, filter)).map((s) => stripSiteSensitive(s)),
    );
  }

  /** Full project profile + its registers (parcels, documents, approvals). */
  async getProject(companyId: string, id: string) {
    return this.uow.run(async ({ projects, landParcels, projectDocuments, approvals }) => {
      const project = await projects.findById(companyId, id);
      if (!project) throw new OrgEntityNotFoundError('PROJECT');
      const [parcels, documents, approvalRows] = await Promise.all([
        landParcels.list(companyId, id),
        projectDocuments.list(companyId, id),
        approvals.list(companyId, id),
      ]);
      return { ...project, landParcels: parcels, documents, approvals: approvalRows };
    });
  }

  /** Full site profile + its document register; sensitive fields gated. */
  async getSite(actor: ActorContext, companyId: string, id: string) {
    return this.uow.run(async ({ sites, siteDocuments }) => {
      const site = await sites.findById(companyId, id);
      if (!site) throw new OrgEntityNotFoundError('SITE');
      const documents = await siteDocuments.list(companyId, id);
      return { ...(await this.siteView(actor, companyId, site)), documents };
    });
  }

  // -------------------------------------------------- project land parcels

  async createParcel(
    actor: ActorContext,
    companyId: string,
    projectId: string,
    input: LandParcelInput,
  ) {
    return this.uow.run(async (repos) => {
      const project = await repos.projects.findById(companyId, projectId);
      if (!project) throw new OrgEntityNotFoundError('PROJECT');
      const row = await this.createParcelRow(repos, actor, companyId, projectId, input);
      await repos.audit.record(
        auditEntry(actor, {
          action: 'ORG_LAND_PARCEL_ADDED',
          entityType: 'LAND_PARCEL',
          entityId: row.id,
          companyId,
          changedFields: {
            projectId: { before: null, after: projectId },
            surveyNo: { before: null, after: input.surveyNo ?? null },
            area: { before: null, after: input.area },
          },
        }),
      );
      return row;
    });
  }

  async listParcels(companyId: string, projectId: string) {
    return this.uow.run(async ({ projects, landParcels }) => {
      if (!(await projects.findById(companyId, projectId))) {
        throw new OrgEntityNotFoundError('PROJECT');
      }
      return landParcels.list(companyId, projectId);
    });
  }

  // ---------------------------------------------------------- site documents

  async attachProjectDocument(
    actor: ActorContext,
    companyId: string,
    projectId: string,
    input: OrgDocumentLinkInput,
  ) {
    return this.uow.run(async (repos) => {
      if (!(await repos.projects.findById(companyId, projectId))) {
        throw new OrgEntityNotFoundError('PROJECT');
      }
      const link = await this.attachDocumentRow(
        repos,
        actor,
        companyId,
        'PROJECT',
        projectId,
        input,
      );
      await this.recordLinkAudit(repos, actor, companyId, 'ORG_PROJECT_DOCUMENT_ATTACHED', link, {
        projectId,
        documentId: input.documentId,
      });
      return link;
    });
  }

  async listProjectDocuments(companyId: string, projectId: string) {
    return this.uow.run(async ({ projects, projectDocuments }) => {
      if (!(await projects.findById(companyId, projectId))) {
        throw new OrgEntityNotFoundError('PROJECT');
      }
      return projectDocuments.list(companyId, projectId);
    });
  }

  async updateProjectDocument(
    actor: ActorContext,
    companyId: string,
    linkId: string,
    patch: UpdateOrgDocumentLinkInput,
    expectedVersion?: number,
  ) {
    const data: Record<string, unknown> = {};
    if (patch.title !== undefined) {
      const t = patch.title.trim();
      if (!t) throw new OrgValidationError('title', 'must not be empty');
      data.title = t;
    }
    for (const key of [
      'documentNumber',
      'discipline',
      'revision',
      'issueDate',
      'metadata',
    ] as const) {
      const v = patch[key];
      if (v === undefined) continue;
      data[key] = typeof v === 'string' ? v.trim() || null : v;
    }
    if (patch.linkStatus !== undefined) data.linkStatus = patch.linkStatus;
    return this.uow.run(async (repos) => {
      const existing = await repos.projectDocuments.findById(companyId, linkId);
      if (!existing) throw new OrgEntityNotFoundError('PROJECT_DOCUMENT');
      const updated = await repos.projectDocuments.update(companyId, linkId, data, expectedVersion);
      await this.recordLinkAudit(repos, actor, companyId, 'ORG_PROJECT_DOCUMENT_UPDATED', updated, {
        linkId,
        changed: Object.keys(data),
      });
      return updated;
    });
  }

  async attachSiteDocument(
    actor: ActorContext,
    companyId: string,
    siteId: string,
    input: OrgDocumentLinkInput,
  ) {
    return this.uow.run(async (repos) => {
      const site = await repos.sites.findById(companyId, siteId);
      if (!site) throw new OrgEntityNotFoundError('SITE');
      const link = await this.attachDocumentRow(
        repos,
        actor,
        companyId,
        'SITE',
        siteId,
        input,
        site.projectId,
      );
      await this.recordLinkAudit(repos, actor, companyId, 'ORG_SITE_DOCUMENT_ATTACHED', link, {
        siteId,
        documentId: input.documentId,
      });
      return link;
    });
  }

  async listSiteDocuments(companyId: string, siteId: string) {
    return this.uow.run(async ({ sites, siteDocuments }) => {
      if (!(await sites.findById(companyId, siteId))) {
        throw new OrgEntityNotFoundError('SITE');
      }
      return siteDocuments.list(companyId, siteId);
    });
  }

  async updateSiteDocument(
    actor: ActorContext,
    companyId: string,
    linkId: string,
    patch: UpdateOrgDocumentLinkInput,
    expectedVersion?: number,
  ) {
    const data: Record<string, unknown> = {};
    if (patch.title !== undefined) {
      const t = patch.title.trim();
      if (!t) throw new OrgValidationError('title', 'must not be empty');
      data.title = t;
    }
    for (const key of [
      'documentNumber',
      'discipline',
      'revision',
      'issueDate',
      'metadata',
    ] as const) {
      const v = patch[key];
      if (v === undefined) continue;
      data[key] = typeof v === 'string' ? v.trim() || null : v;
    }
    if (patch.linkStatus !== undefined) data.linkStatus = patch.linkStatus;
    return this.uow.run(async (repos) => {
      const existing = await repos.siteDocuments.findById(companyId, linkId);
      if (!existing) throw new OrgEntityNotFoundError('SITE_DOCUMENT');
      const updated = await repos.siteDocuments.update(companyId, linkId, data, expectedVersion);
      await this.recordLinkAudit(repos, actor, companyId, 'ORG_SITE_DOCUMENT_UPDATED', updated, {
        linkId,
        changed: Object.keys(data),
      });
      return updated;
    });
  }

  // -------------------------------------------------------- project approvals

  async createApproval(
    actor: ActorContext,
    companyId: string,
    projectId: string,
    input: ProjectApprovalInput,
  ) {
    return this.uow.run(async (repos) => {
      if (!(await repos.projects.findById(companyId, projectId))) {
        throw new OrgEntityNotFoundError('PROJECT');
      }
      const row = await this.createApprovalRow(repos, actor, companyId, projectId, input);
      await repos.audit.record(
        auditEntry(actor, {
          action: 'ORG_PROJECT_APPROVAL_RECORDED',
          entityType: 'PROJECT_APPROVAL',
          entityId: row.id,
          companyId,
          statusAfter: row.status,
          changedFields: {
            projectId: { before: null, after: projectId },
            approvalType: { before: null, after: input.approvalType },
          },
        }),
      );
      return row;
    });
  }

  async listApprovals(companyId: string, projectId: string) {
    return this.uow.run(async ({ projects, approvals }) => {
      if (!(await projects.findById(companyId, projectId))) {
        throw new OrgEntityNotFoundError('PROJECT');
      }
      return approvals.list(companyId, projectId);
    });
  }

  async updateApproval(
    actor: ActorContext,
    companyId: string,
    approvalId: string,
    patch: UpdateProjectApprovalInput,
    expectedVersion?: number,
  ) {
    const data: Record<string, unknown> = {};
    for (const key of [
      'customType',
      'issuingAuthority',
      'jurisdiction',
      'referenceNo',
      'appliedDate',
      'grantedDate',
      'validUntil',
      'documentId',
      'notes',
    ] as const) {
      const v = patch[key];
      if (v === undefined) continue;
      data[key] = typeof v === 'string' ? v.trim() || null : v;
    }
    if (patch.status !== undefined) data.status = patch.status;
    return this.uow.run(async (repos) => {
      const existing = await repos.approvals.findById(companyId, approvalId);
      if (!existing) throw new OrgEntityNotFoundError('PROJECT_APPROVAL');
      if (data.documentId !== undefined && data.documentId !== null) {
        await this.assertAvailableDocument(repos, companyId, data.documentId as string);
      }
      const updated = await repos.approvals.update(companyId, approvalId, data, expectedVersion);
      await repos.audit.record(
        auditEntry(actor, {
          action: 'ORG_PROJECT_APPROVAL_UPDATED',
          entityType: 'PROJECT_APPROVAL',
          entityId: approvalId,
          companyId,
          statusBefore: existing.status,
          statusAfter: updated.status,
          changedFields: changedFields(data, existing),
        }),
      );
      return updated;
    });
  }

  // ----------------------------------------------------------------- internal

  private async updateScoped(
    actor: ActorContext,
    entityType: OrgEntityType,
    action: string,
    companyId: string,
    id: string,
    data: Record<string, unknown>,
    expectedVersion?: number,
    check?: (existing: Record<string, unknown>) => void,
  ) {
    return this.uow.run(async (repos) => {
      const repo = this.repoFor(repos, entityType);
      const existing = await repo.findById(companyId, id);
      if (!existing) throw new OrgEntityNotFoundError(entityType);
      if (Object.keys(data).length === 0) return existing;
      check?.(existing);
      const updated = await repo.update(companyId, id, data, expectedVersion);
      await this.recordMutation(
        repos.audit,
        actor,
        entityType,
        action,
        existing,
        updated,
        data,
        companyId,
      );
      return updated;
    });
  }

  private async transition(
    actor: ActorContext,
    entityType: OrgEntityType,
    id: string,
    to: string,
    transitions: Record<string, readonly string[]>,
    expectedVersion?: number,
    companyId?: string,
    check?: (existing: Record<string, unknown>) => void,
  ) {
    const scope = companyId ?? id; // a company's own id is its scope
    return this.uow.run(async (repos) => {
      const repo = this.repoFor(repos, entityType);
      const existing = await repo.findById(scope, id);
      if (!existing) throw new OrgEntityNotFoundError(entityType);
      assertTransition(entityType, transitions, existing.status, to);
      check?.(existing);
      const updated = await repo.update(scope, id, { status: to }, expectedVersion);
      await this.recordMutation(
        repos.audit,
        actor,
        entityType,
        `ORG_${entityType}_STATUS_CHANGED`,
        existing,
        updated,
        { status: to },
        scope,
      );
      return updated;
    });
  }

  private repoFor(repos: OrgRepos, entityType: OrgEntityType) {
    switch (entityType) {
      case 'COMPANY':
        return repos.companies;
      case 'HEAD_OFFICE':
        return repos.headOffices;
      case 'PROJECT':
        return repos.projects;
      case 'SITE':
        return repos.sites;
    }
  }

  private async recordMutation(
    audit: OrgRepos['audit'],
    actor: ActorContext,
    entityType: string,
    action: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
    patch: Record<string, unknown>,
    companyId?: string,
  ) {
    await audit.record(
      auditEntry(actor, {
        action,
        entityType,
        entityId: after.id as string,
        companyId: companyId ?? (after.companyId as string | undefined),
        statusBefore: before?.status as string | undefined,
        statusAfter: after.status as string | undefined,
        changedFields: before === null ? changedFields(patch, {}) : changedFields(patch, before),
      }),
    );
  }

  /** Sensitive-field gate: strip unless actor holds ORG_SITE_SENSITIVE_READ. */
  private async siteView(actor: ActorContext, companyId: string, site: Record<string, unknown>) {
    const canSee =
      this.deps?.hasPermission !== undefined &&
      (await this.deps.hasPermission(actor.actorId, ORG_SITE_SENSITIVE_READ, {
        companyId,
        scopeType: 'COMPANY',
        scopeId: companyId,
      }));
    return canSee ? site : stripSiteSensitive(site);
  }

  /** Create-time cross-field checks for the extended project profile. */
  private assertProjectProfile(input: CreateProjectInput) {
    if (input.geoLatitude !== undefined) assertValidLatitude(input.geoLatitude);
    if (input.geoLongitude !== undefined) assertValidLongitude(input.geoLongitude);
    if ((input.geoLatitude === undefined) !== (input.geoLongitude === undefined)) {
      throw new OrgValidationError(
        'geoCoordinates',
        'latitude and longitude must be provided together',
      );
    }
    if (input.contractValue !== undefined && input.contractCurrency === undefined) {
      throw new OrgValidationError('contractCurrency', 'required when contractValue is set');
    }
    if (input.landArea !== undefined && input.landAreaUnit === undefined) {
      throw new OrgValidationError('landAreaUnit', 'required when landArea is set');
    }
    if (
      input.actualStartDate &&
      input.actualEndDate &&
      input.actualEndDate < input.actualStartDate
    ) {
      throw new OrgValidationError('actualEndDate', 'must not be before actualStartDate');
    }
  }

  private assertInitialBudgetInput(ib: InitialBudgetInput) {
    if (ib.lines.length === 0) {
      throw new OrgValidationError('initialBudget.lines', 'at least one line is required');
    }
    for (const line of ib.lines) {
      assertDecimalString(line.amount, 'initialBudget.lines.amount');
      if (!line.description.trim()) {
        throw new OrgValidationError('initialBudget.lines.description', 'is required');
      }
    }
  }

  private async createParcelRow(
    repos: OrgRepos,
    actor: ActorContext,
    companyId: string,
    projectId: string,
    input: LandParcelInput,
  ) {
    if (input.documentId !== undefined) {
      await this.assertAvailableDocument(repos, companyId, input.documentId);
    }
    return repos.landParcels.create(companyId, projectId, {
      ...(input.surveyNo !== undefined ? { surveyNo: input.surveyNo.trim() } : {}),
      ...(input.plotNo !== undefined ? { plotNo: input.plotNo.trim() } : {}),
      area: assertDecimalString(input.area, 'area'),
      areaUnit: input.areaUnit,
      ...(input.boundaryDescription !== undefined
        ? { boundaryDescription: input.boundaryDescription.trim() }
        : {}),
      ...(input.possessionDate !== undefined ? { possessionDate: input.possessionDate } : {}),
      ...(input.documentId !== undefined ? { documentId: input.documentId } : {}),
    });
  }

  /** Same-company AVAILABLE document — shared gate for all link targets. */
  private async assertAvailableDocument(
    repos: OrgRepos,
    companyId: string,
    documentId: string,
  ): Promise<OrgDocumentScopeInfo> {
    const doc = await repos.documents.findScopeInfo(companyId, documentId);
    if (!doc) throw new OrgEntityNotFoundError('DOCUMENT');
    if (doc.status !== 'AVAILABLE') {
      throw new OrgValidationError(
        'documentId',
        `document status is ${doc.status}; only AVAILABLE documents can be linked`,
      );
    }
    return doc;
  }

  /**
   * Scope containment for register links: COMPANY-scoped documents may link
   * anywhere in the company; a PROJECT-scoped document links only to that
   * project (or sites beneath it); a SITE-scoped document links only to that
   * site. HEAD_OFFICE-scoped documents are never linkable here.
   */
  private async attachDocumentRow(
    repos: OrgRepos,
    actor: ActorContext,
    companyId: string,
    owner: 'PROJECT' | 'SITE',
    ownerId: string,
    input: OrgDocumentLinkInput,
    parentProjectId?: string,
  ) {
    const doc = await this.assertAvailableDocument(repos, companyId, input.documentId);
    const contained =
      doc.scopeType === 'COMPANY' ||
      (owner === 'PROJECT' && doc.scopeType === 'PROJECT' && doc.projectId === ownerId) ||
      (owner === 'SITE' && doc.scopeType === 'SITE' && doc.siteId === ownerId) ||
      (owner === 'SITE' && doc.scopeType === 'PROJECT' && doc.projectId === parentProjectId);
    if (!contained) {
      throw new OrgValidationError('documentId', 'document scope does not contain the link target');
    }
    const data: Record<string, unknown> = {
      documentId: input.documentId,
      documentType: input.documentType,
      title: input.title.trim(),
      ...(input.documentNumber !== undefined
        ? { documentNumber: input.documentNumber.trim() }
        : {}),
      ...(input.discipline !== undefined ? { discipline: input.discipline } : {}),
      ...(input.revision !== undefined ? { revision: input.revision.trim() } : {}),
      ...(input.issueDate !== undefined ? { issueDate: input.issueDate } : {}),
      ...(input.linkStatus !== undefined ? { linkStatus: input.linkStatus } : {}),
      ...(actor.actorType === 'USER' ? { attachedByPrincipalId: actor.actorId } : {}),
    };
    return owner === 'PROJECT'
      ? repos.projectDocuments.create(companyId, ownerId, data)
      : repos.siteDocuments.create(companyId, ownerId, data);
  }

  private async recordLinkAudit(
    repos: OrgRepos,
    actor: ActorContext,
    companyId: string,
    action: string,
    link: { id: string },
    fields: Record<string, unknown>,
  ) {
    await repos.audit.record(
      auditEntry(actor, {
        action,
        entityType: action.includes('SITE') ? 'SITE_DOCUMENT' : 'PROJECT_DOCUMENT',
        entityId: link.id,
        companyId,
        changedFields: Object.fromEntries(
          Object.entries(fields).map(([k, v]) => [k, { before: null, after: v }]),
        ),
      }),
    );
  }

  private async createApprovalRow(
    repos: OrgRepos,
    actor: ActorContext,
    companyId: string,
    projectId: string,
    input: ProjectApprovalInput,
  ) {
    if (input.approvalType === 'OTHER' && !input.customType?.trim()) {
      throw new OrgValidationError('customType', 'required when approvalType is OTHER');
    }
    if (input.documentId !== undefined) {
      await this.assertAvailableDocument(repos, companyId, input.documentId);
    }
    return repos.approvals.create(companyId, projectId, {
      approvalType: input.approvalType,
      ...(input.customType !== undefined ? { customType: input.customType.trim() } : {}),
      ...(input.issuingAuthority !== undefined
        ? { issuingAuthority: input.issuingAuthority.trim() }
        : {}),
      ...(input.jurisdiction !== undefined ? { jurisdiction: input.jurisdiction.trim() } : {}),
      ...(input.referenceNo !== undefined ? { referenceNo: input.referenceNo.trim() } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.appliedDate !== undefined ? { appliedDate: input.appliedDate } : {}),
      ...(input.grantedDate !== undefined ? { grantedDate: input.grantedDate } : {}),
      ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
      ...(input.documentId !== undefined ? { documentId: input.documentId } : {}),
      ...(input.notes !== undefined ? { notes: input.notes.trim() } : {}),
    });
  }
}

// Strips the sensitive site fields — applied unconditionally to broad list
// responses and conditionally to detail responses (see siteView).
function stripSiteSensitive(site: Record<string, unknown>) {
  const rest = { ...site };
  delete rest.accessInstructions;
  delete rest.emergencyDetails;
  return rest;
}

// Maps the extended CreateProjectInput onto Prisma create data (create-time
// semantics: absent keys stay unset; no nulls written).
function projectProfileData(input: CreateProjectInput): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const key of [
    'description',
    'projectSubtype',
    'clientName',
    'clientContactName',
    'clientContactPhone',
    'clientContactEmail',
    'contractRef',
    'workOrderRef',
    'tenderRef',
    'locationAddressLine',
    'locationLocality',
    'locationCity',
    'locationDistrict',
    'locationState',
    'locationPin',
    'locationCountry',
    'scopeSummary',
  ] as const) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) data[key] = v.trim();
  }
  for (const key of ['projectType', 'contractType', 'landAreaUnit'] as const) {
    if (input[key] !== undefined) data[key] = input[key];
  }
  for (const key of [
    'contractValue',
    'landArea',
    'builtUpArea',
    'linearLengthKm',
    'carriagewayWidthM',
  ] as const) {
    const v = input[key];
    if (v !== undefined) data[key] = assertDecimalString(v, key);
  }
  if (input.contractCurrency !== undefined) {
    data.contractCurrency = assertCurrencyCode(input.contractCurrency, 'contractCurrency');
  }
  for (const key of ['numBuildings', 'numFloorsMax', 'numUnits'] as const) {
    const v = input[key];
    if (v !== undefined) data[key] = assertNonNegativeInt(v, key);
  }
  for (const key of [
    'contractDate',
    'workOrderDate',
    'startDate',
    'endDate',
    'ntpDate',
    'revisedEndDate',
    'actualStartDate',
    'actualEndDate',
    'geoLatitude',
    'geoLongitude',
  ] as const) {
    if (input[key] !== undefined) data[key] = input[key];
  }
  return data;
}

// Maps the extended CreateSiteInput onto Prisma create data (create-time
// semantics: absent keys stay unset).
function siteProfileData(input: CreateSiteInput): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const key of [
    'description',
    'address',
    'addressLine1',
    'addressLine2',
    'locality',
    'city',
    'district',
    'state',
    'pinCode',
    'country',
    'surveyNo',
    'scopeSummary',
    'accessArrangements',
    'siteContactName',
    'siteContactPhone',
    'siteContactEmail',
    'accessInstructions',
    'emergencyDetails',
  ] as const) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) data[key] = v.trim();
  }
  for (const key of ['siteType', 'areaUnit', 'landParcelId', 'facilities'] as const) {
    if (input[key] !== undefined) data[key] = input[key];
  }
  if (input.plotArea !== undefined) {
    data.plotArea = assertDecimalString(input.plotArea, 'plotArea');
  }
  for (const key of [
    'possessionDate',
    'handoverDate',
    'mobilizationDate',
    'geoLatitude',
    'geoLongitude',
    'geoFenceRadiusM',
  ] as const) {
    if (input[key] !== undefined) data[key] = input[key];
  }
  return data;
}

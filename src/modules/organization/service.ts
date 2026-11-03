import { randomUUID } from 'node:crypto';
import type {
  ActorContext,
  AuditRecord,
  CreateCompanyInput,
  CreateHeadOfficeInput,
  CreateProjectInput,
  CreateSiteInput,
  OrgEntityType,
  UpdateCompanyInput,
  UpdateHeadOfficeInput,
  UpdateProjectInput,
  UpdateSiteInput,
} from './types.js';
import type { OrgRepos, OrgUnitOfWork } from './repository.js';
import type { OrgNodeStatus, ProjectStatus } from '@prisma/client';
import { OrgEntityNotFoundError, OrgValidationError } from './errors.js';
import {
  assertTransition,
  COMPANY_TRANSITIONS,
  ORG_NODE_TRANSITIONS,
  PROJECT_TRANSITIONS,
} from './lifecycle.js';
import {
  assertValidGeoFenceRadius,
  assertValidLatitude,
  assertValidLongitude,
  assertValidTimezone,
  normalizeCode,
  normalizeName,
} from './validation.js';

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
  constructor(private readonly uow: OrgUnitOfWork) {}

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

  async createProject(
    actor: ActorContext,
    companyId: string,
    headOfficeId: string,
    input: CreateProjectInput,
  ) {
    const code = normalizeCode(input.code);
    const name = normalizeName(input.name);
    const timezone = assertValidTimezone(input.timezone);
    if (input.startDate && input.endDate && input.endDate < input.startDate) {
      throw new OrgValidationError('endDate', 'must not be before startDate');
    }

    return this.uow.run(async ({ headOffices, projects, audit }) => {
      // Validate parent inside the requested company scope before mutating.
      const headOffice = await headOffices.findById(companyId, headOfficeId);
      if (!headOffice) throw new OrgEntityNotFoundError('HEAD_OFFICE');
      // One shared HO invariant: projects bind to the company's PRIMARY HO only.
      if (!headOffice.isPrimary) {
        throw new OrgValidationError('headOfficeId', 'must be the company primary head office');
      }
      const project = await projects.create(companyId, headOfficeId, {
        code,
        name,
        timezone,
        ...(input.description ? { description: input.description.trim() } : {}),
        ...(input.startDate ? { startDate: input.startDate } : {}),
        ...(input.endDate ? { endDate: input.endDate } : {}),
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
      return project;
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
    if (patch.description !== undefined) {
      const trimmed = patch.description?.trim();
      data.description = trimmed !== undefined && trimmed !== '' ? trimmed : null;
    }
    if (patch.timezone !== undefined) data.timezone = assertValidTimezone(patch.timezone);
    if (patch.startDate !== undefined) data.startDate = patch.startDate;
    if (patch.endDate !== undefined) data.endDate = patch.endDate;

    return this.updateScoped(
      actor,
      'PROJECT',
      'ORG_PROJECT_UPDATED',
      companyId,
      id,
      data,
      expectedVersion,
      (existing) => {
        const start = (data.startDate ?? existing.startDate) as Date | null;
        const end = (data.endDate ?? existing.endDate) as Date | null;
        if (start && end && end < start) {
          throw new OrgValidationError('endDate', 'must not be before startDate');
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
    if (input.geoFenceRadiusM !== undefined) assertValidGeoFenceRadius(input.geoFenceRadiusM);

    return this.uow.run(async ({ projects, sites, audit }) => {
      const project = await projects.findById(companyId, projectId);
      if (!project) throw new OrgEntityNotFoundError('PROJECT');
      const site = await sites.create(companyId, projectId, {
        code,
        name,
        ...(input.address ? { address: input.address.trim() } : {}),
        ...(input.geoLatitude !== undefined ? { geoLatitude: input.geoLatitude } : {}),
        ...(input.geoLongitude !== undefined ? { geoLongitude: input.geoLongitude } : {}),
        ...(input.geoFenceRadiusM !== undefined ? { geoFenceRadiusM: input.geoFenceRadiusM } : {}),
        ...(timezone !== undefined ? { timezone } : {}),
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
      return site;
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
    if (patch.address !== undefined) {
      const trimmed = patch.address?.trim();
      data.address = trimmed !== undefined && trimmed !== '' ? trimmed : null;
    }
    if (patch.geoLatitude !== undefined && patch.geoLatitude !== null)
      assertValidLatitude(patch.geoLatitude);
    if (patch.geoLongitude !== undefined && patch.geoLongitude !== null)
      assertValidLongitude(patch.geoLongitude);
    if (patch.geoFenceRadiusM !== undefined && patch.geoFenceRadiusM !== null)
      assertValidGeoFenceRadius(patch.geoFenceRadiusM);
    if (patch.timezone !== undefined && patch.timezone !== null)
      assertValidTimezone(patch.timezone);
    for (const key of [
      'address',
      'geoLatitude',
      'geoLongitude',
      'geoFenceRadiusM',
      'timezone',
    ] as const) {
      if (patch[key] !== undefined) data[key] = patch[key];
    }

    return this.updateScoped(
      actor,
      'SITE',
      'ORG_SITE_UPDATED',
      companyId,
      id,
      data,
      expectedVersion,
    );
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
    return this.uow.run(({ sites }) => sites.list(companyId, filter));
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
    entityType: OrgEntityType,
    action: string,
    before: ({ status: string } & Record<string, unknown>) | null,
    after: { status: string } & Record<string, unknown>,
    patch: Record<string, unknown>,
    companyId?: string,
  ) {
    await audit.record(
      auditEntry(actor, {
        action,
        entityType,
        entityId: after.id as string,
        companyId: companyId ?? (after.companyId as string | undefined),
        statusBefore: before?.status,
        statusAfter: after.status,
        changedFields: before === null ? changedFields(patch, {}) : changedFields(patch, before),
      }),
    );
  }
}

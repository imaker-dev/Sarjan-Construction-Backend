import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { passwordService } from '../identity/password.js';
import { OWNER_ROLE_KEY, TENANT_OWNER_PERMISSIONS } from '../setup/bootstrap.js';
import { HO_ADMIN_PERMISSIONS } from '../setup/role-templates.js';
import { OrgEntityNotFoundError, OrgValidationError } from '../organization/errors.js';
import { UnauthorizedError } from '../../common/errors/app-error.js';
import type { ActorContext, AuditRecord } from '../organization/types.js';
import type { PlatformUnitOfWork } from './repository.js';

/**
 * Platform Admin surface: create customer Company + first Company Admin,
 * issue/reissue one-time claim codes, verify them, and complete onboarding.
 */

export const PLATFORM_COMPANY_CREATE = 'PLATFORM_COMPANY_CREATE';
export const PLATFORM_COMPANY_READ = 'PLATFORM_COMPANY_READ';
const CLAIM_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const auditEntry = (
  actor: ActorContext,
  base: Omit<AuditRecord, 'eventKey' | 'actorId' | 'actorType' | 'correlationId'>,
): AuditRecord => ({
  eventKey: randomUUID(),
  actorId: actor.actorId,
  actorType: actor.actorType,
  ...(actor.correlationId !== undefined ? { correlationId: actor.correlationId } : {}),
  ...base,
});

const hashToken = (raw: string): string => createHash('sha256').update(raw).digest('hex');

export interface OnboardInput {
  password: string;
  loginId?: string | null;
  displayName?: string | null;
  company?: Record<string, unknown>;
  // Mirrors the supported head-office create contract. isPrimary is server-
  // forced to true — the first HO is always primary; never trusted from input.
  headOffice?: {
    code?: string | null;
    name?: string | null;
    legalName?: string | null;
    addressLine1?: string | null;
    addressLine2?: string | null;
    locality?: string | null;
    city?: string | null;
    district?: string | null;
    state?: string | null;
    pinCode?: string | null;
    country?: string | null;
    contactName?: string | null;
    contactPhone?: string | null;
    contactEmail?: string | null;
  };
}

export interface CreateCompanyResult {
  companyId: string;
  companyCode: string;
  adminPrincipalId: string;
  claimCode: string; // raw — returned once, never stored or logged
  claimUrl: string;
  claimExpiresAt: Date;
}

export class PlatformService {
  constructor(
    private readonly uow: PlatformUnitOfWork,
    private readonly appBaseUrl = 'http://localhost:3000',
  ) {}

  /** Create a customer Company + pending first admin + claim code. One tx. */
  async createCompanyWithAdmin(
    actor: ActorContext,
    input: {
      companyCode: string;
      companyName: string;
      adminLoginId: string;
      adminDisplayName: string;
    } & Record<string, unknown>,
  ): Promise<CreateCompanyResult> {
    const { adminDisplayName, ...rest } = input;
    const profile = rest as Record<string, unknown>;
    delete profile.companyCode;
    delete profile.companyName;
    delete profile.adminLoginId;
    const code = input.companyCode.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(code)) {
      throw new OrgValidationError('companyCode', '1–40 chars: A-Z 0-9 - _');
    }
    const name = input.companyName.trim();
    if (name.length === 0 || name.length > 200) {
      throw new OrgValidationError('companyName', '1–200 chars');
    }
    const loginId = input.adminLoginId.toLowerCase().trim();

    return this.uow.run(async (repos) => {
      // The tenant Company — customer only, never platform.
      const company = await repos.companies.create({ code, name, isPlatform: false, ...profile });

      // COMPANY_OWNER role with the exact tenant-owner keyset — no platform keys.
      const role = await repos.roles.create({
        companyId: company.id,
        key: OWNER_ROLE_KEY,
        name: 'Company Owner',
        isSystem: true,
        description: 'First company administrator — full tenant scope',
      });
      for (const key of TENANT_OWNER_PERMISSIONS) {
        const permission = await repos.permissions.upsert(key);
        await repos.rolePermissions.create(role.id, permission.id);
      }

      // HO_ADMIN system role — fixed template keyset, HEAD_OFFICE scope only.
      const hoRole = await repos.roles.create({
        companyId: company.id,
        key: 'HO_ADMIN',
        name: 'HO Admin',
        isSystem: true,
        description: 'Shared Head Office administrator — cross-project access',
      });
      for (const key of HO_ADMIN_PERMISSIONS) {
        const permission = await repos.permissions.upsert(key);
        await repos.rolePermissions.create(hoRole.id, permission.id);
      }

      // Pending admin: suspended until claim completes; placeholder hash is a
      // real argon2 digest of random bytes — unguessable, never valid for login.
      const placeholder = await passwordService.hash(randomBytes(32).toString('hex'));
      const admin = await repos.principals.create({
        loginId,
        loginIdType: 'EMAIL',
        type: 'USER',
        status: 'SUSPENDED',
        passwordHash: placeholder,
      });
      const employee = await repos.employees.create({
        companyId: company.id,
        principalId: admin.id,
        employeeCode: 'ADM-001',
        displayName: adminDisplayName.trim() || `${name} Admin`,
      });
      await repos.roleAssignments.create({
        principalId: admin.id,
        roleId: role.id,
        companyId: company.id,
        scopeType: 'COMPANY',
        grantedByPrincipalId: actor.actorId,
      });

      const raw = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + CLAIM_TTL_MS);
      await repos.claimTokens.create({
        principalId: admin.id,
        tokenHash: hashToken(raw),
        expiresAt,
      });
      await repos.audit.record(
        auditEntry(actor, {
          action: 'PLATFORM_COMPANY_CREATED',
          entityType: 'COMPANY',
          entityId: company.id,
          companyId: company.id,
          statusAfter: company.status,
          changedFields: {
            code: { before: null, after: code },
            adminEmployee: { before: null, after: employee.id },
            claimTokenIssued: { before: null, after: expiresAt.toISOString() },
          },
        }),
      );
      const claimUrl = `${this.appBaseUrl.replace(/\/+$/, '')}/onboard?token=${raw}`;
      return {
        companyId: company.id,
        companyCode: code,
        adminPrincipalId: admin.id,
        claimCode: raw,
        claimUrl,
        claimExpiresAt: expiresAt,
      };
    });
  }

  listCompanies() {
    return this.uow.run(({ companies }) => companies.list());
  }

  /**
   * Verify an unconsumed, unexpired claim code before starting onboarding.
   */
  async verifyClaim(rawToken: string): Promise<{
    valid: true;
    companyId: string;
    companyCode: string;
    companyName: string;
    adminLoginId: string;
    adminDisplayName: string;
    expiresAt: Date;
  }> {
    const tokenHash = hashToken(rawToken);
    return this.uow.run(async (repos) => {
      const active = await repos.claimTokens.findActive(tokenHash, new Date());
      if (!active) {
        throw new UnauthorizedError('CLAIM_INVALID', 'claim code is invalid, expired, or used');
      }
      return {
        valid: true,
        companyId: active.companyId,
        companyCode: active.companyCode,
        companyName: active.companyName,
        adminLoginId: active.adminLoginId,
        adminDisplayName: active.adminDisplayName,
        expiresAt: active.expiresAt,
      };
    });
  }

  /** Consume a claim code: set the admin's real password + activate. One tx.
   *  The audit actor is the claimed principal themselves (a real USER). */
  async consumeClaim(rawToken: string, password: string) {
    if (!password || password.length === 0) throw new OrgValidationError('password', 'password is required');
    const tokenHash = hashToken(rawToken);
    return this.uow.run(async (repos) => {
      const token = await repos.claimTokens.consume(tokenHash, new Date());
      if (token === null) {
        throw new UnauthorizedError('CLAIM_INVALID', 'claim code is invalid, expired, or used');
      }
      const passwordHash = await passwordService.hash(password);
      // Only a still-suspended principal may be activated — a stale/losing
      // claim fails and rolls back WITHOUT leaving its token consumed.
      const activated = await repos.principals.activateIfSuspended(token.principalId, {
        passwordHash,
        status: 'ACTIVE',
      });
      if (!activated) {
        throw new UnauthorizedError('CLAIM_INVALID', 'claim code is invalid, expired, or used');
      }
      await repos.audit.record(
        auditEntry(
          { actorId: token.principalId, actorType: 'USER' },
          {
            action: 'ACCOUNT_CLAIM_COMPLETED',
            entityType: 'PRINCIPAL',
            entityId: token.principalId,
            statusBefore: 'SUSPENDED',
            statusAfter: 'ACTIVE',
          },
        ),
      );
      return { status: 'CLAIMED' };
    });
  }

  /**
   * Complete the full onboarding in a single atomic transaction:
   * Consume claim token + set password + activate admin + update company profile + create primary HeadOffice.
   */
  async consumeClaimAndOnboard(
    rawToken: string,
    input: OnboardInput,
  ): Promise<{
    status: 'ONBOARDED';
    companyId: string;
    companyCode: string;
    headOfficeId?: string;
  }> {
    if (!input.password || input.password.length === 0) {
      throw new OrgValidationError('password', 'password is required');
    }
    const tokenHash = hashToken(rawToken);
    return this.uow.run(async (repos) => {
      const active = await repos.claimTokens.findActive(tokenHash, new Date());
      if (!active) {
        throw new UnauthorizedError('CLAIM_INVALID', 'claim code is invalid, expired, or used');
      }
      const token = await repos.claimTokens.consume(tokenHash, new Date());
      if (token === null) {
        throw new UnauthorizedError('CLAIM_INVALID', 'claim code is invalid, expired, or used');
      }
      const passwordHash = await passwordService.hash(input.password);
      const principalUpdate: Record<string, unknown> = {
        passwordHash,
        status: 'ACTIVE',
      };
      const trimmedLoginId = input.loginId?.trim();
      if (trimmedLoginId) {
        principalUpdate.loginId = trimmedLoginId.toLowerCase();
      }
      const activated = await repos.principals.activateIfSuspended(
        token.principalId,
        principalUpdate,
      );
      if (!activated) {
        throw new UnauthorizedError('CLAIM_INVALID', 'claim code is invalid, expired, or used');
      }

      const trimmedDisplayName = input.displayName?.trim();
      if (trimmedDisplayName) {
        await repos.employees.updateByPrincipalId(token.principalId, {
          displayName: trimmedDisplayName,
        });
      }

      if (input.company) {
        const cleanedCompany: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(input.company)) {
          if (v === null || v === undefined) continue;
          if (typeof v === 'string') {
            const trimmed = v.trim();
            if (trimmed === '') continue;
            if (k === 'formedOn') {
              const d = new Date(trimmed);
              if (!Number.isNaN(d.getTime())) cleanedCompany[k] = d;
              continue;
            }
            cleanedCompany[k] = trimmed;
          } else {
            cleanedCompany[k] = v;
          }
        }
        if (Object.keys(cleanedCompany).length > 0) {
          await repos.companies.update(active.companyId, cleanedCompany);
        }
      }

      let headOfficeId: string | undefined;
      const rawHoName = input.headOffice?.name?.trim();
      const rawHoCode = input.headOffice?.code?.trim().toUpperCase();
      const hoName = rawHoName && rawHoName.length > 0 ? rawHoName : undefined;
      const hoCode = rawHoCode && rawHoCode.length > 0 ? rawHoCode : undefined;
      if (input.headOffice && (hoName !== undefined || hoCode !== undefined)) {
        const cleanStr = (v?: string | null) => {
          const t = v?.trim();
          return t && t.length > 0 ? t : undefined;
        };
        const ho = await repos.headOffices.create({
          companyId: active.companyId,
          code: hoCode ?? 'HQ',
          name: hoName ?? hoCode ?? 'Head Office',
          // First HO is always primary — enforced, never client-controlled.
          isPrimary: true,
          status: 'ACTIVE',
          ...(cleanStr(input.headOffice.legalName)
            ? { legalName: cleanStr(input.headOffice.legalName) }
            : {}),
          ...(cleanStr(input.headOffice.addressLine1)
            ? { addressLine1: cleanStr(input.headOffice.addressLine1) }
            : {}),
          ...(cleanStr(input.headOffice.addressLine2)
            ? { addressLine2: cleanStr(input.headOffice.addressLine2) }
            : {}),
          ...(cleanStr(input.headOffice.locality)
            ? { locality: cleanStr(input.headOffice.locality) }
            : {}),
          ...(cleanStr(input.headOffice.city) ? { city: cleanStr(input.headOffice.city) } : {}),
          ...(cleanStr(input.headOffice.district)
            ? { district: cleanStr(input.headOffice.district) }
            : {}),
          ...(cleanStr(input.headOffice.state) ? { state: cleanStr(input.headOffice.state) } : {}),
          ...(cleanStr(input.headOffice.pinCode)
            ? { pinCode: cleanStr(input.headOffice.pinCode) }
            : {}),
          ...(cleanStr(input.headOffice.country)
            ? { country: cleanStr(input.headOffice.country) }
            : {}),
          ...(cleanStr(input.headOffice.contactName)
            ? { contactName: cleanStr(input.headOffice.contactName) }
            : {}),
          ...(cleanStr(input.headOffice.contactPhone)
            ? { contactPhone: cleanStr(input.headOffice.contactPhone) }
            : {}),
          ...(cleanStr(input.headOffice.contactEmail)
            ? { contactEmail: cleanStr(input.headOffice.contactEmail) }
            : {}),
        });
        headOfficeId = ho.id;
      }

      await repos.audit.record(
        auditEntry(
          { actorId: token.principalId, actorType: 'USER' },
          {
            action: 'ACCOUNT_CLAIM_COMPLETED',
            entityType: 'PRINCIPAL',
            entityId: token.principalId,
            companyId: active.companyId,
            statusBefore: 'SUSPENDED',
            statusAfter: 'ACTIVE',
          },
        ),
      );

      await repos.audit.record(
        auditEntry(
          { actorId: token.principalId, actorType: 'USER' },
          {
            action: 'COMPANY_ONBOARDING_COMPLETED',
            entityType: 'COMPANY',
            entityId: active.companyId,
            companyId: active.companyId,
            changedFields: {
              headOfficeCreated: { before: null, after: headOfficeId ?? null },
              onboarded: { before: false, after: true },
            },
          },
        ),
      );

      return {
        status: 'ONBOARDED',
        companyId: active.companyId,
        companyCode: active.companyCode,
        ...(headOfficeId !== undefined ? { headOfficeId } : {}),
      };
    });
  }

  /** Reissue: invalidate all unconsumed codes for the admin, mint a new one. */
  async reissueClaim(actor: ActorContext, companyId: string, adminPrincipalId: string) {
    return this.uow.run(async (repos) => {
      const company = await repos.companies.findById(companyId, companyId);
      if (!company || company.isPlatform) throw new OrgEntityNotFoundError('COMPANY');
      const revoked = await repos.claimTokens.revokeActive(adminPrincipalId, new Date());
      const raw = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + CLAIM_TTL_MS);
      await repos.claimTokens.create({
        principalId: adminPrincipalId,
        tokenHash: hashToken(raw),
        expiresAt,
      });
      await repos.audit.record(
        auditEntry(actor, {
          action: 'CLAIM_TOKEN_REISSUED',
          entityType: 'PRINCIPAL',
          entityId: adminPrincipalId,
          companyId,
          changedFields: {
            priorCodesRevoked: { before: revoked, after: 0 },
            claimExpiresAt: { before: null, after: expiresAt.toISOString() },
          },
        }),
      );
      const claimUrl = `${this.appBaseUrl.replace(/\/+$/, '')}/onboard?token=${raw}`;
      return {
        claimCode: raw,
        claimUrl,
        claimExpiresAt: expiresAt,
      };
    });
  }
}

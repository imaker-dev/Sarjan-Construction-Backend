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
 * issue/reissue one-time claim codes, and consume them. The Platform Admin
 * never creates tenant structure — only the Company and its owner.
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

export interface CreateCompanyResult {
  companyId: string;
  companyCode: string;
  adminPrincipalId: string;
  claimCode: string; // raw — returned once, never stored or logged
  claimExpiresAt: Date;
}

export class PlatformService {
  constructor(private readonly uow: PlatformUnitOfWork) {}

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
      return {
        companyId: company.id,
        companyCode: code,
        adminPrincipalId: admin.id,
        claimCode: raw,
        claimExpiresAt: expiresAt,
      };
    });
  }

  listCompanies() {
    return this.uow.run(({ companies }) => companies.list());
  }

  /** Consume a claim code: set the admin's real password + activate. One tx.
   *  The audit actor is the claimed principal themselves (a real USER). */
  async consumeClaim(rawToken: string, password: string) {
    if (password.length < 12) throw new OrgValidationError('password', 'at least 12 characters');
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
      return { claimCode: raw, claimExpiresAt: expiresAt };
    });
  }
}

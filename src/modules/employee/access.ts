import { randomBytes, createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { ActorContext } from '../organization/types.js';
import { auditEntry } from '../organization/service.js';
import { OrgEntityNotFoundError, OrgValidationError } from '../organization/errors.js';
import { AppError } from '../../common/errors/app-error.js';
import { findRoleTemplate } from '../setup/role-templates.js';
import { passwordService } from '../identity/password.js';

const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

export class EmployeeAccessService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cache?: import('../auth/cache.js').UserProfileCache,
  ) {}

  /** Invite a profile-only employee — suspended principal + one-time code. */
  async invite(
    actor: ActorContext,
    companyId: string,
    employeeId: string,
    loginId: string,
    loginIdType = 'EMAIL',
  ) {
    const email = loginId.toLowerCase().trim();
    if (loginIdType !== 'EMAIL' || email.length < 3 || email.length > 320) {
      throw new OrgValidationError('loginId', 'valid EMAIL required');
    }
    return this.prisma.$transaction(async (tx) => {
      const emp = await tx.employee.findFirst({ where: { id: employeeId, companyId } });
      if (!emp) throw new OrgEntityNotFoundError('EMPLOYEE');
      if (emp.status !== 'ACTIVE')
        throw new AppError(409, 'EMPLOYEE_INACTIVE', 'employee is not active');
      if (emp.principalId !== null)
        throw new AppError(409, 'ALREADY_LINKED', 'employee already has an account');
      const dup = await tx.principal.findUnique({ where: { loginId: email } });
      if (dup) throw new AppError(409, 'LOGIN_ID_TAKEN', 'loginId already exists');
      const placeholder = await passwordService.hash(randomBytes(32).toString('hex'));
      const principal = await tx.principal.create({
        data: {
          loginId: email,
          loginIdType: 'EMAIL',
          type: 'USER',
          status: 'SUSPENDED',
          passwordHash: placeholder,
        },
      });
      const { count } = await tx.employee.updateMany({
        where: { id: employeeId, companyId, principalId: null },
        data: { principalId: principal.id, version: { increment: 1 } },
      });
      if (count !== 1) throw new AppError(409, 'ALREADY_LINKED', 'employee already has an account');
      const raw = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + CLAIM_TTL_MS);
      await tx.claimToken.create({
        data: { principalId: principal.id, tokenHash: hashToken(raw), expiresAt },
      });
      await tx.auditLog.create({
        data: auditEntry(actor, {
          action: 'EMPLOYEE_INVITED',
          entityType: 'EMPLOYEE',
          entityId: employeeId,
          companyId,
        }) as never,
      });
      return { claimCode: raw, expiresAt };
    });
  }

  /** Reissue — revoke prior unused codes, mint a new one-time code. */
  async resend(actor: ActorContext, companyId: string, employeeId: string) {
    return this.prisma.$transaction(async (tx) => {
      const emp = await tx.employee.findFirst({
        where: { id: employeeId, companyId, principalId: { not: null } },
      });
      if (!emp?.principalId) throw new OrgEntityNotFoundError('EMPLOYEE');
      await tx.claimToken.updateMany({
        where: { principalId: emp.principalId, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      const raw = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + CLAIM_TTL_MS);
      await tx.claimToken.create({
        data: { principalId: emp.principalId, tokenHash: hashToken(raw), expiresAt },
      });
      await tx.auditLog.create({
        data: auditEntry(actor, {
          action: 'EMPLOYEE_INVITE_RESENT',
          entityType: 'EMPLOYEE',
          entityId: employeeId,
          companyId,
        }) as never,
      });
      return { claimCode: raw, expiresAt };
    });
  }

  async listAssignments(companyId: string, employeeId: string) {
    const emp = await this.prisma.employee.findFirst({ where: { id: employeeId, companyId } });
    if (!emp) throw new OrgEntityNotFoundError('EMPLOYEE');
    if (!emp.principalId) return [];
    return this.prisma.roleAssignment.findMany({
      where: { companyId, principalId: emp.principalId, revokedAt: null },
      include: { role: { select: { key: true, name: true } } },
    });
  }

  /** Grant a whitelisted role at its required scope shape. */
  async grant(
    actor: ActorContext,
    companyId: string,
    input: { employeeId: string; roleKey: string; scopeType: string; scopeId?: string },
  ) {
    const tpl = findRoleTemplate(input.roleKey);
    if (!tpl) throw new OrgValidationError('roleKey', 'not an assignable tenant role template');
    if (tpl.scopeShape !== input.scopeType) {
      throw new OrgValidationError('scopeType', `${tpl.key} requires ${tpl.scopeShape} scope`);
    }
    return this.prisma.$transaction(async (tx) => {
      const emp = await tx.employee.findFirst({ where: { id: input.employeeId, companyId } });
      if (!emp) throw new OrgEntityNotFoundError('EMPLOYEE');
      if (emp.status !== 'ACTIVE' || !emp.principalId) {
        throw new AppError(
          409,
          'EMPLOYEE_NOT_LINKED',
          'employee must be ACTIVE with a linked account',
        );
      }
      const principal = await tx.principal.findUnique({ where: { id: emp.principalId } });
      if (principal?.status !== 'ACTIVE' || principal.type !== 'USER') {
        throw new AppError(409, 'PRINCIPAL_INACTIVE', 'linked account must be an active user');
      }
      let role = await tx.role.findFirst({ where: { companyId, key: tpl.key, isSystem: true } });
      if (!role && typeof tx.role.create === 'function') {
        role = await tx.role.create({
          data: { companyId, key: tpl.key, name: tpl.name, isSystem: true },
        });
        for (const permKey of tpl.permissions) {
          const perm = await tx.permission.upsert({
            where: { key: permKey },
            update: {},
            create: { key: permKey, description: `${permKey} permission` },
          });
          await tx.rolePermission.createMany({
            data: [{ roleId: role.id, permissionId: perm.id }],
            skipDuplicates: true,
          });
        }
      }
      if (!role)
        throw new AppError(
          409,
          'ROLE_NOT_PROVISIONED',
          'role template not provisioned for company',
        );
      // Scope-shape check: COMPANY = null ids; HEAD_OFFICE = primary HO; PROJECT/SITE = owned by company.
      const scopeData: Record<string, unknown> = { scopeType: input.scopeType };
      const scopeFilter: Record<string, unknown> = {
        headOfficeId: null,
        projectId: null,
        siteId: null,
      };
      if (input.scopeType === 'HEAD_OFFICE') {
        const ho = await tx.headOffice.findFirst({
          where: { id: input.scopeId ?? '', companyId, isPrimary: true, status: 'ACTIVE' },
        });
        if (!ho) throw new OrgValidationError('scopeId', 'must be the company primary head office');
        scopeData.headOfficeId = input.scopeId;
        scopeFilter.headOfficeId = input.scopeId;
      } else if (input.scopeType === 'PROJECT') {
        const project = await tx.project.findFirst({
          where: { id: input.scopeId ?? '', companyId },
        });
        if (!project)
          throw new OrgValidationError('scopeId', 'must be a valid project in this company');
        scopeData.projectId = input.scopeId;
        scopeFilter.projectId = input.scopeId;
      } else if (input.scopeType === 'SITE') {
        const site = await tx.site.findFirst({
          where: { id: input.scopeId ?? '', companyId },
        });
        if (!site)
          throw new OrgValidationError('scopeId', 'must be a valid site in this company');
        scopeData.siteId = input.scopeId;
        scopeFilter.siteId = input.scopeId;
      } else if (input.scopeType === 'COMPANY') {
        if (input.scopeId !== undefined)
          throw new OrgValidationError('scopeId', 'COMPANY scope has no scopeId');
      }
      const dup = await tx.roleAssignment.findFirst({
        where: {
          companyId,
          principalId: emp.principalId,
          roleId: role.id,
          scopeType: input.scopeType as never,
          ...scopeFilter,
          revokedAt: null,
        },
      });
      if (dup) throw new AppError(409, 'ASSIGNMENT_EXISTS', 'assignment already active');
      const assignment = await tx.roleAssignment.create({
        data: {
          principalId: emp.principalId,
          roleId: role.id,
          companyId,
          scopeType: input.scopeType as never,
          ...(scopeData.headOfficeId !== undefined
            ? { headOfficeId: scopeData.headOfficeId as string }
            : {}),
          ...(scopeData.projectId !== undefined
            ? { projectId: scopeData.projectId as string }
            : {}),
          ...(scopeData.siteId !== undefined ? { siteId: scopeData.siteId as string } : {}),
          grantedByPrincipalId: actor.actorId,
        },
      });
      await tx.auditLog.create({
        data: auditEntry(actor, {
          action: 'ROLE_ASSIGNMENT_GRANTED',
          entityType: 'ROLE_ASSIGNMENT',
          entityId: assignment.id,
          companyId,
          changedFields: {
            roleKey: { before: null, after: tpl.key },
            scopeType: { before: null, after: input.scopeType },
          },
        }) as never,
      });
      if (this.cache && emp.principalId) {
        await this.cache.invalidate(emp.principalId);
      }
      return assignment;
    });
  }

  async revoke(actor: ActorContext, companyId: string, assignmentId: string) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.roleAssignment.findFirst({
        where: { id: assignmentId, companyId, revokedAt: null },
      });
      if (!existing) throw new OrgEntityNotFoundError('ROLE_ASSIGNMENT');
      await tx.roleAssignment.update({
        where: { id: assignmentId },
        data: { revokedAt: new Date() },
      });
      await tx.auditLog.create({
        data: auditEntry(actor, {
          action: 'ROLE_ASSIGNMENT_REVOKED',
          entityType: 'ROLE_ASSIGNMENT',
          entityId: assignmentId,

          // Phase 1 route wiring is in employee/routes.ts — service methods above.
        }) as never,
      });
      if (this.cache && existing.principalId) {
        await this.cache.invalidate(existing.principalId);
      }
      return { id: assignmentId, revoked: true };
    });
  }
}

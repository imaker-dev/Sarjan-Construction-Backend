import { randomUUID } from 'node:crypto';
import { UnauthorizedError, AppError } from '../../common/errors/app-error.js';
import { passwordService } from '../identity/password.js';
import { generateRefreshToken, hashRefreshToken, type TokenService } from './tokens.js';
import type { AuthUnitOfWork, PrincipalDetails } from './repository.js';
import type { ActorContext } from '../organization/types.js';
import type { MfaService, MfaChallengeResult } from './mfa.js';
import type { DelegationPolicyDto } from '../organization/delegation.js';
import { OrgEntityNotFoundError } from '../organization/errors.js';
import {
  type UserProfileCache,
  type UserProfileResponse,
  InMemoryUserProfileCache,
} from './cache.js';

export interface UserAggregatedProfileResponse {
  principal: {
    id: string;
    loginId: string;
    loginIdType: string;
    status: string;
    mfaEnabled: boolean;
    mfaType: string | null;
  };
  employee: {
    id: string;
    companyId: string;
    employeeCode: string;
    displayName: string;
    engagementType: string | null;
    designation: string | null;
    tradeCategory: string | null;
    joiningDate: string | null;
    contactPhone: string | null;
    contactEmail: string | null;
    emergencyContactName: string | null;
    emergencyContactPhone: string | null;
    status: string;
  } | null;
  company: {
    id: string;
    code: string;
    name: string;
    isPlatform: boolean;
  } | null;
  primaryRole: string | null;
  roles: string[];
  permissions: string[];
  departments: {
    departmentId: string;
    departmentCode: string;
    departmentName: string;
    category: string | null;
    isPrimary: boolean;
    headOfficeId?: string | null;
    headOfficeName?: string | null;
  }[];
  assignments: {
    id: string;
    roleKey: string;
    roleName: string;
    scopeType: string;
    headOfficeId: string | null;
    headOfficeName: string | null;
    projectId: string | null;
    projectName: string | null;
    siteId: string | null;
    siteName: string | null;
    effectiveFrom: string | null;
    effectiveTo: string | null;
  }[];
  attendance: {
    hasActiveSession: boolean;
    activeSession: {
      id: string;
      siteId: string | null;
      siteCode: string | null;
      siteName: string | null;
      headOfficeId?: string | null;
      headOfficeName?: string | null;
      businessDate: string;
      punchInAt: string;
      source: string;
      punchInWithinGeofence: boolean;
      isFlagged: boolean;
      flagReason: string | null;
      activeBreak: {
        id: string;
        breakType: string;
        startedAt: string;
      } | null;
    } | null;
  };
  leaveBalances: {
    leaveType: string;
    year: number;
    allocatedDays: number;
    usedDays: number;
    pendingDays: number;
    carriedOverDays: number;
    availableDays: number;
  }[];
  documents?: {
    id: string;
    documentType: string;
    title: string;
    documentNumber: string | null;
    issuingAuthority: string | null;
    issueDate: string | null;
    expiryDate: string | null;
    verificationStatus: string;
    verifiedAt: string | null;
    rejectionReason: string | null;
    createdAt: string;
    file: {
      id: string;
      fileName: string;
      contentType: string | null;
      sizeBytes: number | null;
      status: string;
    } | null;
  }[];
}

export interface AuthConfig {
  accessTokenTtlS: number;
  refreshTokenTtlS: number;
}

export interface AuthenticatedUser {
  id: string;
  loginId: string;
  displayName?: string;
  employeeCode?: string;
  companyId?: string;
  companyCode?: string;
  companyName?: string;
  isPlatform?: boolean;
  role?: string;
  roles: string[];
  operations?: string[];
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  role?: string;
  roles?: string[];
  user?: AuthenticatedUser;
  impersonated?: boolean;
}

export type LoginResult = AuthResult | MfaChallengeResult;

export interface RequestMeta {
  ip?: string | undefined;
  userAgent?: string | undefined;
  correlationId?: string | undefined;
}

const INVALID = () => new UnauthorizedError('INVALID_CREDENTIALS', 'Invalid credentials');

export class AuthService {
  constructor(
    private readonly uow: AuthUnitOfWork,
    private readonly tokens: TokenService,
    private readonly cfg: AuthConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly resolveOperations?: (
      companyId: string,
      employeeId: string,
    ) => Promise<string[]>,
    private readonly cache: UserProfileCache = new InMemoryUserProfileCache(),
    readonly mfaService?: MfaService | undefined,
    private readonly resolveDelegations?: (companyId: string) => Promise<DelegationPolicyDto>,
  ) {}

  get userCache(): UserProfileCache {
    return this.cache;
  }

  /**
   * Authenticate a human principal. Returns generic INVALID_CREDENTIALS for
   * every failure mode — never reveals whether the account exists, is
   * suspended, or is a non-human principal.
   */
  async login(
    input: { loginId: string; password: string },
    meta: RequestMeta,
  ): Promise<LoginResult> {
    const loginId = normalizeLoginId(input.loginId);

    const principal = await this.uow.run(({ principals }) =>
      principals.findWithDetailsByLoginId
        ? principals.findWithDetailsByLoginId(loginId)
        : principals.findByLoginId(loginId),
    );

    // Always verify a password-shaped value to keep timing uniform —
    // unknown accounts verify against a dummy hash.
    const passwordOk = await passwordService.verify(principal?.passwordHash, input.password);
    const humanAllowed = principal?.type === 'USER'; // SERVICE/SYSTEM can't log in
    const active = principal?.status === 'ACTIVE';
    if (!principal || !passwordOk || !humanAllowed || !active) {
      throw INVALID();
    }

    if (this.mfaService && (await this.mfaService.isMfaEnabled(principal.id))) {
      return this.mfaService.createChallenge(principal.id, principal.loginId ?? loginId);
    }

    return this.completeSessionForPrincipal(principal, meta);
  }

  async completeMfaLogin(mfaToken: string, code: string, meta: RequestMeta): Promise<AuthResult> {
    if (!this.mfaService) {
      throw new UnauthorizedError('MFA_NOT_CONFIGURED', 'MFA service not configured');
    }
    const { principalId } = await this.mfaService.verifyChallenge(mfaToken, code);
    const principal = await this.uow.run(({ principals }) => principals.findById(principalId));
    if (principal?.status !== 'ACTIVE' || principal.type !== 'USER') {
      throw INVALID();
    }
    const withDetails = await this.uow.run(async ({ principals }) => {
      if (principal.loginId && principals.findWithDetailsByLoginId) {
        return principals.findWithDetailsByLoginId(principal.loginId);
      }
      return principal;
    });
    return this.completeSessionForPrincipal(withDetails ?? principal, meta);
  }

  async createImpersonationSession(
    superAdminActor: ActorContext,
    targetPrincipalId: string,
    meta: RequestMeta,
  ): Promise<AuthResult & { impersonated: true }> {
    const principal = await this.uow.run(({ principals }) =>
      principals.findById(targetPrincipalId),
    );
    if (principal?.status !== 'ACTIVE' || principal.type !== 'USER') {
      throw new OrgEntityNotFoundError('PRINCIPAL');
    }
    const withDetails = await this.uow.run(async ({ principals }) => {
      if (principal.loginId && principals.findWithDetailsByLoginId) {
        return principals.findWithDetailsByLoginId(principal.loginId);
      }
      return principal;
    });
    const res = await this.completeSessionForPrincipal(
      withDetails ?? principal,
      meta,
      superAdminActor.actorId,
    );
    return {
      ...res,
      impersonated: true,
    };
  }

  async completeSessionForPrincipal(
    principal: PrincipalDetails | Record<string, unknown>,
    meta: RequestMeta,
    impersonatedBy?: string,
  ): Promise<AuthResult> {
    const pId = 'id' in principal && typeof principal.id === 'string' ? principal.id : '';
    const pLoginId =
      'loginId' in principal && typeof principal.loginId === 'string' ? principal.loginId : '';

    return this.uow.run(async ({ sessions, refreshTokens, audit }) => {
      const familyId = randomUUID();
      const refreshTtlMs = this.cfg.refreshTokenTtlS * 1000;
      const session = await sessions.create({
        principalId: pId,
        familyId,
        expiresAt: new Date(this.now().getTime() + refreshTtlMs),
        ...(meta.ip !== undefined ? { ip: meta.ip } : {}),
        ...(meta.userAgent !== undefined ? { userAgent: meta.userAgent } : {}),
      });
      const refreshToken = generateRefreshToken();
      await refreshTokens.create({
        sessionId: session.id,
        tokenHash: hashRefreshToken(refreshToken),
        expiresAt: session.expiresAt,
      });

      const auditAction = impersonatedBy
        ? 'SUPER_ADMIN_IMPERSONATION_LOGIN'
        : 'AUTH_LOGIN_SUCCEEDED';

      await audit.record({
        eventKey: randomUUID(),
        action: auditAction,
        entityType: 'PRINCIPAL',
        entityId: pId,
        actorId: impersonatedBy ?? pId,
        actorType: 'USER',
        ...(meta.correlationId !== undefined ? { correlationId: meta.correlationId } : {}),
        statusAfter: 'ACTIVE',
        ...(impersonatedBy ? { metadata: { impersonatedBy } } : {}),
      });

      const roles: string[] = [];
      const details = principal as {
        employees?: {
          displayName?: string;
          employeeCode?: string;
          companyId?: string;
          company?: { id: string; code: string; name: string; isPlatform: boolean };
        }[];
        roleAssignments?: { role?: { key?: string }; companyId?: string }[];
      };
      if (details.roleAssignments) {
        for (const ra of details.roleAssignments) {
          if (ra.role?.key && !roles.includes(ra.role.key)) {
            roles.push(ra.role.key);
          }
        }
      }
      const emp = details.employees?.[0];
      const userInfo: AuthenticatedUser = {
        id: pId,
        loginId: pLoginId,
        ...(emp?.displayName !== undefined ? { displayName: emp.displayName } : {}),
        ...(emp?.employeeCode !== undefined ? { employeeCode: emp.employeeCode } : {}),
        ...(emp?.companyId !== undefined ? { companyId: emp.companyId } : {}),
        ...(emp?.company?.code !== undefined ? { companyCode: emp.company.code } : {}),
        ...(emp?.company?.name !== undefined ? { companyName: emp.company.name } : {}),
        ...(emp?.company?.isPlatform !== undefined ? { isPlatform: emp.company.isPlatform } : {}),
        ...(roles[0] !== undefined ? { role: roles[0] } : {}),
        roles,
      };

      const operations =
        emp && 'id' in emp && emp.companyId !== undefined && this.resolveOperations !== undefined
          ? await this.resolveOperations(emp.companyId, (emp as { id: string }).id)
          : undefined;
      if (operations !== undefined) userInfo.operations = operations;

      return {
        accessToken: this.tokens.signAccessToken(pId, session.id),
        refreshToken,
        expiresIn: this.cfg.accessTokenTtlS,
        tokenType: 'Bearer',
        roles,
        user: userInfo,
        ...(impersonatedBy ? { impersonated: true } : {}),
      };
    });
  }

  /**
   * Rotate a refresh token. One row per issued token lets us detect replay:
   * presenting an already-consumed token revokes the whole session family.
   */
  async refresh(input: { refreshToken: string }, meta: RequestMeta): Promise<AuthResult> {
    const tokenHash = hashRefreshToken(input.refreshToken);
    const now = this.now();

    // Read-only check first: replay revocation must commit, so it cannot live
    // in the same transaction as the throw below.
    const presented = await this.uow.run(({ refreshTokens }) =>
      refreshTokens.findByHash(tokenHash),
    );
    if (!presented) throw INVALID();

    const session = await this.uow.run(({ sessions }) => sessions.findById(presented.sessionId));
    if (!session) throw INVALID();

    if (presented.consumedAt !== null || presented.revokedAt !== null) {
      // Replay detected — revoke the family in a transaction that COMMITS,
      // then deny.
      await this.uow.run(async ({ sessions: s, refreshTokens: t, audit }) => {
        await s.revokeFamily(session.familyId);
        await t.revokeBySession(session.id);
        await audit.record({
          eventKey: randomUUID(),
          action: 'AUTH_REFRESH_REPLAY_DETECTED',
          entityType: 'PRINCIPAL',
          entityId: session.principalId,
          actorId: session.principalId,
          actorType: 'USER',
          ...(meta.correlationId !== undefined ? { correlationId: meta.correlationId } : {}),
          statusBefore: session.status,
          statusAfter: 'REVOKED',
        });
      });
      throw INVALID();
    }

    if (session.status !== 'ACTIVE' || session.expiresAt <= now || presented.expiresAt <= now) {
      throw INVALID();
    }

    return this.uow.run(async ({ refreshTokens, sessions }) => {
      // Atomically consume then issue the replacement.
      const replacement = generateRefreshToken();
      const replacementRow = await refreshTokens.create({
        sessionId: session.id,
        tokenHash: hashRefreshToken(replacement),
        expiresAt: session.expiresAt,
      });
      const consumed = await refreshTokens.consume(presented.id, replacementRow.id);
      if (consumed === 0) {
        // Lost a concurrent consume race — treat as replay.
        await sessions.revokeFamily(session.familyId);
        throw INVALID();
      }
      return this.issueTokens({ id: session.principalId }, session.id, replacement);
    });
  }

  /** Revoke the caller's session and all refresh tokens in its family. */
  async logout(principal: ActorContext & { sessionId: string }): Promise<void> {
    return this.uow.run(async ({ sessions, refreshTokens, audit }) => {
      const session = await sessions.findById(principal.sessionId);
      // No-404 leakage: missing/foreign session is still a clean 401/empty.
      if (session?.principalId !== principal.actorId) {
        throw new UnauthorizedError('SESSION_INVALID', 'Session is not active');
      }
      await sessions.revoke(session.id);
      await refreshTokens.revokeBySession(session.id);
      await audit.record({
        eventKey: randomUUID(),
        action: 'AUTH_LOGOUT',
        entityType: 'PRINCIPAL',
        entityId: session.principalId,
        actorId: session.principalId,
        actorType: 'USER',
        statusBefore: session.status,
        statusAfter: 'REVOKED',
      });
    });
  }

  async changePassword(
    principalId: string,
    input: { currentPassword: string; newPassword: string },
    meta: RequestMeta = {},
  ): Promise<{ success: boolean; message: string }> {
    if (!input.currentPassword || !input.newPassword) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Current password and new password are required');
    }
    if (input.newPassword.length < 8) {
      throw new AppError(
        400,
        'PASSWORD_TOO_WEAK',
        'New password must be at least 8 characters long',
      );
    }
    if (input.newPassword.length > 128) {
      throw new AppError(400, 'PASSWORD_TOO_LONG', 'New password must not exceed 128 characters');
    }
    if (input.newPassword === input.currentPassword) {
      throw new AppError(
        400,
        'SAME_PASSWORD',
        'New password must be different from current password',
      );
    }

    return this.uow.run(async ({ principals, audit }) => {
      const principal = await principals.findById(principalId);
      if (principal?.status !== 'ACTIVE') {
        throw new UnauthorizedError('ACCOUNT_INACTIVE', 'Account is not active');
      }

      const currentValid = await passwordService.verify(
        principal.passwordHash,
        input.currentPassword,
      );
      if (!currentValid) {
        throw new AppError(400, 'INVALID_CURRENT_PASSWORD', 'Current password is incorrect');
      }

      const newHash = await passwordService.hash(input.newPassword);
      if (principals.updatePassword) {
        await principals.updatePassword(principal.id, newHash);
      }

      await audit.record({
        eventKey: randomUUID(),
        action: 'AUTH_PASSWORD_CHANGED',
        entityType: 'PRINCIPAL',
        entityId: principal.id,
        actorId: principal.id,
        actorType: principal.type,
        ...(meta.correlationId !== undefined ? { correlationId: meta.correlationId } : {}),
      });

      return {
        success: true,
        message: 'Password changed successfully',
      };
    });
  }

  async requestMfaSetup(principalId: string): Promise<MfaChallengeResult> {
    if (!this.mfaService) {
      throw new AppError(400, 'MFA_NOT_CONFIGURED', 'MFA service not configured');
    }
    const full = await this.uow.run(async ({ principals }) => {
      if (principals.findFullProfile) {
        return principals.findFullProfile(principalId);
      }
      return null;
    });
    if (full?.status !== 'ACTIVE') {
      throw new UnauthorizedError('ACCOUNT_INACTIVE', 'Account is not active');
    }
    const email = full.employees[0]?.contactEmail ?? full.loginId;
    if (!email) {
      throw new AppError(400, 'NO_EMAIL_FOUND', 'No valid email found on account for MFA setup');
    }
    return this.mfaService.createChallenge(principalId, email);
  }

  async confirmMfaSetup(
    principalId: string,
    mfaToken: string,
    code: string,
  ): Promise<{ success: boolean; mfaEnabled: boolean; mfaType: string }> {
    if (!this.mfaService) {
      throw new AppError(400, 'MFA_NOT_CONFIGURED', 'MFA service not configured');
    }
    const verified = await this.mfaService.verifyChallenge(mfaToken, code);
    if (verified.principalId !== principalId) {
      throw new UnauthorizedError('INVALID_MFA_TOKEN');
    }
    await this.mfaService.enableMfa(principalId, 'EMAIL_OTP');
    return {
      success: true,
      mfaEnabled: true,
      mfaType: 'EMAIL_OTP',
    };
  }

  /**
   * Resolve verified token claims into a request actor context. Revalidates
   * the session and principal status on every call — suspension/revocation
   * takes effect immediately. No authorization caching.
   */
  async buildActorContext(
    claims: { sub: string; sid: string },
    meta: RequestMeta = {},
  ): Promise<ActorContext & { sessionId: string }> {
    const session = await this.uow.run(({ sessions }) => sessions.findById(claims.sid));
    const now = this.now();
    if (session === null) {
      throw new UnauthorizedError('SESSION_INVALID', 'Session is not active');
    }
    if (session.status !== 'ACTIVE' || session.expiresAt <= now) {
      throw new UnauthorizedError('SESSION_INVALID', 'Session is not active');
    }
    if (session.principalId !== claims.sub) {
      throw new UnauthorizedError('SESSION_INVALID', 'Session is not active');
    }
    const principal = await this.uow.run(({ principals }) => principals.findById(claims.sub));
    if (principal?.status !== 'ACTIVE') {
      throw new UnauthorizedError('ACCOUNT_INACTIVE', 'Account is not active');
    }
    return {
      actorId: principal.id,
      actorType: principal.type,
      sessionId: session.id,
      ...(meta.correlationId !== undefined ? { correlationId: meta.correlationId } : {}),
    };
  }

  async getMe(principalId: string, companyId?: string): Promise<UserProfileResponse> {
    const cached = await this.cache.get(principalId, companyId);
    if (cached !== null) {
      return this.withLiveOperations(cached);
    }

    const full = await this.uow.run(async ({ principals }) => {
      if (principals.findFullProfile) {
        return principals.findFullProfile(principalId, companyId, this.now());
      }
      return null;
    });

    if (full?.status !== 'ACTIVE') {
      throw new UnauthorizedError('ACCOUNT_INACTIVE', 'Account is not active');
    }

    const emp = full.employees[0];
    const company = emp?.company ?? null;

    const roles: string[] = [];
    const permissions: string[] = [];
    const assignments: UserProfileResponse['assignments'] = [];

    for (const ra of full.roleAssignments) {
      if (!roles.includes(ra.role.key)) {
        roles.push(ra.role.key);
      }
      for (const rp of ra.role.permissions) {
        if (!permissions.includes(rp.permission.key)) {
          permissions.push(rp.permission.key);
        }
      }
      assignments.push({
        id: ra.id,
        roleKey: ra.role.key,
        roleName: ra.role.name,
        scopeType: ra.scopeType,
        headOfficeId: ra.headOfficeId,
        headOfficeName: ra.headOffice?.name ?? null,
        projectId: ra.projectId,
        projectName: ra.project?.name ?? null,
        siteId: ra.siteId,
        siteName: ra.site?.name ?? null,
        effectiveFrom: ra.effectiveFrom ? ra.effectiveFrom.toISOString() : null,
        effectiveTo: ra.effectiveTo ? ra.effectiveTo.toISOString() : null,
      });
    }

    const departments: UserProfileResponse['departments'] = [];
    if (emp?.memberships) {
      for (const m of emp.memberships) {
        departments.push({
          departmentId: m.departmentId,
          departmentCode: m.department.code,
          departmentName: m.department.name,
          category: (m.department as { category?: string }).category ?? null,
          isPrimary: m.isPrimary,
          headOfficeId: m.department.baseHeadOfficeId ?? null,
          headOfficeName: m.department.baseHeadOffice?.name ?? null,
        });
      }
    }

    const documentsData: NonNullable<UserProfileResponse['documents']> = [];
    if (emp?.documents) {
      for (const doc of emp.documents) {
        documentsData.push({
          id: doc.id,
          documentType: doc.documentType,
          title: doc.title,
          documentNumber: doc.documentNumber ?? null,
          issuingAuthority: doc.issuingAuthority ?? null,
          issueDate: doc.issueDate
            ? doc.issueDate instanceof Date
              ? doc.issueDate.toISOString().slice(0, 10)
              : String(doc.issueDate).slice(0, 10)
            : null,
          expiryDate: doc.expiryDate
            ? doc.expiryDate instanceof Date
              ? doc.expiryDate.toISOString().slice(0, 10)
              : String(doc.expiryDate).slice(0, 10)
            : null,
          verificationStatus: doc.verificationStatus,
          verifiedAt: doc.verifiedAt
            ? doc.verifiedAt instanceof Date
              ? doc.verifiedAt.toISOString()
              : String(doc.verifiedAt)
            : null,
          rejectionReason: doc.rejectionReason ?? null,
          createdAt:
            doc.createdAt instanceof Date ? doc.createdAt.toISOString() : String(doc.createdAt),
          file: doc.document
            ? {
                id: doc.document.id,
                fileName: doc.document.originalFileName,
                contentType: doc.document.contentType ?? null,
                sizeBytes: doc.document.sizeBytes ?? null,
                status: doc.document.status,
              }
            : null,
        });
      }
    }

    const isCompanyScoped =
      roles.includes('PLATFORM_ADMIN') ||
      roles.includes('COMPANY_OWNER') ||
      permissions.includes('ORG_COMPANY_READ') ||
      permissions.includes('ORG_COMPANY_UPDATE') ||
      assignments.some((a) => a.scopeType === 'COMPANY' && a.roleKey !== 'EMPLOYEE');

    const response: UserProfileResponse = {
      id: full.id,
      loginId: full.loginId ?? '',
      loginIdType: full.loginIdType ?? 'EMAIL',
      status: full.status,
      displayName: emp?.displayName ?? full.loginId ?? 'User',
      employeeId: emp?.id ?? null,
      employeeCode: emp?.employeeCode ?? null,
      designation: emp?.designation ?? null,
      tradeCategory: emp?.tradeCategory ?? null,
      contactPhone: emp?.contactPhone ?? null,
      contactEmail: emp?.contactEmail ?? null,
      joiningDate: emp?.joiningDate ? emp.joiningDate.toISOString().slice(0, 10) : null,
      company: company
        ? {
            id: company.id,
            code: company.code,
            name: company.name,
            isPlatform: company.isPlatform,
          }
        : null,
      role: roles[0] ?? null,
      roles,
      permissions,
      isCompanyScoped,
      assignments,
      departments,
      documents: documentsData,
    };

    await this.cache.set(principalId, response, companyId);
    return this.withLiveOperations(response);
  }

  /**
   * Operations and company delegation flags are resolved live on every /auth/me
   * call — outside the cached profile — so admin enable/disable is reflected
   * immediately rather than after the profile TTL expires.
   */
  private async withLiveOperations(profile: UserProfileResponse): Promise<UserProfileResponse> {
    const companyId = profile.company?.id ?? null;
    const [operations, delegations] = await Promise.all([
      profile.employeeId !== null && companyId !== null && this.resolveOperations !== undefined
        ? this.resolveOperations(companyId, profile.employeeId)
        : Promise.resolve(undefined),
      companyId !== null && this.resolveDelegations !== undefined
        ? this.resolveDelegations(companyId)
        : Promise.resolve(undefined),
    ]);
    if (operations === undefined && delegations === undefined) {
      return profile;
    }
    return {
      ...profile,
      ...(operations !== undefined ? { operations } : {}),
      ...(delegations !== undefined ? { delegations } : {}),
    };
  }

  async getProfile(
    principalId: string,
    companyId?: string,
  ): Promise<UserAggregatedProfileResponse> {
    const full = await this.uow.run(async ({ principals }) => {
      if (principals.findFullProfile) {
        return principals.findFullProfile(principalId, companyId, this.now());
      }
      return null;
    });

    if (full?.status !== 'ACTIVE') {
      throw new UnauthorizedError('ACCOUNT_INACTIVE', 'Account is not active');
    }

    const emp = full.employees[0];
    const company = emp?.company ?? null;

    const roles: string[] = [];
    const permissions: string[] = [];
    const assignments: UserAggregatedProfileResponse['assignments'] = [];

    for (const ra of full.roleAssignments) {
      if (!roles.includes(ra.role.key)) {
        roles.push(ra.role.key);
      }
      for (const rp of ra.role.permissions) {
        if (!permissions.includes(rp.permission.key)) {
          permissions.push(rp.permission.key);
        }
      }
      assignments.push({
        id: ra.id,
        roleKey: ra.role.key,
        roleName: ra.role.name,
        scopeType: ra.scopeType,
        headOfficeId: ra.headOfficeId ?? null,
        headOfficeName: ra.headOffice?.name ?? null,
        projectId: ra.projectId ?? null,
        projectName: ra.project?.name ?? null,
        siteId: ra.siteId ?? null,
        siteName: ra.site?.name ?? null,
        effectiveFrom: ra.effectiveFrom ? ra.effectiveFrom.toISOString() : null,
        effectiveTo: ra.effectiveTo ? ra.effectiveTo.toISOString() : null,
      });
    }

    const departments: UserAggregatedProfileResponse['departments'] = [];
    if (emp?.memberships) {
      for (const m of emp.memberships) {
        departments.push({
          departmentId: m.departmentId,
          departmentCode: m.department.code,
          departmentName: m.department.name,
          category: (m.department as { category?: string }).category ?? null,
          isPrimary: m.isPrimary,
          headOfficeId: m.department.baseHeadOfficeId ?? null,
          headOfficeName: m.department.baseHeadOffice?.name ?? null,
        });
      }
    }

    let activeSessionData: UserAggregatedProfileResponse['attendance']['activeSession'] = null;
    if (emp?.attendanceSessions && emp.attendanceSessions.length > 0) {
      const s = emp.attendanceSessions[0];
      if (s) {
        const activeBreak = s.breaks.find((b) => b.endedAt === null) ?? null;
        activeSessionData = {
          id: s.id,
          siteId: s.siteId,
          siteCode: s.site?.code ?? null,
          siteName: s.site?.name ?? null,
          headOfficeId: s.headOfficeId ?? null,
          headOfficeName: s.headOffice?.name ?? null,
          businessDate: s.businessDate,
          punchInAt: s.punchInAt instanceof Date ? s.punchInAt.toISOString() : String(s.punchInAt),
          source: s.source,
          punchInWithinGeofence: s.punchInWithinGeofence,
          isFlagged: s.isFlagged,
          flagReason: s.flagReason,
          activeBreak: activeBreak
            ? {
                id: activeBreak.id,
                breakType: activeBreak.breakType,
                startedAt:
                  activeBreak.startedAt instanceof Date
                    ? activeBreak.startedAt.toISOString()
                    : String(activeBreak.startedAt),
              }
            : null,
        };
      }
    }

    const leaveBalancesData: UserAggregatedProfileResponse['leaveBalances'] = [];
    if (emp?.leaveBalances) {
      for (const lb of emp.leaveBalances) {
        const allocated = Number(lb.allocatedDays ?? 0);
        const used = Number(lb.usedDays ?? 0);
        const pending = Number(lb.pendingDays ?? 0);
        const carried = Number(lb.carriedOverDays ?? 0);
        const available = Math.max(0, allocated + carried - used - pending);
        leaveBalancesData.push({
          leaveType: lb.leaveType,
          year: lb.year,
          allocatedDays: allocated,
          usedDays: used,
          pendingDays: pending,
          carriedOverDays: carried,
          availableDays: available,
        });
      }
    }

    const profileDocumentsData: NonNullable<UserAggregatedProfileResponse['documents']> = [];
    if (emp?.documents) {
      for (const doc of emp.documents) {
        profileDocumentsData.push({
          id: doc.id,
          documentType: doc.documentType,
          title: doc.title,
          documentNumber: doc.documentNumber ?? null,
          issuingAuthority: doc.issuingAuthority ?? null,
          issueDate: doc.issueDate
            ? doc.issueDate instanceof Date
              ? doc.issueDate.toISOString().slice(0, 10)
              : String(doc.issueDate).slice(0, 10)
            : null,
          expiryDate: doc.expiryDate
            ? doc.expiryDate instanceof Date
              ? doc.expiryDate.toISOString().slice(0, 10)
              : String(doc.expiryDate).slice(0, 10)
            : null,
          verificationStatus: doc.verificationStatus,
          verifiedAt: doc.verifiedAt
            ? doc.verifiedAt instanceof Date
              ? doc.verifiedAt.toISOString()
              : String(doc.verifiedAt)
            : null,
          rejectionReason: doc.rejectionReason ?? null,
          createdAt:
            doc.createdAt instanceof Date ? doc.createdAt.toISOString() : String(doc.createdAt),
          file: doc.document
            ? {
                id: doc.document.id,
                fileName: doc.document.originalFileName,
                contentType: doc.document.contentType ?? null,
                sizeBytes: doc.document.sizeBytes ?? null,
                status: doc.document.status,
              }
            : null,
        });
      }
    }

    let mfaEnabled = false;
    let mfaType: string | null = null;
    if (this.mfaService) {
      const status = await this.mfaService.getStatus(principalId);
      mfaEnabled = status.mfaEnabled;
      mfaType = status.mfaType;
    }

    return {
      principal: {
        id: full.id,
        loginId: full.loginId ?? '',
        loginIdType: full.loginIdType ?? 'EMAIL',
        status: full.status,
        mfaEnabled,
        mfaType,
      },
      employee: emp
        ? {
            id: emp.id,
            companyId: emp.companyId,
            employeeCode: emp.employeeCode,
            displayName: emp.displayName,
            engagementType: emp.engagementType ?? null,
            designation: emp.designation ?? null,
            tradeCategory: emp.tradeCategory ?? null,
            joiningDate: emp.joiningDate
              ? emp.joiningDate instanceof Date
                ? emp.joiningDate.toISOString().slice(0, 10)
                : String(emp.joiningDate).slice(0, 10)
              : null,
            contactPhone: emp.contactPhone ?? null,
            contactEmail: emp.contactEmail ?? null,
            emergencyContactName: emp.emergencyContactName ?? null,
            emergencyContactPhone: emp.emergencyContactPhone ?? null,
            status: emp.status,
          }
        : null,
      company: company
        ? {
            id: company.id,
            code: company.code,
            name: company.name,
            isPlatform: company.isPlatform,
          }
        : null,
      primaryRole: roles[0] ?? null,
      roles,
      permissions,
      departments,
      assignments,
      attendance: {
        hasActiveSession: activeSessionData !== null,
        activeSession: activeSessionData,
      },
      leaveBalances: leaveBalancesData,
      documents: profileDocumentsData,
    };
  }

  private issueTokens(
    principal: { id: string },
    sessionId: string,
    refreshToken: string,
    user?: AuthenticatedUser,
  ): AuthResult {
    return {
      accessToken: this.tokens.signAccessToken(principal.id, sessionId),
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.cfg.accessTokenTtlS, // access-token lifetime, not refresh
      ...(user?.role !== undefined ? { role: user.role } : {}),
      ...(user?.roles !== undefined ? { roles: user.roles } : {}),
      ...(user !== undefined ? { user } : {}),
    };
  }
}

export function normalizeLoginId(raw: string): string {
  return raw.trim().toLowerCase();
}

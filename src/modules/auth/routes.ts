import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { UnauthorizedError, AppError } from '../../common/errors/app-error.js';
import type { AuthService } from './service.js';

const LoginBody = Type.Object({
  loginId: Type.String({ minLength: 1, maxLength: 320 }),
  password: Type.String({ minLength: 1, maxLength: 512 }),
});

const RefreshBody = Type.Object({
  refreshToken: Type.String({ minLength: 1, maxLength: 512 }),
});

const UserProfile = Type.Object({
  id: Type.String(),
  loginId: Type.String(),
  displayName: Type.Optional(Type.String()),
  employeeCode: Type.Optional(Type.String()),
  companyId: Type.Optional(Type.String()),
  companyCode: Type.Optional(Type.String()),
  companyName: Type.Optional(Type.String()),
  isPlatform: Type.Optional(Type.Boolean()),
  role: Type.Optional(Type.String()),
  roles: Type.Array(Type.String()),
  operations: Type.Optional(Type.Array(Type.String())),
});

const TokenResponse = Type.Object({
  accessToken: Type.String(),
  refreshToken: Type.String(),
  tokenType: Type.Literal('Bearer'),
  expiresIn: Type.Number(),
  role: Type.Optional(Type.String()),
  roles: Type.Optional(Type.Array(Type.String())),
  user: Type.Optional(UserProfile),
  impersonated: Type.Optional(Type.Boolean()),
});

const MfaChallengeResponse = Type.Object({
  mfaRequired: Type.Literal(true),
  mfaToken: Type.String(),
  mfaType: Type.Literal('EMAIL_OTP'),
  maskedEmail: Type.String(),
  expiresInSeconds: Type.Integer(),
});

const LoginResponse = Type.Union([TokenResponse, MfaChallengeResponse]);

const MfaVerifyBody = Type.Object({
  mfaToken: Type.String({ minLength: 1 }),
  code: Type.String({ minLength: 6, maxLength: 6 }),
});

const MfaSendOtpBody = Type.Object({
  mfaToken: Type.String({ minLength: 1 }),
});

const MfaStatusResponse = Type.Object({
  mfaEnabled: Type.Boolean(),
  mfaType: Type.Union([Type.String(), Type.Null()]),
});

const MfaToggleResponse = Type.Object({
  success: Type.Boolean(),
  mfaEnabled: Type.Boolean(),
  mfaType: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
});

const MfaEnableBody = Type.Optional(
  Type.Object({
    mfaToken: Type.Optional(Type.String({ minLength: 1 })),
    code: Type.Optional(Type.String({ minLength: 6, maxLength: 6 })),
  }),
);

const ChangePasswordBody = Type.Object({
  currentPassword: Type.String({ minLength: 1, maxLength: 512 }),
  newPassword: Type.String({ minLength: 8, maxLength: 128 }),
});

const ChangePasswordResponse = Type.Object({
  success: Type.Boolean(),
  message: Type.String(),
});

const EmptyResponse = Type.Object({});

const UserDocumentItemSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  documentType: Type.String(),
  title: Type.String(),
  documentNumber: Type.Union([Type.String(), Type.Null()]),
  issuingAuthority: Type.Union([Type.String(), Type.Null()]),
  issueDate: Type.Union([Type.String(), Type.Null()]),
  expiryDate: Type.Union([Type.String(), Type.Null()]),
  verificationStatus: Type.String(),
  verifiedAt: Type.Union([Type.String(), Type.Null()]),
  rejectionReason: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  file: Type.Union([
    Type.Object({
      id: Type.String({ format: 'uuid' }),
      fileName: Type.String(),
      contentType: Type.Union([Type.String(), Type.Null()]),
      sizeBytes: Type.Union([Type.Integer(), Type.Null()]),
      status: Type.String(),
    }),
    Type.Null(),
  ]),
});

const UserMeResponseSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  loginId: Type.String(),
  loginIdType: Type.String(),
  status: Type.String(),
  displayName: Type.String(),
  employeeId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  employeeCode: Type.Union([Type.String(), Type.Null()]),
  designation: Type.Union([Type.String(), Type.Null()]),
  tradeCategory: Type.Union([Type.String(), Type.Null()]),
  contactPhone: Type.Union([Type.String(), Type.Null()]),
  contactEmail: Type.Union([Type.String(), Type.Null()]),
  joiningDate: Type.Union([Type.String(), Type.Null()]),
  company: Type.Union([
    Type.Object({
      id: Type.String({ format: 'uuid' }),
      code: Type.String(),
      name: Type.String(),
      isPlatform: Type.Boolean(),
    }),
    Type.Null(),
  ]),
  role: Type.Union([Type.String(), Type.Null()]),
  roles: Type.Array(Type.String()),
  permissions: Type.Array(Type.String()),
  operations: Type.Optional(Type.Array(Type.String())),
  assignments: Type.Array(
    Type.Object({
      id: Type.String({ format: 'uuid' }),
      roleKey: Type.String(),
      roleName: Type.String(),
      scopeType: Type.String(),
      headOfficeId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
      headOfficeName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      projectId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
      projectName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      siteId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
      siteName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      effectiveFrom: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      effectiveTo: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
  ),
  departments: Type.Array(
    Type.Object({
      departmentId: Type.String({ format: 'uuid' }),
      departmentCode: Type.String(),
      departmentName: Type.String(),
      category: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      isPrimary: Type.Boolean(),
      headOfficeId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
      headOfficeName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
  ),
  documents: Type.Optional(Type.Array(UserDocumentItemSchema)),
});

const UserAggregatedProfileResponseSchema = Type.Object({
  principal: Type.Object({
    id: Type.String({ format: 'uuid' }),
    loginId: Type.String(),
    loginIdType: Type.String(),
    status: Type.String(),
    mfaEnabled: Type.Boolean(),
    mfaType: Type.Union([Type.String(), Type.Null()]),
  }),
  employee: Type.Union([
    Type.Object({
      id: Type.String({ format: 'uuid' }),
      companyId: Type.String({ format: 'uuid' }),
      employeeCode: Type.String(),
      displayName: Type.String(),
      engagementType: Type.Union([Type.String(), Type.Null()]),
      designation: Type.Union([Type.String(), Type.Null()]),
      tradeCategory: Type.Union([Type.String(), Type.Null()]),
      joiningDate: Type.Union([Type.String(), Type.Null()]),
      contactPhone: Type.Union([Type.String(), Type.Null()]),
      contactEmail: Type.Union([Type.String(), Type.Null()]),
      emergencyContactName: Type.Union([Type.String(), Type.Null()]),
      emergencyContactPhone: Type.Union([Type.String(), Type.Null()]),
      status: Type.String(),
    }),
    Type.Null(),
  ]),
  company: Type.Union([
    Type.Object({
      id: Type.String({ format: 'uuid' }),
      code: Type.String(),
      name: Type.String(),
      isPlatform: Type.Boolean(),
    }),
    Type.Null(),
  ]),
  primaryRole: Type.Union([Type.String(), Type.Null()]),
  roles: Type.Array(Type.String()),
  permissions: Type.Array(Type.String()),
  departments: Type.Array(
    Type.Object({
      departmentId: Type.String({ format: 'uuid' }),
      departmentCode: Type.String(),
      departmentName: Type.String(),
      category: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      isPrimary: Type.Boolean(),
      headOfficeId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
      headOfficeName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
  ),
  assignments: Type.Array(
    Type.Object({
      id: Type.String({ format: 'uuid' }),
      roleKey: Type.String(),
      roleName: Type.String(),
      scopeType: Type.String(),
      headOfficeId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
      headOfficeName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      projectId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
      projectName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      siteId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
      siteName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      effectiveFrom: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      effectiveTo: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
  ),
  attendance: Type.Object({
    hasActiveSession: Type.Boolean(),
    activeSession: Type.Union([
      Type.Object({
        id: Type.String({ format: 'uuid' }),
        siteId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
        siteCode: Type.Union([Type.String(), Type.Null()]),
        siteName: Type.Union([Type.String(), Type.Null()]),
        headOfficeId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
        headOfficeName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        businessDate: Type.String(),
        punchInAt: Type.String(),
        source: Type.String(),
        punchInWithinGeofence: Type.Boolean(),
        isFlagged: Type.Boolean(),
        flagReason: Type.Union([Type.String(), Type.Null()]),
        activeBreak: Type.Union([
          Type.Object({
            id: Type.String({ format: 'uuid' }),
            breakType: Type.String(),
            startedAt: Type.String(),
          }),
          Type.Null(),
        ]),
      }),
      Type.Null(),
    ]),
  }),
  leaveBalances: Type.Array(
    Type.Object({
      leaveType: Type.String(),
      year: Type.Integer(),
      allocatedDays: Type.Number(),
      usedDays: Type.Number(),
      pendingDays: Type.Number(),
      carriedOverDays: Type.Number(),
      availableDays: Type.Number(),
    }),
  ),
  documents: Type.Optional(Type.Array(UserDocumentItemSchema)),
});

export interface AuthRoutesOptions {
  service: AuthService;
  rateLimit: { max: number; timeWindow: number };
}

// Login keys rate limits by a privacy-preserving hash of IP + normalized
// identifier — raw identifiers never enter Redis keys or logs.
function loginRateLimitKey(loginId: string, ip: string): string {
  return createHash('sha256').update(`${ip}|${loginId.trim().toLowerCase()}`).digest('hex');
}

export default function authRoutes(opts: AuthRoutesOptions) {
  const { service, rateLimit } = opts;
  return async function routes(app: FastifyInstance) {
    app.post(
      '/auth/login',
      {
        schema: { body: LoginBody, response: { 200: LoginResponse } },
        config: {
          rateLimit: {
            max: rateLimit.max,
            timeWindow: rateLimit.timeWindow,
            keyGenerator: (req) =>
              loginRateLimitKey(
                (req.body as { loginId?: string } | undefined)?.loginId ?? '',
                req.ip,
              ),
          },
        },
      },
      async (request) =>
        service.login(request.body as { loginId: string; password: string }, {
          ip: request.ip,
          userAgent: request.headers['user-agent'],
          correlationId: request.correlationId,
        }),
    );

    app.post(
      '/auth/mfa/verify',
      {
        schema: { body: MfaVerifyBody, response: { 200: TokenResponse } },
        config: {
          rateLimit: {
            max: rateLimit.max,
            timeWindow: rateLimit.timeWindow,
            keyGenerator: (req) => req.ip,
          },
        },
      },
      async (request) => {
        const body = request.body as { mfaToken: string; code: string };
        return service.completeMfaLogin(body.mfaToken, body.code, {
          ip: request.ip,
          userAgent: request.headers['user-agent'],
          correlationId: request.correlationId,
        });
      },
    );

    app.post(
      '/auth/mfa/send-otp',
      {
        schema: { body: MfaSendOtpBody, response: { 200: MfaChallengeResponse } },
        config: {
          rateLimit: {
            max: 5,
            timeWindow: 60_000,
            keyGenerator: (req) => req.ip,
          },
        },
      },
      async (request) => {
        const body = request.body as { mfaToken: string };
        if (!service.mfaService) {
          throw new AppError(400, 'MFA_NOT_CONFIGURED', 'MFA service not configured');
        }
        return service.mfaService.resendOtp(body.mfaToken);
      },
    );

    app.get(
      '/auth/mfa/status',
      {
        schema: { response: { 200: MfaStatusResponse } },
        preHandler: [app.authenticate],
      },
      async (request) => {
        if (!request.principal) {
          throw new UnauthorizedError();
        }
        if (!service.mfaService) {
          return { mfaEnabled: false, mfaType: null };
        }
        return service.mfaService.getStatus(request.principal.actorId);
      },
    );

    app.post(
      '/auth/mfa/setup',
      {
        schema: { response: { 200: MfaChallengeResponse } },
        preHandler: [app.authenticate],
      },
      async (request) => {
        if (!request.principal) {
          throw new UnauthorizedError();
        }
        return service.requestMfaSetup(request.principal.actorId);
      },
    );

    app.post(
      '/auth/mfa/enable',
      {
        schema: { body: MfaEnableBody, response: { 200: MfaToggleResponse } },
        preHandler: [app.authenticate],
      },
      async (request) => {
        if (!request.principal) {
          throw new UnauthorizedError();
        }
        if (!service.mfaService) {
          throw new AppError(400, 'MFA_NOT_CONFIGURED', 'MFA service not configured');
        }
        const body = request.body as { mfaToken?: string; code?: string } | undefined;
        if (body?.mfaToken && body.code) {
          return service.confirmMfaSetup(request.principal.actorId, body.mfaToken, body.code);
        }
        await service.mfaService.enableMfa(request.principal.actorId, 'EMAIL_OTP');
        return {
          success: true,
          mfaEnabled: true,
          mfaType: 'EMAIL_OTP',
          message: 'Two-factor authentication enabled successfully',
        };
      },
    );

    app.post(
      '/auth/mfa/disable',
      {
        schema: { response: { 200: MfaToggleResponse } },
        preHandler: [app.authenticate],
      },
      async (request) => {
        if (!request.principal) {
          throw new UnauthorizedError();
        }
        if (!service.mfaService) {
          throw new AppError(400, 'MFA_NOT_CONFIGURED', 'MFA service not configured');
        }
        await service.mfaService.disableMfa(request.principal.actorId);
        return { success: true, mfaEnabled: false, message: 'Two-factor authentication disabled' };
      },
    );

    app.post(
      '/auth/change-password',
      {
        schema: { body: ChangePasswordBody, response: { 200: ChangePasswordResponse } },
        preHandler: [app.authenticate],
      },
      async (request) => {
        if (!request.principal) {
          throw new UnauthorizedError();
        }
        return service.changePassword(
          request.principal.actorId,
          request.body as { currentPassword: string; newPassword: string },
          { correlationId: request.correlationId },
        );
      },
    );

    app.post(
      '/auth/refresh',
      {
        schema: { body: RefreshBody, response: { 200: TokenResponse } },
        config: {
          rateLimit: {
            max: rateLimit.max,
            timeWindow: rateLimit.timeWindow,
            keyGenerator: (req) => req.ip,
          },
        },
      },
      async (request) =>
        service.refresh(request.body as { refreshToken: string }, {
          ip: request.ip,
          correlationId: request.correlationId,
        }),
    );

    app.post(
      '/auth/logout',
      {
        schema: { response: { 200: EmptyResponse } },
        preHandler: [app.authenticate],
      },
      async (request) => {
        if (!request.principal) {
          throw new UnauthorizedError();
        }
        await service.logout(request.principal);
        return {};
      },
    );

    app.get(
      '/auth/me',
      {
        schema: { response: { 200: UserMeResponseSchema } },
        preHandler: [app.authenticate],
      },
      async (request) => {
        if (!request.principal) {
          throw new UnauthorizedError();
        }
        const companyId = request.headers['x-company-id'] as string | undefined;
        return service.getMe(request.principal.actorId, companyId);
      },
    );

    app.get(
      '/profile',
      {
        schema: { response: { 200: UserAggregatedProfileResponseSchema } },
        preHandler: [app.authenticate],
      },
      async (request) => {
        if (!request.principal) {
          throw new UnauthorizedError();
        }
        const companyId = request.headers['x-company-id'] as string | undefined;
        return service.getProfile(request.principal.actorId, companyId);
      },
    );
  };
}

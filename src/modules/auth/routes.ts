import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { UnauthorizedError } from '../../common/errors/app-error.js';
import type { AuthService } from './service.js';

const LoginBody = Type.Object({
  loginId: Type.String({ minLength: 1, maxLength: 320 }),
  password: Type.String({ minLength: 1, maxLength: 512 }),
});

const RefreshBody = Type.Object({
  refreshToken: Type.String({ minLength: 1, maxLength: 512 }),
});

const UserProfile = Type.Object({
  id: Type.String({ format: 'uuid' }),
  loginId: Type.String(),
  displayName: Type.Optional(Type.String()),
  employeeCode: Type.Optional(Type.String()),
  companyId: Type.Optional(Type.String({ format: 'uuid' })),
  companyCode: Type.Optional(Type.String()),
  companyName: Type.Optional(Type.String()),
  isPlatform: Type.Optional(Type.Boolean()),
  role: Type.Optional(Type.String()),
  roles: Type.Array(Type.String()),
});

const TokenResponse = Type.Object({
  accessToken: Type.String(),
  refreshToken: Type.String(),
  tokenType: Type.Literal('Bearer'),
  expiresIn: Type.Number(),
  role: Type.Optional(Type.String()),
  roles: Type.Optional(Type.Array(Type.String())),
  user: Type.Optional(UserProfile),
});

const EmptyResponse = Type.Object({});

const UserMeResponseSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  loginId: Type.String(),
  loginIdType: Type.String(),
  status: Type.String(),
  displayName: Type.String(),
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
    }),
  ),
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
        schema: { body: LoginBody, response: { 200: TokenResponse } },
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
  };
}

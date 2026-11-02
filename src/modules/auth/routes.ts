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

const TokenResponse = Type.Object({
  accessToken: Type.String(),
  refreshToken: Type.String(),
  tokenType: Type.Literal('Bearer'),
  expiresIn: Type.Number(),
});

const EmptyResponse = Type.Object({});

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
  };
}

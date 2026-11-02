import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { UnauthorizedError } from '../common/errors/app-error.js';
import { createTokenService, type TokenService } from '../modules/auth/tokens.js';
import type { ActorContext } from '../modules/organization/types.js';

export interface PrincipalContext extends ActorContext {
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    tokenService: TokenService;
    authenticate: (request: FastifyRequest) => Promise<void>;
  }
  interface FastifyRequest {
    principal: PrincipalContext | null;
  }
}

export interface AuthenticationPluginOptions {
  // Resolves verified claims into a live principal context. Injectable so
  // tests can supply a boundary double.
  buildActorContext: (
    claims: { sub: string; sid: string },
    meta: { correlationId?: string },
  ) => Promise<PrincipalContext>;
}

export default fp<AuthenticationPluginOptions>(
  async function authenticationPlugin(app: FastifyInstance, opts) {
    const cfg = app.config;

    await app.register(fastifyJwt, {
      secret: cfg.JWT_SECRET,
      sign: { iss: cfg.JWT_ISSUER, aud: cfg.JWT_AUDIENCE },
      verify: { allowedIss: cfg.JWT_ISSUER, allowedAud: cfg.JWT_AUDIENCE },
    });

    const tokenService = createTokenService(
      {
        sign: (payload, options) => app.jwt.sign(payload, options),
        verify: (token: string, options?: Record<string, unknown>) =>
          app.jwt.verify<Record<string, unknown>>(token, options as never),
      },
      {
        issuer: cfg.JWT_ISSUER,
        audience: cfg.JWT_AUDIENCE,
        accessTokenTtlS: cfg.ACCESS_TOKEN_TTL_S,
      },
    );
    app.decorate('tokenService', tokenService);
    app.decorateRequest('principal', null);

    app.decorate('authenticate', async (request: FastifyRequest) => {
      const header = request.headers.authorization;
      if (!header?.startsWith('Bearer ')) {
        throw new UnauthorizedError('TOKEN_MISSING', 'Bearer token required');
      }
      let claims;
      try {
        claims = tokenService.verifyAccessToken(header.slice('Bearer '.length));
      } catch {
        throw new UnauthorizedError('TOKEN_INVALID', 'Invalid or expired token');
      }
      // Live session + principal status check — revoked/suspended principals
      // are denied immediately, even with an otherwise-valid token.
      request.principal = await opts.buildActorContext(
        { sub: claims.sub, sid: claims.sid },
        { correlationId: request.correlationId },
      );
    });
  },
  { name: 'authentication', dependencies: ['config'] },
);

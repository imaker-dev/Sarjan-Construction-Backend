import { createHash, randomBytes } from 'node:crypto';

// Minimal sign/verify facade — satisfied by fastify.jwt (@fastify/jwt) in
// production and by a directly-constructed verifier in tests.
export interface JwtFacade {
  sign(payload: Record<string, unknown>, options?: Record<string, unknown>): string;
  verify(token: string, options?: Record<string, unknown>): Record<string, unknown>;
}

export interface AccessTokenClaims {
  sub: string; // Principal id
  sid: string; // AuthSession id
  type: 'access';
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

export interface TokenConfig {
  issuer: string;
  audience: string;
  accessTokenTtlS: number;
}

export function createTokenService(jwt: JwtFacade, cfg: TokenConfig) {
  return {
    signAccessToken(principalId: string, sessionId: string): string {
      // Minimum claims only — permissions/scopes are intentionally NOT
      // embedded; they are evaluated live so revocation takes effect
      // immediately. exp is set explicitly (epoch seconds) to avoid
      // library-specific expiresIn unit ambiguity.
      const now = Math.floor(Date.now() / 1000);
      return jwt.sign(
        {
          sub: principalId,
          sid: sessionId,
          type: 'access',
          iss: cfg.issuer,
          aud: cfg.audience,
          iat: now,
          exp: now + cfg.accessTokenTtlS,
        },
        { algorithm: 'HS256' }, // pinned — no algorithm negotiation
      );
    },

    verifyAccessToken(token: string): AccessTokenClaims {
      // fast-jwt option names: allowedIss/allowedAud/algorithms.
      const claims = jwt.verify(token, {
        algorithms: ['HS256'], // allowlist — rejects 'none' and unexpected algs
        allowedIss: cfg.issuer,
        allowedAud: cfg.audience,
      });
      if (
        claims.type !== 'access' ||
        typeof claims.sub !== 'string' ||
        typeof claims.sid !== 'string'
      ) {
        throw new Error('not an access token');
      }
      return claims as unknown as AccessTokenClaims;
    },
  };
}

export type TokenService = ReturnType<typeof createTokenService>;

// Opaque high-entropy refresh token — raw value goes to the client only.
export function generateRefreshToken(): string {
  return randomBytes(48).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

import { describe, it, expect, beforeAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import {
  createTokenService,
  generateRefreshToken,
  hashRefreshToken,
  type TokenService,
} from '../../../src/modules/auth/tokens.js';

const SECRET = 'test-secret-test-secret-test-secret-12345';
const CFG = { issuer: 'sarjan-erp', audience: 'sarjan-erp-api', accessTokenTtlS: 900 };

let jwt: FastifyInstance['jwt'];
let tokens: TokenService;

beforeAll(async () => {
  const app = Fastify();
  await app.register(fastifyJwt, { secret: SECRET });
  jwt = app.jwt;
  tokens = createTokenService(
    {
      sign: (p, o) => app.jwt.sign(p, o),
      verify: (t: string, o?: Record<string, unknown>) =>
        app.jwt.verify<Record<string, unknown>>(t, o as never),
    },
    CFG,
  );
});

describe('access tokens', () => {
  it('signs and verifies a token with minimum claims', () => {
    const token = tokens.signAccessToken('principal-1', 'session-1');
    const claims = tokens.verifyAccessToken(token);
    expect(claims.sub).toBe('principal-1');
    expect(claims.sid).toBe('session-1');
    expect(claims.type).toBe('access');
    expect(claims.iss).toBe('sarjan-erp');
    expect(claims.aud).toBe('sarjan-erp-api');
    expect(claims.exp - claims.iat).toBe(900);
    // No permissions/roles embedded.
    expect(JSON.stringify(claims)).not.toContain('permission');
  });

  it('rejects a tampered signature', () => {
    const token = tokens.signAccessToken('p', 's');
    const parts = token.split('.');
    // Flip a middle char of the signature — the last base64url char can encode
    // only padding bits, so flipping it wouldn't always change the bytes.
    const sig = parts[2] ?? '';
    const mid = Math.floor(sig.length / 2);
    const flipped = sig[mid] === 'A' ? 'B' : 'A';
    parts[2] = sig.slice(0, mid) + flipped + sig.slice(mid + 1);
    expect(() => tokens.verifyAccessToken(parts.join('.'))).toThrow();
  });

  it('rejects an expired token', () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const expired = jwt.sign(
      {
        sub: 'p',
        sid: 's',
        type: 'access',
        iss: CFG.issuer,
        aud: CFG.audience,
        iat: past,
        exp: past + 10,
      },
      { algorithm: 'HS256' },
    );
    expect(() => tokens.verifyAccessToken(expired)).toThrow();
  });

  it('rejects wrong issuer/audience and non-access token type', () => {
    const now = Math.floor(Date.now() / 1000);
    const badIss = jwt.sign(
      {
        sub: 'p',
        sid: 's',
        type: 'access',
        iss: 'other',
        aud: CFG.audience,
        iat: now,
        exp: now + 900,
      },
      { algorithm: 'HS256' },
    );
    expect(() => tokens.verifyAccessToken(badIss)).toThrow();

    const wrongType = jwt.sign(
      {
        sub: 'p',
        sid: 's',
        type: 'refresh',
        iss: CFG.issuer,
        aud: CFG.audience,
        iat: now,
        exp: now + 900,
      },
      { algorithm: 'HS256' },
    );
    expect(() => tokens.verifyAccessToken(wrongType)).toThrow();
  });

  it('rejects an alg=none token', () => {
    const payload = Buffer.from(
      JSON.stringify({ sub: 'p', sid: 's', type: 'access', iss: CFG.issuer, aud: CFG.audience }),
    ).toString('base64url');
    const noneToken = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${payload}.`;
    expect(() => tokens.verifyAccessToken(noneToken)).toThrow();
  });
});

describe('refresh tokens', () => {
  it('generates high-entropy opaque tokens and stable hashes', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(60);
    expect(hashRefreshToken(a)).toBe(hashRefreshToken(a));
    expect(hashRefreshToken(a)).not.toBe(hashRefreshToken(b));
  });
});

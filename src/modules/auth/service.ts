import { randomUUID } from 'node:crypto';
import { UnauthorizedError } from '../../common/errors/app-error.js';
import { passwordService } from '../identity/password.js';
import { generateRefreshToken, hashRefreshToken, type TokenService } from './tokens.js';
import type { AuthUnitOfWork } from './repository.js';
import type { ActorContext } from '../organization/types.js';

export interface AuthConfig {
  accessTokenTtlS: number;
  refreshTokenTtlS: number;
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

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
  ) {}

  /**
   * Authenticate a human principal. Returns generic INVALID_CREDENTIALS for
   * every failure mode — never reveals whether the account exists, is
   * suspended, or is a non-human principal.
   */
  async login(
    input: { loginId: string; password: string },
    meta: RequestMeta,
  ): Promise<AuthResult> {
    const loginId = normalizeLoginId(input.loginId);

    const principal = await this.uow.run(({ principals }) => principals.findByLoginId(loginId));

    // Always verify a password-shaped value to keep timing uniform —
    // unknown accounts verify against a dummy hash.
    const passwordOk = await passwordService.verify(principal?.passwordHash, input.password);
    const humanAllowed = principal?.type === 'USER'; // SERVICE/SYSTEM can't log in
    const active = principal?.status === 'ACTIVE';
    if (!principal || !passwordOk || !humanAllowed || !active) {
      throw INVALID();
    }

    return this.uow.run(async ({ sessions, refreshTokens, audit }) => {
      const familyId = randomUUID();
      const refreshTtlMs = this.cfg.refreshTokenTtlS * 1000;
      const session = await sessions.create({
        principalId: principal.id,
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
      await audit.record({
        eventKey: randomUUID(),
        action: 'AUTH_LOGIN_SUCCEEDED',
        entityType: 'PRINCIPAL',
        entityId: principal.id,
        actorId: principal.id,
        actorType: 'USER',
        ...(meta.correlationId !== undefined ? { correlationId: meta.correlationId } : {}),
        statusAfter: 'ACTIVE',
      });
      return this.issueTokens(principal, session.id, refreshToken);
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

  private issueTokens(
    principal: { id: string },
    sessionId: string,
    refreshToken: string,
  ): AuthResult {
    return {
      accessToken: this.tokens.signAccessToken(principal.id, sessionId),
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.cfg.accessTokenTtlS, // access-token lifetime, not refresh
    };
  }
}

export function normalizeLoginId(raw: string): string {
  return raw.trim().toLowerCase();
}

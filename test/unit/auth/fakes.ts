import type { AuthSession, Principal, RefreshToken } from '@prisma/client';
import type { AuthRepos, AuthUnitOfWork } from '../../../src/modules/auth/repository.js';
import type { AuditRecord } from '../../../src/modules/organization/types.js';

export interface AuthStore {
  principals: Principal[];
  employees: {
    id: string;
    principalId: string;
    companyId: string;
    displayName: string;
    employeeCode: string;
    company: { id: string; code: string; name: string; isPlatform: boolean };
  }[];
  sessions: AuthSession[];
  refreshTokens: RefreshToken[];
  auditLog: AuditRecord[];
}

export function emptyAuthStore(): AuthStore {
  return { principals: [],
    employees: [], sessions: [], refreshTokens: [], auditLog: [] };
}

let nextId = 0;
const genId = () => `id-${++nextId}`;

export function fakePrincipal(over: Partial<Principal> = {}): Principal {
  return {
    id: genId(),
    loginId: 'user@example.com',
    loginIdType: 'EMAIL',
    passwordHash: null,
    type: 'USER',
    status: 'ACTIVE',
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

export function makeAuthRepos(store: AuthStore): AuthRepos {
  return {
    principals: {
      findByLoginId: async (loginId) => store.principals.find((p) => p.loginId === loginId) ?? null,
      findWithDetailsByLoginId: async (loginId) => {
        const found = store.principals.find((p) => p.loginId === loginId);
        if (!found) return null;
        return {
          ...found,
          employees: store.employees.filter((e) => e.principalId === found.id),
          roleAssignments: [],
        };
      },
      findById: async (id) => store.principals.find((p) => p.id === id) ?? null,
      findFullProfile: async (id) => {
        const found = store.principals.find((p) => p.id === id);
        if (!found) return null;
        return {
          ...found,
          employees: [],
          roleAssignments: [],
        };
      },
    },
    sessions: {
      create: async (data) => {
        const s: AuthSession = {
          id: genId(),
          status: 'ACTIVE',
          createdAt: new Date(),
          lastUsedAt: null,
          ip: null,
          userAgent: null,
          ...data,
        };
        store.sessions.push(s);
        return s;
      },
      findById: async (id) => store.sessions.find((s) => s.id === id) ?? null,
      revoke: async (id) => {
        for (const s of store.sessions) if (s.id === id) s.status = 'REVOKED';
      },
      revokeFamily: async (familyId) => {
        for (const s of store.sessions) if (s.familyId === familyId) s.status = 'REVOKED';
      },
    },
    refreshTokens: {
      create: async (data) => {
        const t: RefreshToken = {
          id: genId(),
          issuedAt: new Date(),
          consumedAt: null,
          revokedAt: null,
          replacedById: null,
          ...data,
        };
        store.refreshTokens.push(t);
        return t;
      },
      findByHash: async (tokenHash) =>
        store.refreshTokens.find((t) => t.tokenHash === tokenHash) ?? null,
      consume: async (id, replacedById) => {
        const t = store.refreshTokens.find((r) => r.id === id);
        if (t === undefined) return 0;
        if (t.consumedAt !== null || t.revokedAt !== null) return 0;
        t.consumedAt = new Date();
        t.replacedById = replacedById ?? null;
        return 1;
      },
      revokeBySession: async (sessionId) => {
        for (const t of store.refreshTokens) {
          if (t.sessionId === sessionId && t.consumedAt === null) t.revokedAt = new Date();
        }
      },
    },
    audit: {
      record: async (entry) => {
        store.auditLog.push(entry);
      },
    },
  };
}

export class FakeAuthUoW implements AuthUnitOfWork {
  constructor(public readonly store: AuthStore) { }

  async run<T>(fn: (repos: AuthRepos) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.store);
    try {
      return await fn(makeAuthRepos(this.store));
    } catch (error) {
      Object.assign(this.store, structuredClone(snapshot));
      throw error;
    }
  }
}

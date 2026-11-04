import type { Redis } from 'ioredis';

export interface UserProfileResponse {
  id: string;
  loginId: string;
  loginIdType: string;
  status: string;
  displayName: string;
  employeeCode: string | null;
  designation: string | null;
  tradeCategory: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  joiningDate: string | null;
  company: {
    id: string;
    code: string;
    name: string;
    isPlatform: boolean;
  } | null;
  role: string | null;
  roles: string[];
  permissions: string[];
  assignments: {
    id: string;
    roleKey: string;
    roleName: string;
    scopeType: string;
    headOfficeId?: string | null;
    headOfficeName?: string | null;
    projectId?: string | null;
    projectName?: string | null;
    siteId?: string | null;
    siteName?: string | null;
    effectiveFrom?: string | null;
    effectiveTo?: string | null;
  }[];
  departments: {
    departmentId: string;
    departmentCode: string;
    departmentName: string;
    category?: string | null;
    isPrimary: boolean;
  }[];
}

export interface UserProfileCache {
  get(principalId: string, companyId?: string): Promise<UserProfileResponse | null>;
  set(principalId: string, data: UserProfileResponse, companyId?: string): Promise<void>;
  invalidate(principalId: string): Promise<void>;
}

export class InMemoryUserProfileCache implements UserProfileCache {
  private readonly store = new Map<string, { data: UserProfileResponse; expiresAt: number }>();
  private readonly gen = new Map<string, number>();

  constructor(private readonly ttlSeconds = 900) {}

  async get(principalId: string, companyId?: string): Promise<UserProfileResponse | null> {
    const g = this.gen.get(principalId) ?? 0;
    const key = `${principalId}:${g}:${companyId ?? 'default'}`;
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.data;
  }

  async set(principalId: string, data: UserProfileResponse, companyId?: string): Promise<void> {
    const g = this.gen.get(principalId) ?? 0;
    const key = `${principalId}:${g}:${companyId ?? 'default'}`;
    this.store.set(key, { data, expiresAt: Date.now() + this.ttlSeconds * 1000 });
  }

  async invalidate(principalId: string): Promise<void> {
    const g = this.gen.get(principalId) ?? 0;
    this.gen.set(principalId, g + 1);
  }
}

export class RedisUserProfileCache implements UserProfileCache {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds = 900,
  ) {}

  async get(principalId: string, companyId?: string): Promise<UserProfileResponse | null> {
    try {
      const gen = (await this.redis.get(`auth:me:gen:${principalId}`)) ?? '0';
      const raw = await this.redis.get(
        `auth:me:data:${principalId}:${gen}:${companyId ?? 'default'}`,
      );
      if (!raw) return null;
      return JSON.parse(raw) as UserProfileResponse;
    } catch {
      return null;
    }
  }

  async set(
    principalId: string,
    data: UserProfileResponse,
    companyId?: string,
  ): Promise<void> {
    try {
      const gen = (await this.redis.get(`auth:me:gen:${principalId}`)) ?? '0';
      const key = `auth:me:data:${principalId}:${gen}:${companyId ?? 'default'}`;
      await this.redis.set(key, JSON.stringify(data), 'EX', this.ttlSeconds);
    } catch {
      // Fail-safe
    }
  }

  async invalidate(principalId: string): Promise<void> {
    try {
      await this.redis.incr(`auth:me:gen:${principalId}`);
    } catch {
      // Fail-safe
    }
  }
}


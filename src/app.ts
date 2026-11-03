import Fastify, { type FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import rateLimit from '@fastify/rate-limit';
import configPlugin from './plugins/config.js';
import requestContextPlugin from './plugins/request-context.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import prismaPlugin from './plugins/prisma.js';
import redisPlugin from './plugins/redis.js';
import authenticationPlugin from './plugins/authentication.js';
import authorizationPlugin from './plugins/authorization.js';
import healthRoutes from './modules/health/routes.js';
import authRoutes from './modules/auth/routes.js';
import websocketPlugin from '@fastify/websocket';
import { PrismaNotificationUnitOfWork } from './modules/notification/repository.js';
import { NotificationService } from './modules/notification/service.js';
import { NotificationWorker } from './modules/notification/worker.js';
import { NotificationGateway } from './modules/notification/ws-gateway.js';
import {
  RedisNotificationPublisher,
  RedisTicketStore,
} from './modules/notification/redis-adapters.js';
import { notificationRoutes } from './modules/notification/routes.js';
import notificationWorkerPlugin from './plugins/notification-worker.js';
import { OrganizationService } from './modules/organization/service.js';
import { DepartmentService } from './modules/department/service.js';
import { organizationRoutes } from './modules/organization/routes.js';
import { departmentRoutes } from './modules/department/routes.js';
import { PrismaOrgUnitOfWork } from './modules/organization/repository.js';
import { PrismaDepartmentUnitOfWork } from './modules/department/repository.js';
import { PrismaEmployeeUnitOfWork } from './modules/employee/repository.js';
import { EmployeeService } from './modules/employee/service.js';
import { employeeRoutes } from './modules/employee/routes.js';
import { EmployeeAccessService } from './modules/employee/access.js';
import { PlatformService } from './modules/platform/service.js';
import { platformRoutes } from './modules/platform/routes.js';
import { PrismaPlatformUnitOfWork } from './modules/platform/repository.js';
import type { ScopeTarget } from './modules/access-control/service.js';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { ComplianceService } from './modules/compliance/service.js';
import { complianceRoutes } from './modules/compliance/routes.js';
import { AuthService } from './modules/auth/service.js';
import { makeAuthRepos, PrismaAuthUnitOfWork } from './modules/auth/repository.js';
import { AccessControlService } from './modules/access-control/service.js';
import { makeAccessRepository } from './modules/access-control/repository.js';
import type { PrincipalContext } from './plugins/authentication.js';

// Per-operation documentation — keyed "METHOD /path" (api prefix stripped).
// Summaries/descriptions document real behavior; permission is appended to
// the description so the doc stays truthful without a parallel contract.
const OPERATION_DOCS: Record<
  string,
  { summary: string; description?: string; permission?: string }
> = {
  'GET /health': { summary: 'Liveness probe (unauthenticated)' },
  'GET /ready': { summary: 'Readiness probe (unauthenticated)' },
  'POST /auth/login': {
    summary: 'Password login — issues access + refresh tokens',
    description: 'Unauthenticated; rate-limited per loginId+IP.',
  },
  'POST /auth/refresh': { summary: 'Rotate refresh token' },
  'POST /auth/logout': { summary: 'Invalidate the current session', permission: 'authenticated' },
  'POST /auth/claim': {
    summary: 'Consume a one-time claim code and set password',
  },
  'GET /auth/claim/verify': {
    summary: 'Verify claim code validity and return company info',
    description: 'Unauthenticated; rate-limited.',
  },
  'POST /auth/claim/onboard': {
    summary: 'Onboard Company',
    description:
      'Unauthenticated; rate-limited. Sets password, updates company, and creates HeadOffice.',
  },
  'GET /org/company': { summary: 'Read own company profile', permission: 'ORG_COMPANY_READ' },
  'PATCH /org/company': {
    summary: 'Update company profile (optimistic version)',
    permission: 'ORG_COMPANY_UPDATE',
  },
  'POST /org/company/status': {
    summary: 'Transition company status',
    permission: 'ORG_COMPANY_STATUS',
  },
  'GET /org/head-offices': {
    summary: 'List head offices (cursor-paginated)',
    description: 'Deterministic cursor pagination on (createdAt,id); pass `cursor`.',
    permission: 'ORG_HEAD_OFFICE_READ',
  },
  'POST /org/head-offices': { summary: 'Create head office', permission: 'ORG_HEAD_OFFICE_CREATE' },
  'PATCH /org/head-offices/:id': {
    summary: 'Update head office',
    permission: 'ORG_HEAD_OFFICE_UPDATE',
  },
  'POST /org/head-offices/:id/status': {
    summary: 'Transition head office status',
    permission: 'ORG_HEAD_OFFICE_STATUS',
  },
  'GET /org/projects': {
    summary: 'List projects (cursor-paginated)',
    permission: 'ORG_PROJECT_READ',
  },
  'POST /org/projects': { summary: 'Create project', permission: 'ORG_PROJECT_CREATE' },
  'PATCH /org/projects/:id': { summary: 'Update project', permission: 'ORG_PROJECT_UPDATE' },
  'POST /org/projects/:id/status': {
    summary: 'Transition project status',
    permission: 'ORG_PROJECT_STATUS',
  },
  'GET /org/sites': { summary: 'List sites (cursor-paginated)', permission: 'ORG_SITE_READ' },
  'POST /org/sites': { summary: 'Create site', permission: 'ORG_SITE_CREATE' },
  'PATCH /org/sites/:id': { summary: 'Update site', permission: 'ORG_SITE_UPDATE' },
  'POST /org/sites/:id/status': {
    summary: 'Transition site status',
    permission: 'ORG_SITE_STATUS',
  },
  'GET /departments': { summary: 'List departments', permission: 'DEPARTMENT_READ' },
  'POST /departments': { summary: 'Create department', permission: 'DEPARTMENT_CONFIGURE' },
  'PATCH /departments/:id': { summary: 'Update department', permission: 'DEPARTMENT_CONFIGURE' },
  'POST /departments/:id/status': {
    summary: 'Transition department status',
    permission: 'DEPARTMENT_CONFIGURE',
  },
  'GET /employees': {
    summary: 'List employees (cursor-paginated)',
    permission: 'EMPLOYEE_READ',
  },
  'POST /employees': { summary: 'Create employee profile', permission: 'EMPLOYEE_MANAGE' },
  'PATCH /employees/:id': { summary: 'Update employee profile', permission: 'EMPLOYEE_MANAGE' },
  'POST /employees/:id/status': {
    summary: 'Activate/deactivate employee (atomic offboarding)',
    permission: 'EMPLOYEE_MANAGE',
  },
  'POST /employees/:id/invite': {
    summary: 'Invite profile-only employee — creates suspended account + one-time claim code',
    description:
      'Code returned once, never logged/stored raw; the employee claims via /auth/claim.',
    permission: 'EMPLOYEE_INVITE',
  },
  'POST /employees/:id/invite/resend': {
    summary: 'Reissue employee claim code (invalidates prior)',
    permission: 'EMPLOYEE_INVITE',
  },
  'GET /employees/:id/assignments': {
    summary: 'List active role assignments of an employee',
    permission: 'ROLE_ASSIGNMENT_READ',
  },
  'POST /employees/:id/assignments': {
    summary:
      'Grant a whitelisted tenant role (COMPANY_OWNER@COMPANY, HO_ADMIN@HEAD_OFFICE primary)',
    permission: 'ACCESS_ROLE_ASSIGN',
  },
  'DELETE /employees/:id/assignments/:assignmentId': {
    summary: 'Revoke a role assignment',
    permission: 'ACCESS_ROLE_REVOKE',
  },
  'GET /compliance-records': {
    summary: 'List company compliance records',
    permission: 'COMPLIANCE_READ',
  },
  'POST /compliance-records': {
    summary: 'Create compliance record (GST/TAN/licence/cert/insurance)',
    permission: 'COMPLIANCE_MANAGE',
  },
  'PATCH /compliance-records/:id': {
    summary: 'Update compliance record',
    permission: 'COMPLIANCE_MANAGE',
  },
  'POST /compliance-records/:id/status': {
    summary: 'Transition compliance record status',
    permission: 'COMPLIANCE_MANAGE',
  },
  'POST /compliance-records/:id/verify': {
    summary: 'Verify record (optional document attach)',
    permission: 'COMPLIANCE_MANAGE',
  },
  'GET /notifications': {
    summary: 'List own notifications (cursor-paginated)',
    permission: 'authenticated',
  },
  'POST /notifications/:id/read': {
    summary: 'Mark notification read',
    permission: 'authenticated',
  },
  'GET /notifications/ticket': {
    summary: 'Issue single-use WebSocket ticket',
    permission: 'authenticated',
  },
  'POST /platform/companies': {
    summary: 'Create customer company + first Company Admin (returns one-time claim code)',
    permission: 'PLATFORM_COMPANY_CREATE',
  },
  'GET /platform/companies': {
    summary: 'List customer companies',
    permission: 'PLATFORM_COMPANY_READ',
  },
  'POST /platform/companies/:companyId/claim-token': {
    summary: 'Reissue admin claim code (invalidates prior codes)',
    permission: 'PLATFORM_COMPANY_CREATE',
  },
};

export interface BuildAppOptions {
  env?: NodeJS.ProcessEnv;
  // Test hooks: substitute service boundaries without touching Prisma/Redis.
  services?: {
    authService?: AuthService;
    accessControl?: AccessControlService;
    notificationService?: NotificationService;
    employeeService?: EmployeeService;
    employeeAccessService?: EmployeeAccessService;
    complianceService?: ComplianceService;
    platformService?: PlatformService;
    // Test hook: inject the sentinel platform-company id (null = none).
    platformCompanyId?: string | null;
  };
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const logLevel = opts.env?.LOG_LEVEL ?? process.env.LOG_LEVEL ?? 'info';
  const nodeEnv = opts.env?.NODE_ENV ?? process.env.NODE_ENV ?? 'development';

  const app = Fastify({
    logger: {
      level: logLevel,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-api-key"]',
          'res.headers["set-cookie"]',
          'body.password',
          'body.refreshToken',
        ],
        censor: '[Redacted]',
      },
    },
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
    bodyLimit: 1_048_576,
    requestTimeout: 30_000,
  }).withTypeProvider<TypeBoxTypeProvider>();

  // Infrastructure plugins in explicit dependency order.
  await app.register(configPlugin, { ...(opts.env !== undefined ? { env: opts.env } : {}) });
  await app.register(requestContextPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);

  // Rate limiting: Redis store in production (fails closed on outage — the
  // dedicated client connects eagerly and queues nothing offline, so a dead
  // Redis surfaces as an error, never a silent per-process fallback). The
  // in-memory store is acceptable for dev/test only.
  const rateLimitRedis = nodeEnv === 'production' ? app.redis.duplicate() : undefined;
  if (rateLimitRedis !== undefined) {
    rateLimitRedis.on('error', (err: unknown) => {
      app.log.error({ err }, 'rate-limit redis error');
    });
    // Connect during boot so requests always hit a ready client — a dead
    // Redis fails the app start outright rather than degrading to silent
    // per-process limits.
    app.addHook('onReady', async () => {
      await rateLimitRedis.connect();
    });
    app.addHook('onClose', async () => {
      rateLimitRedis.disconnect();
    });
  }
  await app.register(rateLimit, {
    global: false,
    ...(rateLimitRedis !== undefined ? { redis: rateLimitRedis } : {}),
  });

  // OpenAPI generation from the same TypeBox schemas used for validation —
  // single source of truth, no drifting contract. Swagger UI is a developer
  // tool: disabled in production unless SWAGGER_UI=true; /openapi.json is
  // always available (no secrets in generated examples).
  // OpenAPI generation from the same TypeBox schemas used for validation.
  // Exposure policy: documentation is a development tool — BOTH Swagger UI
  // (/docs) and the JSON spec are unavailable in production builds. No safe
  // verified access control exists for them yet, so production exposure is
  // impossible by construction (not merely disabled).
  const docsEnabled = nodeEnv !== 'production';
  if (docsEnabled) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'Sarjan Construction ERP API',
          description:
            'Tenant-scoped Construction ERP API. Authentication: Authorization: Bearer <JWT> ({sub,sid}). Tenant routes additionally require the x-company-id header; platform routes and /auth/claim do not.\n\nWebSocket (separate from HTTP ops): GET /api/v1/notifications/stream upgrades to a WebSocket — not an HTTP JSON endpoint. Native clients send Authorization: Bearer <JWT>; browsers pass a single-use ticket (from POST /api/v1/notifications/ticket) in Sec-WebSocket-Protocol. Frames deliver notification payloads for the authenticated principal in its company scope.',
          version: '0.1.0',
        },
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          },
        },
        security: [{ bearerAuth: [] }],
        tags: [
          { name: 'auth', description: 'Unauthenticated — no company context' },
          {
            name: 'org',
            description: 'Tenant-scoped — requires Authorization + x-company-id',
          },
          { name: 'department' },
          { name: 'employee' },
          { name: 'compliance' },
          { name: 'notification' },
          {
            name: 'platform',
            description: 'Platform operator only — x-company-id is ignored/rejected',
          },
          { name: 'health', description: 'Unauthenticated liveness' },
        ],
      },
      transform: (args) => {
        // Per-operation metadata derived from the route's real registration —
        // public routes get security:[], tenant routes get x-company-id,
        // platform routes get bearerAuth only (never x-company-id).
        const { schema, url } = args;
        // Schema-less routes (GETs) still get security/summary metadata.
        const s = ((schema as Record<string, unknown> | undefined) ?? {}) as Record<
          string,
          unknown
        > & {
          summary?: string;
          description?: string;
          tags?: string[];
          security?: unknown[];
          headers?: Record<string, unknown>;
        };
        const rawMethod =
          (Array.isArray(args.route.method) ? args.route.method[0] : args.route.method) ?? '';
        // Fastify auto-registers HEAD for every GET — classify it with the GET.
        const method = rawMethod === 'HEAD' ? 'GET' : rawMethod;
        const path = url.replace(/^\/api\/v1/, '');
        const methodPath = `${method} ${path}`;
        const op = OPERATION_DOCS[methodPath];
        // The WebSocket route is NOT an HTTP JSON API — documented separately.
        const isWebSocket = methodPath === 'GET /notifications/stream';
        const PUBLIC = new Set([
          'GET /health',
          'GET /ready',
          'POST /auth/login',
          'POST /auth/refresh',
          'POST /auth/claim',
          'GET /auth/claim/verify',
          'POST /auth/claim/onboard',
        ]);
        const TENANT_TAGS: [string, string][] = [
          ['/org/', 'org'],
          ['/departments', 'department'],
          ['/employees', 'employee'],
          ['/compliance-records', 'compliance'],
          ['/notifications', 'notification'],
        ];
        if (PUBLIC.has(methodPath)) {
          s.security = []; // explicitly unauthenticated
        } else {
          s.security = [{ bearerAuth: [] }]; // protected — per-op, not inherited
        }
        if (path.startsWith('/platform/')) {
          s.security = [{ bearerAuth: [] }];
          s.tags = ['platform'];
        } else {
          const tenant = TENANT_TAGS.find(([p]) => path.startsWith(p));
          if (tenant !== undefined) {
            s.tags = [tenant[1]];
            s.headers = {
              type: 'object',
              required: ['x-company-id'],
              properties: {
                'x-company-id': {
                  type: 'string',
                  format: 'uuid',
                  description: 'Active tenant company (must match caller role assignments)',
                },
              },
            };
          }
        }
        if (isWebSocket) {
          // Documented contract: the handshake IS this GET — the client then
          // upgrades. Auth: Authorization header (native) OR single-use ticket
          // in Sec-WebSocket-Protocol (browser); message frames carry
          // notification payloads for the authenticated principal only.
          s.summary = 'Notification realtime stream (WebSocket upgrade)';
          s.description =
            'WebSocket upgrade endpoint — not an HTTP JSON API. Native clients send Authorization: Bearer; browsers pass a single-use ticket from POST /api/v1/notifications/ticket via Sec-WebSocket-Protocol. Frames deliver company-scoped notifications.';
        }
        s.summary = op?.summary ?? s.summary ?? methodPath;
        if (op?.description !== undefined) s.description = op.description;
        if (op?.permission !== undefined) {
          s.description = `${s.description ?? ''} (required permission: ${op.permission})`.trim();
        }
        // Deterministic unique operationId: lowerCamel(method + path); HEAD
        // keeps its own name so getX/headX never collide.
        s.operationId =
          rawMethod.toLowerCase() +
          path
            .replace(/[:/{}-]+/g, ' ')
            .trim()
            .split(' ')
            .filter(Boolean)
            .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
            .join('');
        const isPublic = PUBLIC.has(methodPath);
        const isWrite = rawMethod === 'POST' || rawMethod === 'PATCH';
        const hasPathParam = path.includes(':');
        // Response catalog matches the real error-handler shape
        // { error: { code, message, requestId } } — success schema left to the
        // route's own validator where present.
        const err = (desc: string) => ({
          description: desc,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  error: {
                    type: 'object',
                    properties: {
                      code: { type: 'string' },
                      message: { type: 'string' },
                      requestId: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        });
        if (s.responses === undefined) {
          s.responses = {
            200: { description: 'Success' },
            ...(isWrite ? { 400: err('Validation error (malformed body)') } : {}),
            ...(isPublic
              ? { 429: err('Rate limited') }
              : {
                  401: err('Missing/invalid Bearer token'),
                  403: err('Permission denied or platform/tenant boundary violation'),
                }),
            ...(hasPathParam ? { 404: err('Entity not found in company scope') } : {}),
            ...(isWrite
              ? {
                  409: err('Conflict (duplicate or stale version)'),
                  422: err('Domain validation error'),
                }
              : {}),
            500: err('Unexpected server error'),
          };
        }
        return { schema: s as unknown as typeof schema, url };
      },
    });
    if (app.config.SWAGGER_UI) {
      await app.register(swaggerUi, { routePrefix: '/docs', staticCSP: true });
    }
    app.get('/documentation/json', { schema: { hide: true } }, async () => app.swagger());
  }

  // Constructed lazily so tests can inject service doubles that never touch
  // PostgreSQL.
  const services = opts.services ?? {};
  let authService = services.authService;
  let accessControl = services.accessControl;
  let notificationService = services.notificationService;

  await app.register(authenticationPlugin, {
    buildActorContext: (claims, meta): Promise<PrincipalContext> => {
      if (!authService) throw new Error('auth service not initialized');
      return authService.buildActorContext(claims, meta);
    },
  });

  authService ??= new AuthService(new PrismaAuthUnitOfWork(app.prisma), app.tokenService, {
    accessTokenTtlS: app.config.ACCESS_TOKEN_TTL_S,
    refreshTokenTtlS: app.config.REFRESH_TOKEN_TTL_S,
  });
  accessControl ??= new AccessControlService({
    principals: makeAuthRepos(app.prisma).principals,
    access: makeAccessRepository(app.prisma),
  });

  const platformResolver = async (): Promise<string | null> => {
    if (services.platformCompanyId !== undefined) return services.platformCompanyId;
    const row = await app.prisma.company.findFirst({ where: { isPlatform: true } });
    return row?.id ?? null;
  };
  await app.register(authorizationPlugin, {
    accessControl,
    resolvePlatformCompanyId: platformResolver,
  });

  // Notifications: durable inbox + ticket + realtime stream. The service is
  // lazy-injectable for tests; the WS gateway subscribes lazily per principal.
  notificationService ??= new NotificationService({
    uow: new PrismaNotificationUnitOfWork(app.prisma),
    ticketStore: new RedisTicketStore(app.redis),
    publisher: new RedisNotificationPublisher(app.redis),
    signTicket: (claims) => app.jwt.sign(claims, { expiresIn: '30s' }),
    buildActorContext: (claims, meta) => authService.buildActorContext(claims, meta),
  });
  const notificationGateway = new NotificationGateway({
    subscriber: app.redis.duplicate(),
    revalidate: (sub, sid) => notificationService.revalidate(sub, sid),
  });
  app.addHook('onClose', async () => {
    await notificationGateway.closeAll();
  });

  await app.register(websocketPlugin);
  await app.register(
    notificationRoutes({
      service: notificationService,
      gateway: notificationGateway,
      verifyToken: (token) =>
        app.tokenService.verifyAccessToken(token) as unknown as Record<string, unknown>,
    }),
    { prefix: '/api/v1' },
  );
  // Relay worker — production lifecycle only ('auto'); never in unit tests.
  await app.register(notificationWorkerPlugin, {
    // BullMQ Worker requires maxRetriesPerRequest: null — dedicated client
    // separate from the rate-limit and publisher connections.
    worker: new NotificationWorker(
      notificationService,
      app.redis.duplicate({ maxRetriesPerRequest: null }),
      (msg, meta) => {
        app.log.info(meta ?? {}, msg);
      },
    ),
  });

  // Domain route plugins, versioned.
  await app.register(
    organizationRoutes(new OrganizationService(new PrismaOrgUnitOfWork(app.prisma))),
    {
      prefix: '/api/v1',
    },
  );
  await app.register(
    departmentRoutes(
      new DepartmentService(new PrismaDepartmentUnitOfWork(app.prisma), {
        assertPermission: (pid: string, key: string, target: ScopeTarget) =>
          accessControl.assertPermission(pid, key, target),
      }),
    ),
    { prefix: '/api/v1' },
  );
  await app.register(
    employeeRoutes(
      services.employeeService ??
        new EmployeeService(new PrismaEmployeeUnitOfWork(app.prisma), {
          assertPermission: (pid: string, key: string, target: ScopeTarget) =>
            accessControl.assertPermission(pid, key, target),
        }),
      services.employeeAccessService ?? new EmployeeAccessService(app.prisma),
    ),
    { prefix: '/api/v1' },
  );
  await app.register(
    complianceRoutes(services.complianceService ?? new ComplianceService(app.prisma)),
    { prefix: '/api/v1' },
  );
  await app.register(
    platformRoutes(
      services.platformService ??
        new PlatformService(new PrismaPlatformUnitOfWork(app.prisma), app.config.APP_BASE_URL),
      platformResolver,
    ),
    { prefix: '/api/v1' },
  );
  await app.register(healthRoutes, { prefix: '/api/v1' });
  await app.register(
    authRoutes({
      service: authService,
      rateLimit: {
        max: app.config.AUTH_RATE_LIMIT_MAX,
        timeWindow: app.config.AUTH_RATE_LIMIT_WINDOW_MS,
      },
    }),
    { prefix: '/api/v1' },
  );

  return app;
}

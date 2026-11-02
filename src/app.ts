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
import type { ScopeTarget } from './modules/access-control/service.js';
import { AuthService } from './modules/auth/service.js';
import { makeAuthRepos, PrismaAuthUnitOfWork } from './modules/auth/repository.js';
import { AccessControlService } from './modules/access-control/service.js';
import { makeAccessRepository } from './modules/access-control/repository.js';
import type { PrincipalContext } from './plugins/authentication.js';

export interface BuildAppOptions {
  env?: NodeJS.ProcessEnv;
  // Test hooks: substitute service boundaries without touching Prisma/Redis.
  services?: {
    authService?: AuthService;
    accessControl?: AccessControlService;
    notificationService?: NotificationService;
    employeeService?: EmployeeService;
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

  // Rate limiting: Redis store in production (fails closed on outage); the
  // in-memory store is acceptable for dev/test only.
  await app.register(rateLimit, {
    global: false,
    ...(nodeEnv === 'production' ? { redis: app.redis } : {}),
  });

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

  await app.register(authorizationPlugin, { accessControl });

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
    worker: new NotificationWorker(notificationService, app.redis.duplicate(), (msg, meta) => {
      app.log.info(meta ?? {}, msg);
    }),
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

import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import type { AccessControlService } from '../../src/modules/access-control/service.js';
import { AccessDeniedError } from '../../src/modules/access-control/errors.js';
import type { AuthService } from '../../src/modules/auth/service.js';
import type { ApprovalService } from '../../src/modules/approval/service.js';
import type { PrincipalContext } from '../../src/plugins/authentication.js';

const env = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '0',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/testdb',
  REDIS_HOST: 'localhost',
  REDIS_PORT: '6379',
  JWT_SECRET: 'test-secret-test-secret-test-secret-1234',
};

const CID = '00000000-0000-4000-8000-0000000000c1';
const TASK_ID = '00000000-0000-4000-8000-0000000000a1';

let app: FastifyInstance | undefined;
afterAll(async () => {
  if (app !== undefined) await app.close();
});

function fakeTask(over: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    companyId: CID,
    workflowInstanceId: '00000000-0000-4000-8000-0000000000b1',
    stageKey: 'finance_review',
    fromState: 'SUBMITTED',
    assigneeType: 'ROLE_KEY',
    assigneeValue: 'FINANCE_MANAGER',
    selfApprove: false,
    status: 'PENDING',
    decidedByPrincipalId: null,
    decidedAt: null,
    decisionAction: null,
    decisionReason: null,
    version: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

async function makeApp(opts: { allow?: boolean } = {}) {
  const calls: { decide: unknown[]; list: unknown[] } = { decide: [], list: [] };
  const mockApprovalService = {
    listAssignedTasks: async (_a: unknown, _c: string, f: unknown, p: unknown) => {
      calls.list.push([f, p]);
      return { items: [fakeTask()], nextCursor: undefined };
    },
    getAssignedTask: async (_a: unknown, _c: string, id: string) => fakeTask({ id }),
    listAssignedTaskDecisions: async (_a: unknown, _c: string, taskId: string) => [
      { id: 'd1', approvalTaskId: taskId, outcome: 'APPROVED', action: 'APPROVE' },
    ],
    decideTask: async (_a: unknown, _c: string, taskId: string, input: unknown) => {
      calls.decide.push([taskId, input]);
      return {
        task: fakeTask({ status: 'APPROVED' }),
        decision: { id: 'd1', outcome: 'APPROVED' },
        instance: { id: 'i1', state: 'APPROVED' },
        transition: { id: 't1', toState: 'APPROVED' },
        replayed: false,
      };
    },
  } as unknown as ApprovalService;

  const mockAuthService = {
    buildActorContext: async () =>
      ({
        actorId: 'fin1',
        actorType: 'USER',
        sessionId: 's1',
      }) as unknown as PrincipalContext,
    verifyAccessToken: async () => ({ sub: 'fin1', sid: 's1' }),
  } as unknown as AuthService;

  const mockAccessControl = {
    assertPermission: async () => {
      if (opts.allow === false) throw new AccessDeniedError();
    },
    hasPermission: async () => true,
  } as unknown as AccessControlService;

  const instance = await buildApp({
    env,
    services: {
      authService: mockAuthService,
      accessControl: mockAccessControl,
      approvalService: mockApprovalService,
      platformCompanyId: null,
    },
  });
  return { app: instance, calls };
}

function tokenFor(a: FastifyInstance, sub = 'fin1') {
  return a.tokenService.signAccessToken(sub, 's1');
}

describe('Approval-task routes (/api/v1/approval-tasks)', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const { app: a } = await makeApp();
    app = a;
    const res = await a.inject({ method: 'GET', url: '/api/v1/approval-tasks' });
    expect(res.statusCode).toBe(401);
  });

  it('requires x-company-id', async () => {
    const { app: a } = await makeApp();
    app = a;
    const res = await a.inject({
      method: 'GET',
      url: '/api/v1/approval-tasks',
      headers: { authorization: `Bearer ${tokenFor(a)}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('403s without WORKFLOW_APPROVAL_READ', async () => {
    const { app: a } = await makeApp({ allow: false });
    app = a;
    const res = await a.inject({
      method: 'GET',
      url: '/api/v1/approval-tasks',
      headers: { authorization: `Bearer ${tokenFor(a)}`, 'x-company-id': CID },
    });
    expect(res.statusCode).toBe(403);
  });

  it('lists caller-assigned tasks with filters and pagination params', async () => {
    const { app: a, calls } = await makeApp();
    app = a;
    const res = await a.inject({
      method: 'GET',
      url: '/api/v1/approval-tasks?status=PENDING&limit=10&cursor=00000000-0000-4000-8000-0000000000ff',
      headers: { authorization: `Bearer ${tokenFor(a)}`, 'x-company-id': CID },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: { id: string; assigneeValue: string }[] }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.assigneeValue).toBe('FINANCE_MANAGER');
    expect(calls.list[0]).toEqual([
      { status: 'PENDING' },
      { limit: 10, cursor: '00000000-0000-4000-8000-0000000000ff' },
    ]);
  });

  it('rejects invalid status filter values', async () => {
    const { app: a } = await makeApp();
    app = a;
    const res = await a.inject({
      method: 'GET',
      url: '/api/v1/approval-tasks?status=BOGUS',
      headers: { authorization: `Bearer ${tokenFor(a)}`, 'x-company-id': CID },
    });
    expect(res.statusCode).toBe(400);
  });

  it('gets a single task and its decisions', async () => {
    const { app: a } = await makeApp();
    app = a;
    const task = await a.inject({
      method: 'GET',
      url: `/api/v1/approval-tasks/${TASK_ID}`,
      headers: { authorization: `Bearer ${tokenFor(a)}`, 'x-company-id': CID },
    });
    expect(task.statusCode).toBe(200);
    const decisions = await a.inject({
      method: 'GET',
      url: `/api/v1/approval-tasks/${TASK_ID}/decisions`,
      headers: { authorization: `Bearer ${tokenFor(a)}`, 'x-company-id': CID },
    });
    expect(decisions.statusCode).toBe(200);
    expect(decisions.json<unknown[]>().length).toBe(1);
  });

  it('decides a task — delegates to the service with the full input', async () => {
    const { app: a, calls } = await makeApp();
    app = a;
    const res = await a.inject({
      method: 'POST',
      url: `/api/v1/approval-tasks/${TASK_ID}/decisions`,
      headers: { authorization: `Bearer ${tokenFor(a)}`, 'x-company-id': CID },
      payload: {
        action: 'APPROVE',
        expectedVersion: 3,
        idempotencyKey: 'fin-decide-1',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(calls.decide[0]).toEqual([
      TASK_ID,
      { action: 'APPROVE', expectedVersion: 3, idempotencyKey: 'fin-decide-1' },
    ]);
    const body = res.json<{ replayed: boolean }>();
    expect(body.replayed).toBe(false);
  });

  it('rejects a decision without DECIDE permission and bad actions', async () => {
    const { app: a } = await makeApp({ allow: false });
    app = a;
    const denied = await a.inject({
      method: 'POST',
      url: `/api/v1/approval-tasks/${TASK_ID}/decisions`,
      headers: { authorization: `Bearer ${tokenFor(a)}`, 'x-company-id': CID },
      payload: { action: 'APPROVE' },
    });
    expect(denied.statusCode).toBe(403);

    const { app: a2 } = await makeApp();
    app = a2;
    const bad = await a2.inject({
      method: 'POST',
      url: `/api/v1/approval-tasks/${TASK_ID}/decisions`,
      headers: { authorization: `Bearer ${tokenFor(a2)}`, 'x-company-id': CID },
      payload: { action: 'MAYBE' },
    });
    expect(bad.statusCode).toBe(400);
  });
});

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { UnauthorizedError } from '../../common/errors/app-error.js';
import type { ScopeTarget } from '../access-control/service.js';
import type { ActorContext } from '../organization/types.js';
import {
  FINANCE_BUDGET_MANAGE,
  FINANCE_BUDGET_READ,
  FINANCE_DASHBOARD_READ,
  FINANCE_EMPLOYEE_READ,
  FINANCE_PORTFOLIO_READ,
  type FinanceService,
} from './service.js';
import {
  BudgetLineInput,
  CurrencyCode,
  ForecastLineInput,
  type BudgetListFilter,
  type CreateBudgetInput,
  type CreateBudgetRevisionInput,
  type CreateForecastInput,
  type DecideBudgetRevisionInput,
  type EmployeeListFilter,
  type ForecastListFilter,
  type PortfolioProjectFilter,
  type ReviseForecastInput,
  type SiteListFilter,
  type UpdateBudgetInput,
} from './types.js';

const actorOf = (r: FastifyRequest): ActorContext => ({
  actorId: (r.principal as { actorId: string }).actorId,
  actorType: 'USER',
});

const companyIdOf = (r: FastifyRequest): string => {
  const c = r.headers['x-company-id'];
  if (typeof c !== 'string' || c.length === 0) {
    throw new UnauthorizedError('COMPANY_REQUIRED', 'x-company-id header required');
  }
  return c;
};

const atCompany = (r: FastifyRequest): ScopeTarget => {
  const companyId = companyIdOf(r);
  return { companyId, scopeType: 'COMPANY', scopeId: companyId };
};

const atProject = (r: FastifyRequest): ScopeTarget => {
  const companyId = companyIdOf(r);
  const { projectId } = r.params as { projectId: string };
  return { companyId, scopeType: 'PROJECT', scopeId: projectId };
};

const ProjectParams = Type.Object({ projectId: Type.String({ format: 'uuid' }) });
const EmployeeParams = Type.Object({ employeeId: Type.String({ format: 'uuid' }) });
const BudgetParams = Type.Object({ id: Type.String({ format: 'uuid' }) });
const RevisionParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
  revisionId: Type.String({ format: 'uuid' }),
});
const ForecastParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

const ListQuery = Type.Object({
  status: Type.Optional(Type.Union([Type.Literal('ACTIVE'), Type.Literal('ARCHIVED')])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(Type.String({ format: 'uuid' })),
});

const RevisionListQuery = Type.Object({
  status: Type.Optional(
    Type.Union([
      Type.Literal('DRAFT'),
      Type.Literal('SUBMITTED'),
      Type.Literal('APPROVED'),
      Type.Literal('REJECTED'),
      Type.Literal('RETURNED'),
    ]),
  ),
});

const PageParams = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(Type.String({ format: 'uuid' })),
};

const PortfolioQuery = Type.Object({
  status: Type.Optional(
    Type.Union(
      (['PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED'] as const).map((s) =>
        Type.Literal(s),
      ),
    ),
  ),
  search: Type.Optional(Type.String({ maxLength: 120 })),
  ...PageParams,
});

const SiteListQuery = Type.Object({
  status: Type.Optional(Type.Union([Type.Literal('ACTIVE'), Type.Literal('ARCHIVED')])),
  ...PageParams,
});

const EmployeeListQuery = Type.Object({
  projectId: Type.Optional(Type.String({ format: 'uuid' })),
  siteId: Type.Optional(Type.String({ format: 'uuid' })),
  departmentId: Type.Optional(Type.String({ format: 'uuid' })),
  status: Type.Optional(
    Type.Union([Type.Literal('ACTIVE'), Type.Literal('INACTIVE'), Type.Literal('ARCHIVED')]),
  ),
  search: Type.Optional(Type.String({ maxLength: 120 })),
  ...PageParams,
});

const AttendanceSummaryQuery = Type.Object({
  from: Type.String({ format: 'date' }),
  to: Type.String({ format: 'date' }),
});

const LeaveSummaryQuery = Type.Object({
  year: Type.Integer({ minimum: 2000, maximum: 2100 }),
});

const CreateBudgetBody = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 64 }),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.Optional(Type.String({ maxLength: 2000 })),
    currency: CurrencyCode,
    idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);

const UpdateBudgetBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    description: Type.Optional(Type.Union([Type.String({ maxLength: 2000 }), Type.Null()])),
    currency: Type.Optional(CurrencyCode),
    expectedVersion: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const CreateRevisionBody = Type.Object(
  {
    notes: Type.Optional(Type.String({ maxLength: 2000 })),
    lines: Type.Array(BudgetLineInput, { minItems: 1, maxItems: 200 }),
    idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);

const SubmitRevisionBody = Type.Object(
  {
    expectedVersion: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

const DecideRevisionBody = Type.Object(
  {
    action: Type.Union([Type.Literal('APPROVE'), Type.Literal('REJECT'), Type.Literal('RETURN')]),
    reason: Type.Optional(Type.String({ maxLength: 500 })),
    expectedVersion: Type.Optional(Type.Integer({ minimum: 0 })),
    idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);

const CreateForecastBody = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.Optional(Type.String({ maxLength: 2000 })),
    currency: CurrencyCode,
    periodStart: Type.String({ format: 'date' }),
    periodEnd: Type.String({ format: 'date' }),
    lines: Type.Array(ForecastLineInput, { minItems: 1, maxItems: 200 }),
    idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);

const ReviseForecastBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    description: Type.Optional(Type.Union([Type.String({ maxLength: 2000 }), Type.Null()])),
    currency: Type.Optional(CurrencyCode),
    periodStart: Type.Optional(Type.String({ format: 'date' })),
    periodEnd: Type.Optional(Type.String({ format: 'date' })),
    lines: Type.Optional(Type.Array(ForecastLineInput, { minItems: 1, maxItems: 200 })),
    reason: Type.Optional(Type.String({ maxLength: 500 })),
    expectedVersion: Type.Integer({ minimum: 0 }),
    idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);

/**
 * Finance — project budgets and cash-flow forecasts. Every query and
 * mutation is company-scoped and evaluated at the target project's scope;
 * commands additionally require the caller's assigned business operation
 * (PROJECT_BUDGET_* / PROJECT_CASH_FLOW_*), so a Finance API permission
 * alone never performs the work.
 */
export function financeRoutes(service: FinanceService) {
  return async function routes(app: FastifyInstance) {
    const read = (key: string, target: typeof atCompany | typeof atProject) => ({
      preHandler: [app.authenticate, app.tenantCompanyGuard, app.requirePermission(key, target)],
    });
    const atProjectRead = (key: string) => read(key, atProject);
    const atCompanyRead = (key: string) => read(key, atCompany);

    // ------------------------------------------------------------- budgets

    app.post(
      '/finance/projects/:projectId/budgets',
      {
        schema: { params: ProjectParams, body: CreateBudgetBody },
        ...atProjectRead(FINANCE_BUDGET_MANAGE),
      },
      async (req, reply) => {
        const { projectId } = req.params as { projectId: string };
        const result = await service.createBudget(
          actorOf(req),
          companyIdOf(req),
          projectId,
          req.body as CreateBudgetInput,
        );
        return reply.code(result.replayed ? 200 : 201).send(result);
      },
    );

    app.get(
      '/finance/projects/:projectId/budgets',
      {
        schema: { params: ProjectParams, querystring: ListQuery },
        ...atProjectRead(FINANCE_BUDGET_READ),
      },
      async (req) => {
        const { projectId } = req.params as { projectId: string };
        const q = req.query as { status?: 'ACTIVE' | 'ARCHIVED'; limit?: number; cursor?: string };
        const filter: BudgetListFilter = {
          limit: q.limit ?? 50,
          ...(q.status !== undefined ? { status: q.status } : {}),
          ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
        };
        return service.listBudgets(actorOf(req), companyIdOf(req), projectId, filter);
      },
    );

    app.get(
      '/finance/budgets/:id',
      { schema: { params: BudgetParams }, ...atCompanyRead(FINANCE_BUDGET_READ) },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.getBudget(actorOf(req), companyIdOf(req), id);
      },
    );

    app.patch(
      '/finance/budgets/:id',
      {
        schema: { params: BudgetParams, body: UpdateBudgetBody },
        ...atCompanyRead(FINANCE_BUDGET_MANAGE),
      },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.updateBudget(
          actorOf(req),
          companyIdOf(req),
          id,
          req.body as UpdateBudgetInput,
        );
      },
    );

    // ----------------------------------------------------------- revisions

    app.post(
      '/finance/budgets/:id/revisions',
      {
        schema: { params: BudgetParams, body: CreateRevisionBody },
        ...atCompanyRead(FINANCE_BUDGET_MANAGE),
      },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        const result = await service.createRevision(
          actorOf(req),
          companyIdOf(req),
          id,
          req.body as CreateBudgetRevisionInput,
        );
        return reply.code(result.replayed ? 200 : 201).send(result);
      },
    );

    app.get(
      '/finance/budgets/:id/revisions',
      {
        schema: { params: BudgetParams, querystring: RevisionListQuery },
        ...atCompanyRead(FINANCE_BUDGET_READ),
      },
      async (req) => {
        const { id } = req.params as { id: string };
        const q = req.query as { status?: string };
        return service.listRevisions(actorOf(req), companyIdOf(req), id, q.status);
      },
    );

    app.get(
      '/finance/budgets/:id/revisions/:revisionId',
      { schema: { params: RevisionParams }, ...atCompanyRead(FINANCE_BUDGET_READ) },
      async (req) => {
        const { id, revisionId } = req.params as { id: string; revisionId: string };
        return service.getRevision(actorOf(req), companyIdOf(req), id, revisionId);
      },
    );

    app.post(
      '/finance/budgets/:id/revisions/:revisionId/submit',
      {
        schema: { params: RevisionParams, body: SubmitRevisionBody },
        ...atCompanyRead(FINANCE_BUDGET_MANAGE),
      },
      async (req) => {
        const { id, revisionId } = req.params as { id: string; revisionId: string };
        const body = req.body as { expectedVersion?: number };
        return service.submitRevision(
          actorOf(req),
          companyIdOf(req),
          id,
          revisionId,
          body.expectedVersion,
        );
      },
    );

    app.post(
      '/finance/budgets/:id/revisions/:revisionId/decisions',
      {
        schema: { params: RevisionParams, body: DecideRevisionBody },
        ...atCompanyRead(FINANCE_BUDGET_MANAGE),
      },
      async (req, reply) => {
        const { id, revisionId } = req.params as { id: string; revisionId: string };
        const result = await service.decideRevision(
          actorOf(req),
          companyIdOf(req),
          id,
          revisionId,
          req.body as DecideBudgetRevisionInput,
        );
        return reply.code(result.replayed ? 200 : 201).send(result);
      },
    );

    app.get(
      '/finance/budgets/:id/revisions/:revisionId/decisions',
      { schema: { params: RevisionParams }, ...atCompanyRead(FINANCE_BUDGET_READ) },
      async (req) => {
        const { id, revisionId } = req.params as { id: string; revisionId: string };
        return service.listDecisions(actorOf(req), companyIdOf(req), id, revisionId);
      },
    );

    // ---------------------------------------------------------------- costs

    app.get(
      '/finance/projects/:projectId/costs',
      {
        schema: { params: ProjectParams },
        ...atProjectRead(FINANCE_BUDGET_READ),
      },
      async (req) => {
        const { projectId } = req.params as { projectId: string };
        return service.getProjectCosts(actorOf(req), companyIdOf(req), projectId);
      },
    );

    // -------------------------------------------------------------- forecasts

    app.post(
      '/finance/projects/:projectId/cash-flow-forecasts',
      {
        schema: { params: ProjectParams, body: CreateForecastBody },
        ...atProjectRead(FINANCE_BUDGET_MANAGE),
      },
      async (req, reply) => {
        const { projectId } = req.params as { projectId: string };
        const result = await service.createForecast(
          actorOf(req),
          companyIdOf(req),
          projectId,
          req.body as CreateForecastInput,
        );
        return reply.code(result.replayed ? 200 : 201).send(result);
      },
    );

    app.get(
      '/finance/projects/:projectId/cash-flow-forecasts',
      {
        schema: { params: ProjectParams, querystring: ListQuery },
        ...atProjectRead(FINANCE_BUDGET_READ),
      },
      async (req) => {
        const { projectId } = req.params as { projectId: string };
        const q = req.query as { status?: 'ACTIVE' | 'ARCHIVED'; limit?: number; cursor?: string };
        const filter: ForecastListFilter = {
          limit: q.limit ?? 50,
          ...(q.status !== undefined ? { status: q.status } : {}),
          ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
        };
        return service.listForecasts(actorOf(req), companyIdOf(req), projectId, filter);
      },
    );

    app.get(
      '/finance/cash-flow-forecasts/:id',
      { schema: { params: ForecastParams }, ...atCompanyRead(FINANCE_BUDGET_READ) },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.getForecast(actorOf(req), companyIdOf(req), id);
      },
    );

    app.patch(
      '/finance/cash-flow-forecasts/:id',
      {
        schema: { params: ForecastParams, body: ReviseForecastBody },
        ...atCompanyRead(FINANCE_BUDGET_MANAGE),
      },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.reviseForecast(
          actorOf(req),
          companyIdOf(req),
          id,
          req.body as ReviseForecastInput,
        );
      },
    );

    // ------------------------------------------------------------- portfolio

    app.get(
      '/finance/projects',
      {
        schema: { querystring: PortfolioQuery },
        ...atCompanyRead(FINANCE_PORTFOLIO_READ),
      },
      async (req) => {
        const q = req.query as {
          status?: PortfolioProjectFilter['status'];
          search?: string;
          limit?: number;
          cursor?: string;
        };
        const filter: PortfolioProjectFilter = {
          limit: q.limit ?? 50,
          ...(q.status !== undefined ? { status: q.status } : {}),
          ...(q.search !== undefined ? { search: q.search } : {}),
          ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
        };
        return service.listProjects(actorOf(req), companyIdOf(req), filter);
      },
    );

    app.get(
      '/finance/projects/:projectId/sites',
      {
        schema: { params: ProjectParams, querystring: SiteListQuery },
        ...atProjectRead(FINANCE_PORTFOLIO_READ),
      },
      async (req) => {
        const { projectId } = req.params as { projectId: string };
        const q = req.query as { status?: 'ACTIVE' | 'ARCHIVED'; limit?: number; cursor?: string };
        const filter: SiteListFilter = {
          limit: q.limit ?? 50,
          ...(q.status !== undefined ? { status: q.status } : {}),
          ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
        };
        return service.listProjectSites(actorOf(req), companyIdOf(req), projectId, filter);
      },
    );

    // -------------------------------------------------------------- employees

    app.get(
      '/finance/employees',
      {
        schema: { querystring: EmployeeListQuery },
        ...atCompanyRead(FINANCE_EMPLOYEE_READ),
      },
      async (req) => {
        const q = req.query as {
          projectId?: string;
          siteId?: string;
          departmentId?: string;
          status?: EmployeeListFilter['status'];
          search?: string;
          limit?: number;
          cursor?: string;
        };
        const filter: EmployeeListFilter = {
          limit: q.limit ?? 50,
          ...(q.projectId !== undefined ? { projectId: q.projectId } : {}),
          ...(q.siteId !== undefined ? { siteId: q.siteId } : {}),
          ...(q.departmentId !== undefined ? { departmentId: q.departmentId } : {}),
          ...(q.status !== undefined ? { status: q.status } : {}),
          ...(q.search !== undefined ? { search: q.search } : {}),
          ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
        };
        return service.listEmployees(actorOf(req), companyIdOf(req), filter);
      },
    );

    app.get(
      '/finance/employees/:employeeId',
      {
        schema: { params: EmployeeParams },
        ...atCompanyRead(FINANCE_EMPLOYEE_READ),
      },
      async (req) => {
        const { employeeId } = req.params as { employeeId: string };
        return service.getEmployee(actorOf(req), companyIdOf(req), employeeId);
      },
    );

    app.get(
      '/finance/employees/:employeeId/attendance-summary',
      {
        schema: { params: EmployeeParams, querystring: AttendanceSummaryQuery },
        ...atCompanyRead(FINANCE_EMPLOYEE_READ),
      },
      async (req) => {
        const { employeeId } = req.params as { employeeId: string };
        const q = req.query as { from: string; to: string };
        return service.getAttendanceSummary(actorOf(req), companyIdOf(req), employeeId, {
          from: q.from,
          to: q.to,
        });
      },
    );

    app.get(
      '/finance/employees/:employeeId/leave-summary',
      {
        schema: { params: EmployeeParams, querystring: LeaveSummaryQuery },
        ...atCompanyRead(FINANCE_EMPLOYEE_READ),
      },
      async (req) => {
        const { employeeId } = req.params as { employeeId: string };
        const q = req.query as { year: number };
        return service.getLeaveSummary(actorOf(req), companyIdOf(req), employeeId, q.year);
      },
    );

    // -------------------------------------------------------------- dashboard

    app.get('/finance/dashboard', { ...atCompanyRead(FINANCE_DASHBOARD_READ) }, async (req) =>
      service.getDashboard(actorOf(req), companyIdOf(req)),
    );
  };
}

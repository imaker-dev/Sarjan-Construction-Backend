import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { ActorContext, AuditRecord } from '../organization/types.js';
import { AppError, ForbiddenError } from '../../common/errors/app-error.js';
import {
  OrgEntityNotFoundError,
  OrgValidationError,
  InvalidStatusTransitionError,
} from '../organization/errors.js';
import { normalizeCode } from '../organization/validation.js';
import { commandFingerprint } from '../workflow-instance/fingerprint.js';
import { IdempotencyConflictError } from '../workflow-instance/errors.js';
import type { Authorizer } from '../department/service.js';
import type { ScopeTarget } from '../access-control/service.js';
import type { FinanceRepos, FinanceUnitOfWork } from './repository.js';
import type {
  AttendanceSummaryRange,
  BudgetListFilter,
  CreateBudgetInput,
  CreateBudgetRevisionInput,
  CreateForecastInput,
  DecideBudgetRevisionInput,
  EmployeeListFilter,
  ForecastListFilter,
  PortfolioProjectFilter,
  ReviseForecastInput,
  SiteListFilter,
  UpdateBudgetInput,
} from './types.js';

export const FINANCE_BUDGET_READ = 'FINANCE_BUDGET_READ';
export const FINANCE_BUDGET_MANAGE = 'FINANCE_BUDGET_MANAGE';
export const FINANCE_PORTFOLIO_READ = 'FINANCE_PORTFOLIO_READ';
export const FINANCE_EMPLOYEE_READ = 'FINANCE_EMPLOYEE_READ';
export const FINANCE_EMPLOYEE_SENSITIVE_READ = 'FINANCE_EMPLOYEE_SENSITIVE_READ';
export const FINANCE_DASHBOARD_READ = 'FINANCE_DASHBOARD_READ';

// Business-operation layer — distinct from the API permissions above.
const OP_BUDGET_VIEW = 'PROJECT_BUDGET_VIEW';
const OP_BUDGET_CREATE = 'PROJECT_BUDGET_CREATE';
const OP_BUDGET_REVISE = 'PROJECT_BUDGET_REVISE';
const OP_BUDGET_APPROVE = 'PROJECT_BUDGET_APPROVE';
const OP_FORECAST_SUBMIT = 'PROJECT_CASH_FLOW_FORECAST_SUBMIT';
const OP_FORECAST_REVISE = 'PROJECT_CASH_FLOW_FORECAST_REVISE';
const OP_FORECAST_REVIEW = 'PROJECT_CASH_FLOW_REVIEW';
const OP_PROJECT_DASHBOARD_VIEW = 'PROJECT_DASHBOARD_VIEW';
const OP_EMPLOYEE_DIRECTORY_VIEW = 'FINANCE_EMPLOYEE_DIRECTORY_VIEW';
const OP_EMPLOYMENT_DETAILS_VIEW = 'FINANCE_EMPLOYMENT_DETAILS_VIEW';
const OP_PAYROLL_INPUT_REVIEW = 'PAYROLL_INPUT_REVIEW';

const CURRENCY_RE = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const projectTarget = (companyId: string, projectId: string): ScopeTarget => ({
  companyId,
  scopeType: 'PROJECT',
  scopeId: projectId,
});

const companyTarget = (companyId: string): ScopeTarget => ({
  companyId,
  scopeType: 'COMPANY',
  scopeId: companyId,
});

const pageOf = <T extends { id: string }>(rows: T[], limit: number) => {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    ...(rows.length > limit && last !== undefined ? { nextCursor: last.id } : {}),
  };
};

const byStatusOf = (counts: { status: string; count: number }[]) => {
  const out: Record<string, number> = {};
  let total = 0;
  for (const c of counts) {
    out[c.status] = c.count;
    total += c.count;
  }
  return { total, byStatus: out };
};

function auditEntry(
  actor: ActorContext,
  base: Omit<AuditRecord, 'eventKey' | 'actorId' | 'actorType' | 'correlationId'>,
): AuditRecord {
  return {
    eventKey: randomUUID(),
    actorId: actor.actorId,
    actorType: actor.actorType,
    ...(actor.correlationId !== undefined ? { correlationId: actor.correlationId } : {}),
    ...base,
  };
}

const toDate = (field: string, value: string): Date => {
  if (!DATE_RE.test(value)) throw new OrgValidationError(field, 'must be YYYY-MM-DD');
  return new Date(`${value}T00:00:00.000Z`);
};

function validateLines(
  lines: { amount: string }[] | undefined,
  field = 'lines',
): asserts lines is { amount: string }[] {
  if (lines === undefined || lines.length === 0) {
    throw new OrgValidationError(field, 'at least one line is required');
  }
}

/**
 * Dual authorization gate: the caller needs the FINANCE_* API permission
 * (route + service checks) AND, for employee actors, the operation
 * assignment from the department catalogue. COMPANY_OWNER retains
 * company-admin Finance access without an employee operation grant —
 * mirrors the placement exemption in AccessControlService.
 */
/** Permission checks for the finance surface — read probes AND assertions. */
export interface FinanceAuthorizer extends Authorizer {
  hasPermission(principalId: string, permissionKey: string, target: ScopeTarget): Promise<boolean>;
}

export class FinanceService {
  constructor(
    private readonly uow: FinanceUnitOfWork,
    private readonly authorizer: FinanceAuthorizer,
    private readonly resolveOperations: (
      companyId: string,
      employeeId: string,
    ) => Promise<string[]>,
  ) {}

  private async assertOperation(
    repos: FinanceRepos,
    actor: ActorContext,
    companyId: string,
    operationKey: string,
  ): Promise<void> {
    const employee = await repos.employees.findByPrincipal(companyId, actor.actorId);
    if (employee !== null) {
      const ops = await this.resolveOperations(companyId, employee.id);
      if (ops.includes(operationKey)) return;
    }
    const isOwner = await repos.access.hasRoleAssignment(
      companyId,
      actor.actorId,
      ['COMPANY_OWNER'],
      new Date(),
    );
    if (isOwner) return;
    throw new ForbiddenError(
      'OPERATION_NOT_ASSIGNED',
      `operation ${operationKey} is not assigned to the actor`,
    );
  }

  /** Boolean counterpart of assertOperation — same employee→ops / owner rule. */
  private async hasOperation(
    repos: FinanceRepos,
    actor: ActorContext,
    companyId: string,
    operationKey: string,
  ): Promise<boolean> {
    const employee = await repos.employees.findByPrincipal(companyId, actor.actorId);
    if (employee !== null) {
      const ops = await this.resolveOperations(companyId, employee.id);
      if (ops.includes(operationKey)) return true;
    }
    return repos.access.hasRoleAssignment(companyId, actor.actorId, ['COMPANY_OWNER'], new Date());
  }

  private async assertProject(
    repos: FinanceRepos,
    companyId: string,
    projectId: string,
  ): Promise<void> {
    const project = await repos.projects.findById(companyId, projectId);
    if (project === null) throw new OrgEntityNotFoundError('PROJECT');
  }

  private async budgetFor(
    repos: FinanceRepos,
    actor: ActorContext,
    companyId: string,
    budgetId: string,
    permissionKey: string,
  ) {
    const budget = await repos.budgets.findById(companyId, budgetId);
    if (budget === null) throw new OrgEntityNotFoundError('PROJECT_BUDGET');
    await this.authorizer.assertPermission(
      actor.actorId,
      permissionKey,
      projectTarget(companyId, budget.projectId),
    );
    return budget;
  }

  private async revisionFor(
    repos: FinanceRepos,
    companyId: string,
    budgetId: string,
    revisionId: string,
  ) {
    const revision = await repos.revisions.findById(companyId, budgetId, revisionId);
    if (revision === null) throw new OrgEntityNotFoundError('BUDGET_REVISION');
    return revision;
  }

  // ---------------------------------------------------------------- budgets

  async createBudget(
    actor: ActorContext,
    companyId: string,
    projectId: string,
    input: CreateBudgetInput,
  ) {
    await this.authorizer.assertPermission(
      actor.actorId,
      FINANCE_BUDGET_MANAGE,
      projectTarget(companyId, projectId),
    );
    const code = normalizeCode(input.code);
    const currency = input.currency.toUpperCase();
    if (!CURRENCY_RE.test(currency)) {
      throw new OrgValidationError('currency', 'must be a 3-letter ISO 4217 code');
    }
    const fingerprint =
      input.idempotencyKey !== undefined
        ? commandFingerprint({
            action: 'CREATE_BUDGET',
            projectId,
            code,
            name: input.name,
            ...(input.description !== undefined ? { description: input.description } : {}),
            currency,
          })
        : undefined;

    return this.uow.run(async (repos) => {
      await this.assertProject(repos, companyId, projectId);
      await this.assertOperation(repos, actor, companyId, OP_BUDGET_CREATE);

      if (input.idempotencyKey !== undefined) {
        const recorded = await repos.budgets.findByIdempotencyKey(
          companyId,
          projectId,
          input.idempotencyKey,
        );
        if (recorded !== null) {
          if (recorded.requestFingerprint !== fingerprint) {
            throw new IdempotencyConflictError(input.idempotencyKey);
          }
          return { budget: recorded, replayed: true };
        }
      }
      const budget = await repos.budgets.create(companyId, {
        projectId,
        code,
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        currency,
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(fingerprint !== undefined ? { requestFingerprint: fingerprint } : {}),
      });
      await repos.audit.record(
        auditEntry(actor, {
          action: 'FINANCE_BUDGET_CREATED',
          entityType: 'PROJECT_BUDGET',
          entityId: budget.id,
          companyId,
          statusAfter: 'ACTIVE',
          changedFields: {
            projectId: { before: null, after: projectId },
            code: { before: null, after: code },
            currency: { before: null, after: currency },
          },
        }),
      );
      await repos.outbox.record({
        companyId,
        eventType: 'FINANCE_BUDGET_CREATED',
        aggregateType: 'PROJECT_BUDGET',
        aggregateId: budget.id,
        eventKey: `evt:${budget.id}:FINANCE_BUDGET_CREATED`,
        recipientPrincipalIds: [],
        summary: { projectId, code, currency },
      });
      return { budget, replayed: false };
    });
  }

  async listBudgets(
    actor: ActorContext,
    companyId: string,
    projectId: string,
    filter: BudgetListFilter,
  ) {
    await this.authorizer.assertPermission(
      actor.actorId,
      FINANCE_BUDGET_READ,
      projectTarget(companyId, projectId),
    );
    return this.uow.run(async (repos) => {
      await this.assertProject(repos, companyId, projectId);
      await this.assertOperation(repos, actor, companyId, OP_BUDGET_VIEW);
      return repos.budgets.list(companyId, projectId, filter);
    });
  }

  async getBudget(actor: ActorContext, companyId: string, budgetId: string) {
    return this.uow.run(async (repos) => {
      const detail = await repos.budgets.findDetail(companyId, budgetId);
      if (detail === null) throw new OrgEntityNotFoundError('PROJECT_BUDGET');
      await this.authorizer.assertPermission(
        actor.actorId,
        FINANCE_BUDGET_READ,
        projectTarget(companyId, detail.projectId),
      );
      await this.assertOperation(repos, actor, companyId, OP_BUDGET_VIEW);
      const revisions = await repos.revisions.list(companyId, budgetId);
      return { ...detail, revisions };
    });
  }

  async updateBudget(
    actor: ActorContext,
    companyId: string,
    budgetId: string,
    input: UpdateBudgetInput,
  ) {
    return this.uow.run(async (repos) => {
      const budget = await this.budgetFor(repos, actor, companyId, budgetId, FINANCE_BUDGET_MANAGE);
      if (budget.status !== 'ACTIVE') {
        throw new OrgValidationError('status', 'budget is not ACTIVE');
      }
      await this.assertOperation(repos, actor, companyId, OP_BUDGET_REVISE);
      const data: Record<string, unknown> = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.description !== undefined) data.description = input.description;
      if (input.currency !== undefined) {
        const currency = input.currency.toUpperCase();
        if (!CURRENCY_RE.test(currency)) {
          throw new OrgValidationError('currency', 'must be a 3-letter ISO 4217 code');
        }
        data.currency = currency;
      }
      const result = await repos.budgets.update(companyId, budgetId, data, input.expectedVersion);
      if (result.count === 0) {
        throw new OrgValidationError('expectedVersion', 'stale version');
      }
      await repos.audit.record(
        auditEntry(actor, {
          action: 'FINANCE_BUDGET_UPDATED',
          entityType: 'PROJECT_BUDGET',
          entityId: budgetId,
          companyId,
          changedFields: Object.fromEntries(
            Object.entries(data).map(([k, v]) => [
              k,
              { before: (budget as unknown as Record<string, unknown>)[k] ?? null, after: v },
            ]),
          ),
        }),
      );
      return repos.budgets.findById(companyId, budgetId);
    });
  }

  // -------------------------------------------------------------- revisions

  async listRevisions(actor: ActorContext, companyId: string, budgetId: string, status?: string) {
    return this.uow.run(async (repos) => {
      await this.budgetFor(repos, actor, companyId, budgetId, FINANCE_BUDGET_READ);
      await this.assertOperation(repos, actor, companyId, OP_BUDGET_VIEW);
      return repos.revisions.list(companyId, budgetId, status);
    });
  }

  async getRevision(actor: ActorContext, companyId: string, budgetId: string, revisionId: string) {
    return this.uow.run(async (repos) => {
      await this.budgetFor(repos, actor, companyId, budgetId, FINANCE_BUDGET_READ);
      await this.assertOperation(repos, actor, companyId, OP_BUDGET_VIEW);
      const detail = await repos.revisions.findDetail(companyId, budgetId, revisionId);
      if (detail === null) throw new OrgEntityNotFoundError('BUDGET_REVISION');
      return detail;
    });
  }

  async createRevision(
    actor: ActorContext,
    companyId: string,
    budgetId: string,
    input: CreateBudgetRevisionInput,
  ) {
    validateLines(input.lines);
    const total = input.lines
      .reduce((acc, l) => acc.plus(l.amount), new Prisma.Decimal(0))
      .toFixed(2);
    const fingerprint =
      input.idempotencyKey !== undefined
        ? commandFingerprint({
            action: 'CREATE_BUDGET_REVISION',
            budgetId,
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
            lines: input.lines,
          })
        : undefined;

    return this.uow.run(async (repos) => {
      const budget = await this.budgetFor(repos, actor, companyId, budgetId, FINANCE_BUDGET_MANAGE);
      if (budget.status !== 'ACTIVE') {
        throw new OrgValidationError('status', 'budget is not ACTIVE');
      }
      await this.assertOperation(repos, actor, companyId, OP_BUDGET_REVISE);

      if (input.idempotencyKey !== undefined) {
        const recorded = await repos.revisions.findByIdempotencyKey(
          companyId,
          budgetId,
          input.idempotencyKey,
        );
        if (recorded !== null) {
          if (recorded.requestFingerprint !== fingerprint) {
            throw new IdempotencyConflictError(input.idempotencyKey);
          }
          return { revision: recorded, replayed: true };
        }
      }
      // Only one open revision at a time — a pending SUBMITTED revision must
      // be decided before another proposal is drafted.
      if ((await repos.budgets.openRevisionCount(companyId, budgetId)) > 0) {
        throw new AppError(
          409,
          'REVISION_IN_PROGRESS',
          'a draft or submitted revision already exists for this budget',
        );
      }
      const revisionNo = (await repos.budgets.maxRevisionNumber(companyId, budgetId)) + 1;
      const revision = await repos.revisions.create(
        companyId,
        budgetId,
        revisionNo,
        total,
        input,
        fingerprint,
      );
      await repos.audit.record(
        auditEntry(actor, {
          action: 'FINANCE_BUDGET_REVISION_CREATED',
          entityType: 'BUDGET_REVISION',
          entityId: revision.id,
          companyId,
          statusAfter: 'DRAFT',
          changedFields: {
            budgetId: { before: null, after: budgetId },
            revision: { before: null, after: revisionNo },
            totalAmount: { before: null, after: total },
          },
        }),
      );
      await repos.outbox.record({
        companyId,
        eventType: 'FINANCE_BUDGET_REVISION_CREATED',
        aggregateType: 'BUDGET_REVISION',
        aggregateId: revision.id,
        eventKey: `evt:${revision.id}:FINANCE_BUDGET_REVISION_CREATED`,
        recipientPrincipalIds: [],
        summary: { budgetId, revision: revisionNo, totalAmount: total },
      });
      return { revision, replayed: false };
    });
  }

  async submitRevision(
    actor: ActorContext,
    companyId: string,
    budgetId: string,
    revisionId: string,
    expectedVersion?: number,
  ) {
    return this.uow.run(async (repos) => {
      await this.budgetFor(repos, actor, companyId, budgetId, FINANCE_BUDGET_MANAGE);
      await this.assertOperation(repos, actor, companyId, OP_BUDGET_REVISE);
      const revision = await this.revisionFor(repos, companyId, budgetId, revisionId);
      // Idempotent by state: a retry by the same submitter replays cleanly.
      if (revision.status === 'SUBMITTED') {
        if (revision.submittedByPrincipalId === actor.actorId) {
          return { revision, replayed: true };
        }
        throw new InvalidStatusTransitionError('BUDGET_REVISION', revision.status, 'submit');
      }
      if (revision.status !== 'DRAFT') {
        throw new InvalidStatusTransitionError('BUDGET_REVISION', revision.status, 'submit');
      }
      const result = await repos.revisions.transition(
        companyId,
        revisionId,
        'DRAFT',
        {
          status: 'SUBMITTED',
          submittedByPrincipalId: actor.actorId,
          submittedAt: new Date(),
        },
        expectedVersion,
      );
      if (result.count === 0) {
        throw new OrgValidationError('expectedVersion', 'stale version');
      }
      await repos.audit.record(
        auditEntry(actor, {
          action: 'FINANCE_BUDGET_REVISION_SUBMITTED',
          entityType: 'BUDGET_REVISION',
          entityId: revisionId,
          companyId,
          statusBefore: 'DRAFT',
          statusAfter: 'SUBMITTED',
          changedFields: { status: { before: 'DRAFT', after: 'SUBMITTED' } },
        }),
      );
      await repos.outbox.record({
        companyId,
        eventType: 'FINANCE_BUDGET_REVISION_SUBMITTED',
        aggregateType: 'BUDGET_REVISION',
        aggregateId: revisionId,
        eventKey: `evt:${revisionId}:FINANCE_BUDGET_REVISION_SUBMITTED`,
        recipientPrincipalIds: [],
        summary: { budgetId, revision: revision.revision, totalAmount: revision.totalAmount },
      });
      return {
        revision: await this.revisionFor(repos, companyId, budgetId, revisionId),
        replayed: false,
      };
    });
  }

  // -------------------------------------------------------------- decisions

  async listDecisions(
    actor: ActorContext,
    companyId: string,
    budgetId: string,
    revisionId: string,
  ) {
    return this.uow.run(async (repos) => {
      await this.budgetFor(repos, actor, companyId, budgetId, FINANCE_BUDGET_READ);
      await this.assertOperation(repos, actor, companyId, OP_BUDGET_VIEW);
      await this.revisionFor(repos, companyId, budgetId, revisionId);
      return repos.decisions.list(companyId, revisionId);
    });
  }

  async decideRevision(
    actor: ActorContext,
    companyId: string,
    budgetId: string,
    revisionId: string,
    input: DecideBudgetRevisionInput,
  ) {
    const fingerprint =
      input.idempotencyKey !== undefined
        ? commandFingerprint({
            action: 'DECIDE_BUDGET_REVISION',
            revisionId,
            decision: input.action,
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
          })
        : undefined;

    return this.uow.run(async (repos) => {
      await this.budgetFor(repos, actor, companyId, budgetId, FINANCE_BUDGET_MANAGE);
      await this.assertOperation(repos, actor, companyId, OP_BUDGET_APPROVE);
      const revision = await this.revisionFor(repos, companyId, budgetId, revisionId);

      if (input.idempotencyKey !== undefined) {
        const recorded = await repos.decisions.findByIdempotencyKey(
          companyId,
          revisionId,
          input.idempotencyKey,
        );
        if (recorded !== null) {
          if (recorded.requestFingerprint !== fingerprint) {
            throw new IdempotencyConflictError(input.idempotencyKey);
          }
          return { revision, decision: recorded, replayed: true };
        }
      }
      if (revision.status !== 'SUBMITTED') {
        throw new InvalidStatusTransitionError(
          'BUDGET_REVISION',
          revision.status,
          `decide ${input.action}`,
        );
      }
      // Separation of duties: the submitter may not decide their own revision.
      if (revision.submittedByPrincipalId === actor.actorId) {
        throw new AppError(
          403,
          'SELF_APPROVAL_FORBIDDEN',
          'the submitter cannot decide their own budget revision',
        );
      }
      const toStatus =
        input.action === 'APPROVE'
          ? 'APPROVED'
          : input.action === 'REJECT'
            ? 'REJECTED'
            : 'RETURNED';
      const decision = await repos.decisions.create(companyId, {
        revisionId,
        action: input.action,
        ...(actor.actorType === 'USER' ? { actorPrincipalId: actor.actorId } : {}),
        actorType: actor.actorType,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(fingerprint !== undefined ? { requestFingerprint: fingerprint } : {}),
        eventKey: randomUUID(),
      });
      const result = await repos.revisions.transition(
        companyId,
        revisionId,
        'SUBMITTED',
        {
          status: toStatus,
          decidedByPrincipalId: actor.actorId,
          decidedAt: new Date(),
        },
        input.expectedVersion,
      );
      if (result.count === 0) {
        throw new OrgValidationError('expectedVersion', 'stale version');
      }
      if (input.action === 'APPROVE') {
        // Only the APPROVE path promotes the pointer — no status write can
        // reach latestApprovedRevisionId outside this command.
        await repos.budgets.update(companyId, budgetId, {
          latestApprovedRevisionId: revisionId,
        });
      }
      await repos.audit.record(
        auditEntry(actor, {
          action: 'FINANCE_BUDGET_REVISION_DECIDED',
          entityType: 'BUDGET_REVISION',
          entityId: revisionId,
          companyId,
          statusBefore: 'SUBMITTED',
          statusAfter: toStatus,
          changedFields: {
            status: { before: 'SUBMITTED', after: toStatus },
            action: { before: null, after: input.action },
            decisionId: { before: null, after: decision.id },
          },
        }),
      );
      await repos.outbox.record({
        companyId,
        eventType: 'FINANCE_BUDGET_REVISION_DECIDED',
        aggregateType: 'BUDGET_REVISION',
        aggregateId: revisionId,
        eventKey: `evt:${decision.id}:FINANCE_BUDGET_REVISION_DECIDED`,
        recipientPrincipalIds:
          revision.submittedByPrincipalId !== null ? [revision.submittedByPrincipalId] : [],
        summary: { budgetId, revision: revision.revision, action: input.action, status: toStatus },
      });
      return {
        revision: await this.revisionFor(repos, companyId, budgetId, revisionId),
        decision,
        replayed: false,
      };
    });
  }

  // ------------------------------------------------------------------ costs

  /**
   * Verified rollup only: APPROVED budget revisions and ACTIVE forecasts.
   * No Finance transaction ledger exists yet — actuals/commitments are
   * returned as null rather than fabricated.
   */
  async getProjectCosts(actor: ActorContext, companyId: string, projectId: string) {
    await this.authorizer.assertPermission(
      actor.actorId,
      FINANCE_BUDGET_READ,
      projectTarget(companyId, projectId),
    );
    return this.uow.run(async (repos) => {
      await this.assertProject(repos, companyId, projectId);
      await this.assertOperation(repos, actor, companyId, OP_BUDGET_VIEW);

      const budgets = await repos.budgets.list(companyId, projectId, { limit: 100 });
      const budgetSummaries = [];
      for (const budget of budgets) {
        const approved =
          budget.latestApprovedRevisionId === null
            ? null
            : await repos.revisions.findById(companyId, budget.id, budget.latestApprovedRevisionId);
        budgetSummaries.push({
          id: budget.id,
          code: budget.code,
          name: budget.name,
          currency: budget.currency,
          approvedRevision:
            approved === null
              ? null
              : { revision: approved.revision, totalAmount: approved.totalAmount.toString() },
        });
      }
      const forecasts = await repos.forecasts.list(companyId, projectId, {
        status: 'ACTIVE',
        limit: 100,
      });
      let inflow = new Prisma.Decimal(0);
      let outflow = new Prisma.Decimal(0);
      for (const forecast of forecasts) {
        const detail = await repos.forecasts.findDetail(companyId, forecast.id);
        for (const line of detail?.lines ?? []) {
          if (line.direction === 'INFLOW') inflow = inflow.plus(line.amount);
          else outflow = outflow.plus(line.amount);
        }
      }
      return {
        projectId,
        budgets: budgetSummaries,
        cashFlowForecasts: {
          count: forecasts.length,
          totalInflow: inflow.toFixed(2),
          totalOutflow: outflow.toFixed(2),
          net: inflow.minus(outflow).toFixed(2),
        },
        // No Finance transaction records exist yet — deliberately null, not 0.
        commitments: null,
        actuals: null,
      };
    });
  }

  // --------------------------------------------------------------- forecasts

  async createForecast(
    actor: ActorContext,
    companyId: string,
    projectId: string,
    input: CreateForecastInput,
  ) {
    await this.authorizer.assertPermission(
      actor.actorId,
      FINANCE_BUDGET_MANAGE,
      projectTarget(companyId, projectId),
    );
    validateLines(input.lines);
    const periodStart = toDate('periodStart', input.periodStart);
    const periodEnd = toDate('periodEnd', input.periodEnd);
    if (periodEnd < periodStart) {
      throw new OrgValidationError('periodEnd', 'must not precede periodStart');
    }
    const currency = input.currency.toUpperCase();
    if (!CURRENCY_RE.test(currency)) {
      throw new OrgValidationError('currency', 'must be a 3-letter ISO 4217 code');
    }
    const fingerprint =
      input.idempotencyKey !== undefined
        ? commandFingerprint({
            action: 'CREATE_FORECAST',
            projectId,
            name: input.name,
            currency,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            lines: input.lines,
          })
        : undefined;

    return this.uow.run(async (repos) => {
      await this.assertProject(repos, companyId, projectId);
      await this.assertOperation(repos, actor, companyId, OP_FORECAST_SUBMIT);

      if (input.idempotencyKey !== undefined) {
        const recorded = await repos.forecasts.findByIdempotencyKey(
          companyId,
          projectId,
          input.idempotencyKey,
        );
        if (recorded !== null) {
          if (recorded.requestFingerprint !== fingerprint) {
            throw new IdempotencyConflictError(input.idempotencyKey);
          }
          return { forecast: recorded, replayed: true };
        }
      }
      const forecast = await repos.forecasts.create(companyId, {
        ...input,
        currency,
        projectId,
        ...(fingerprint !== undefined ? { requestFingerprint: fingerprint } : {}),
      });
      await repos.audit.record(
        auditEntry(actor, {
          action: 'FINANCE_CASH_FLOW_FORECAST_CREATED',
          entityType: 'CASH_FLOW_FORECAST',
          entityId: forecast.id,
          companyId,
          statusAfter: 'ACTIVE',
          changedFields: {
            projectId: { before: null, after: projectId },
            periodStart: { before: null, after: input.periodStart },
            periodEnd: { before: null, after: input.periodEnd },
          },
        }),
      );
      await repos.outbox.record({
        companyId,
        eventType: 'FINANCE_CASH_FLOW_FORECAST_CREATED',
        aggregateType: 'CASH_FLOW_FORECAST',
        aggregateId: forecast.id,
        eventKey: `evt:${forecast.id}:FINANCE_CASH_FLOW_FORECAST_CREATED`,
        recipientPrincipalIds: [],
        summary: { projectId, periodStart: input.periodStart, periodEnd: input.periodEnd },
      });
      return { forecast, replayed: false };
    });
  }

  async listForecasts(
    actor: ActorContext,
    companyId: string,
    projectId: string,
    filter: ForecastListFilter,
  ) {
    await this.authorizer.assertPermission(
      actor.actorId,
      FINANCE_BUDGET_READ,
      projectTarget(companyId, projectId),
    );
    return this.uow.run(async (repos) => {
      await this.assertProject(repos, companyId, projectId);
      await this.assertOperation(repos, actor, companyId, OP_FORECAST_REVIEW);
      return repos.forecasts.list(companyId, projectId, filter);
    });
  }

  async getForecast(actor: ActorContext, companyId: string, forecastId: string) {
    return this.uow.run(async (repos) => {
      const detail = await repos.forecasts.findDetail(companyId, forecastId);
      if (detail === null) throw new OrgEntityNotFoundError('CASH_FLOW_FORECAST');
      await this.authorizer.assertPermission(
        actor.actorId,
        FINANCE_BUDGET_READ,
        projectTarget(companyId, detail.projectId),
      );
      await this.assertOperation(repos, actor, companyId, OP_FORECAST_REVIEW);
      return detail;
    });
  }

  async reviseForecast(
    actor: ActorContext,
    companyId: string,
    forecastId: string,
    input: ReviseForecastInput,
  ) {
    return this.uow.run(async (repos) => {
      const forecast = await repos.forecasts.findById(companyId, forecastId);
      if (forecast === null) throw new OrgEntityNotFoundError('CASH_FLOW_FORECAST');
      await this.authorizer.assertPermission(
        actor.actorId,
        FINANCE_BUDGET_MANAGE,
        projectTarget(companyId, forecast.projectId),
      );
      if (forecast.status !== 'ACTIVE') {
        throw new OrgValidationError('status', 'forecast is not ACTIVE');
      }
      await this.assertOperation(repos, actor, companyId, OP_FORECAST_REVISE);

      const fingerprint =
        input.idempotencyKey !== undefined
          ? commandFingerprint({
              action: 'REVISE_FORECAST',
              forecastId,
              ...(input.reason !== undefined ? { reason: input.reason } : {}),
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.periodStart !== undefined ? { periodStart: input.periodStart } : {}),
              ...(input.periodEnd !== undefined ? { periodEnd: input.periodEnd } : {}),
              ...(input.lines !== undefined ? { lines: input.lines } : {}),
            })
          : undefined;
      // Idempotent replay: same key + same semantic command returns current.
      if (input.idempotencyKey !== undefined) {
        if (
          forecast.idempotencyKey === input.idempotencyKey &&
          forecast.requestFingerprint === fingerprint
        ) {
          return { forecast, replayed: true };
        }
        if (
          forecast.idempotencyKey === input.idempotencyKey &&
          forecast.requestFingerprint !== fingerprint
        ) {
          throw new IdempotencyConflictError(input.idempotencyKey);
        }
      }

      const header: Record<string, unknown> = {};
      if (input.name !== undefined) header.name = input.name;
      if (input.description !== undefined) header.description = input.description;
      if (input.currency !== undefined) {
        const currency = input.currency.toUpperCase();
        if (!CURRENCY_RE.test(currency)) {
          throw new OrgValidationError('currency', 'must be a 3-letter ISO 4217 code');
        }
        header.currency = currency;
      }
      const periodStart =
        input.periodStart !== undefined
          ? toDate('periodStart', input.periodStart)
          : forecast.periodStart;
      const periodEnd =
        input.periodEnd !== undefined ? toDate('periodEnd', input.periodEnd) : forecast.periodEnd;
      if (periodEnd < periodStart) {
        throw new OrgValidationError('periodEnd', 'must not precede periodStart');
      }
      if (input.periodStart !== undefined) header.periodStart = periodStart;
      if (input.periodEnd !== undefined) header.periodEnd = periodEnd;
      if (input.lines !== undefined) validateLines(input.lines);
      if (input.idempotencyKey !== undefined) header.idempotencyKey = input.idempotencyKey;
      if (fingerprint !== undefined) header.requestFingerprint = fingerprint;

      const result = await repos.forecasts.revise(
        companyId,
        forecastId,
        {
          header,
          ...(input.lines !== undefined ? { lines: input.lines } : {}),
          bumpRevision: true,
        },
        input.expectedVersion,
      );
      if (result.count === 0) {
        throw new OrgValidationError('expectedVersion', 'stale version');
      }
      await repos.audit.record(
        auditEntry(actor, {
          action: 'FINANCE_CASH_FLOW_FORECAST_REVISED',
          entityType: 'CASH_FLOW_FORECAST',
          entityId: forecastId,
          companyId,
          changedFields: {
            revision: { before: forecast.revision, after: forecast.revision + 1 },
            ...(input.reason !== undefined
              ? { reason: { before: null, after: input.reason } }
              : {}),
          },
        }),
      );
      await repos.outbox.record({
        companyId,
        eventType: 'FINANCE_CASH_FLOW_FORECAST_REVISED',
        aggregateType: 'CASH_FLOW_FORECAST',
        aggregateId: forecastId,
        eventKey: `evt:${forecastId}:FINANCE_CASH_FLOW_FORECAST_REVISED:v${forecast.revision + 1}`,
        recipientPrincipalIds: [],
        summary: { projectId: forecast.projectId, revision: forecast.revision + 1 },
      });
      return { forecast: await repos.forecasts.findDetail(companyId, forecastId), replayed: false };
    });
  }

  // ------------------------------------------------------------- portfolio

  async listProjects(actor: ActorContext, companyId: string, filter: PortfolioProjectFilter) {
    await this.authorizer.assertPermission(
      actor.actorId,
      FINANCE_PORTFOLIO_READ,
      companyTarget(companyId),
    );
    return this.uow.run(async (repos) => {
      await this.assertOperation(repos, actor, companyId, OP_PROJECT_DASHBOARD_VIEW);
      const rows = await repos.projects.list(companyId, filter);
      return pageOf(rows, filter.limit);
    });
  }

  async listProjectSites(
    actor: ActorContext,
    companyId: string,
    projectId: string,
    filter: SiteListFilter,
  ) {
    await this.authorizer.assertPermission(
      actor.actorId,
      FINANCE_PORTFOLIO_READ,
      projectTarget(companyId, projectId),
    );
    return this.uow.run(async (repos) => {
      await this.assertProject(repos, companyId, projectId);
      await this.assertOperation(repos, actor, companyId, OP_PROJECT_DASHBOARD_VIEW);
      const rows = await repos.sites.list(companyId, projectId, filter);
      // Explicit whitelist: exact geofence coordinates are operational data —
      // not part of the finance portfolio contract.
      const items = rows.slice(0, filter.limit).map((s) => ({
        id: s.id,
        projectId: s.projectId,
        code: s.code,
        name: s.name,
        address: s.address,
        city: s.city,
        district: s.district,
        state: s.state,
        pinCode: s.pinCode,
        country: s.country,
        geoFenceRadiusM: s.geoFenceRadiusM,
        timezone: s.timezone,
        status: s.status,
        createdAt: s.createdAt,
      }));
      const last = items[items.length - 1];
      return {
        items,
        ...(rows.length > filter.limit && last !== undefined ? { nextCursor: last.id } : {}),
      };
    });
  }

  // -------------------------------------------------------------- employees

  async listEmployees(actor: ActorContext, companyId: string, filter: EmployeeListFilter) {
    await this.authorizer.assertPermission(
      actor.actorId,
      FINANCE_EMPLOYEE_READ,
      companyTarget(companyId),
    );
    return this.uow.run(async (repos) => {
      await this.assertOperation(repos, actor, companyId, OP_EMPLOYEE_DIRECTORY_VIEW);
      const rows = await repos.employees.list(companyId, filter, new Date());
      return pageOf(
        rows.map(({ memberships, ...employee }) => ({
          id: employee.id,
          employeeCode: employee.employeeCode,
          displayName: employee.displayName,
          status: employee.status,
          createdAt: employee.createdAt,
          primaryMembership: memberships[0] ?? null,
        })),
        filter.limit,
      );
    });
  }

  async getEmployee(actor: ActorContext, companyId: string, employeeId: string) {
    return this.uow.run(async (repos) => {
      const employee = await repos.employees.findById(companyId, employeeId);
      if (employee === null) throw new OrgEntityNotFoundError('EMPLOYEE');
      await this.authorizer.assertPermission(
        actor.actorId,
        FINANCE_EMPLOYEE_READ,
        companyTarget(companyId),
      );
      await this.assertOperation(repos, actor, companyId, OP_EMPLOYEE_DIRECTORY_VIEW);
      const now = new Date();
      const [memberships, sensitiveAllowed] = await Promise.all([
        repos.employees.activeMemberships(companyId, employeeId, now),
        this.sensitiveEmployeeAccess(repos, actor, companyId),
      ]);
      return {
        id: employee.id,
        employeeCode: employee.employeeCode,
        displayName: employee.displayName,
        status: employee.status,
        createdAt: employee.createdAt,
        updatedAt: employee.updatedAt,
        memberships: memberships.map((m) => ({
          id: m.id,
          departmentId: m.departmentId,
          departmentCode: m.department.code,
          departmentName: m.department.name,
          scopeType: m.department.scopeType,
          projectId: m.department.projectId,
          siteId: m.department.siteId,
          isPrimary: m.isPrimary,
          startedAt: m.startedAt,
        })),
        // Separate sensitive gate: requires BOTH the sensitive API permission
        // and the FINANCE_EMPLOYMENT_DETAILS_VIEW operation assignment.
        employmentDetails: sensitiveAllowed
          ? {
              engagementType: employee.engagementType,
              designation: employee.designation,
              tradeCategory: employee.tradeCategory,
              joiningDate: employee.joiningDate,
              contactPhone: employee.contactPhone,
              contactEmail: employee.contactEmail,
              emergencyContactName: employee.emergencyContactName,
              emergencyContactPhone: employee.emergencyContactPhone,
            }
          : null,
      };
    });
  }

  /** Both the sensitive permission AND the sensitive operation must hold. */
  private async sensitiveEmployeeAccess(
    repos: FinanceRepos,
    actor: ActorContext,
    companyId: string,
  ): Promise<boolean> {
    const [perm, op] = await Promise.all([
      this.authorizer.hasPermission(
        actor.actorId,
        FINANCE_EMPLOYEE_SENSITIVE_READ,
        companyTarget(companyId),
      ),
      this.hasOperation(repos, actor, companyId, OP_EMPLOYMENT_DETAILS_VIEW),
    ]);
    return perm && op;
  }

  /**
   * Payroll-input view of attendance: unit/hour aggregates only. No GPS
   * coordinates, remarks, or per-punch detail leave this service.
   */
  async getAttendanceSummary(
    actor: ActorContext,
    companyId: string,
    employeeId: string,
    range: AttendanceSummaryRange,
  ) {
    if (!DATE_RE.test(range.from)) throw new OrgValidationError('from', 'must be YYYY-MM-DD');
    if (!DATE_RE.test(range.to)) throw new OrgValidationError('to', 'must be YYYY-MM-DD');
    if (range.to < range.from) {
      throw new OrgValidationError('to', 'must not precede from');
    }
    return this.uow.run(async (repos) => {
      const employee = await repos.employees.findById(companyId, employeeId);
      if (employee === null) throw new OrgEntityNotFoundError('EMPLOYEE');
      await this.authorizer.assertPermission(
        actor.actorId,
        FINANCE_EMPLOYEE_READ,
        companyTarget(companyId),
      );
      await this.assertOperation(repos, actor, companyId, OP_PAYROLL_INPUT_REVIEW);
      const totals = await repos.attendance.summarize(companyId, employeeId, range.from, range.to);
      return { employeeId, ...range, ...totals };
    });
  }

  /**
   * Entitlement/usage view of leave: balances + request counts/days by status.
   * Leave reasons and document contents are never returned.
   */
  async getLeaveSummary(actor: ActorContext, companyId: string, employeeId: string, year: number) {
    return this.uow.run(async (repos) => {
      const employee = await repos.employees.findById(companyId, employeeId);
      if (employee === null) throw new OrgEntityNotFoundError('EMPLOYEE');
      await this.authorizer.assertPermission(
        actor.actorId,
        FINANCE_EMPLOYEE_READ,
        companyTarget(companyId),
      );
      await this.assertOperation(repos, actor, companyId, OP_EMPLOYMENT_DETAILS_VIEW);
      const yearStart = new Date(`${year}-01-01T00:00:00.000Z`);
      const yearEnd = new Date(`${year}-12-31T00:00:00.000Z`);
      const [balances, requestStats] = await Promise.all([
        repos.leave.balances(companyId, employeeId, year),
        repos.leave.requestStats(companyId, employeeId, yearStart, yearEnd),
      ]);
      return {
        employeeId,
        year,
        balances: balances.map((b) => ({
          leaveType: b.leaveType,
          allocatedDays: b.allocatedDays.toFixed(1),
          usedDays: b.usedDays.toFixed(1),
          pendingDays: b.pendingDays.toFixed(1),
          carriedOverDays: b.carriedOverDays.toFixed(1),
          availableDays: b.allocatedDays.plus(b.carriedOverDays).minus(b.usedDays).toFixed(1),
        })),
        requests: requestStats,
      };
    });
  }

  // -------------------------------------------------------------- dashboard

  /**
   * Aggregates backed by existing repositories only — no N+1 (status groupBys,
   * one bounded forecast-lines read). Sections with no data model yet are
   * reported in `unavailable`, never fabricated. `workforce` is gated on the
   * directory capability, not the dashboard permission.
   */
  async getDashboard(actor: ActorContext, companyId: string) {
    await this.authorizer.assertPermission(
      actor.actorId,
      FINANCE_DASHBOARD_READ,
      companyTarget(companyId),
    );
    return this.uow.run(async (repos) => {
      await this.assertOperation(repos, actor, companyId, OP_PROJECT_DASHBOARD_VIEW);
      const [projects, sites, budgets, approvedTotals, pendingReviews, activeForecasts] =
        await Promise.all([
          repos.projects.statusCounts(companyId),
          repos.sites.statusCounts(companyId),
          repos.budgets.statusCounts(companyId),
          repos.budgets.approvedTotals(companyId),
          repos.revisions.pendingReviewCount(companyId),
          repos.forecasts.activeLines(companyId),
        ]);

      const cashByCurrency = new Map<
        string,
        { inflow: Prisma.Decimal; outflow: Prisma.Decimal; forecasts: number }
      >();
      for (const forecast of activeForecasts) {
        const bucket = cashByCurrency.get(forecast.currency) ?? {
          inflow: new Prisma.Decimal(0),
          outflow: new Prisma.Decimal(0),
          forecasts: 0,
        };
        bucket.forecasts += 1;
        for (const line of forecast.lines) {
          if (line.direction === 'INFLOW') bucket.inflow = bucket.inflow.plus(line.amount);
          else bucket.outflow = bucket.outflow.plus(line.amount);
        }
        cashByCurrency.set(forecast.currency, bucket);
      }

      const [workforcePerm, workforceOp] = await Promise.all([
        this.authorizer.hasPermission(
          actor.actorId,
          FINANCE_EMPLOYEE_READ,
          companyTarget(companyId),
        ),
        this.hasOperation(repos, actor, companyId, OP_EMPLOYEE_DIRECTORY_VIEW),
      ]);
      const workforce =
        workforcePerm && workforceOp
          ? byStatusOf(await repos.employees.statusCounts(companyId))
          : null;

      const unavailable: { section: string; reason: string }[] = [
        { section: 'wallets', reason: 'no wallet data model yet' },
        { section: 'pettyCash', reason: 'no petty-cash data model yet' },
        { section: 'quotations', reason: 'no quotation data model yet' },
        { section: 'billing', reason: 'no billing/invoice data model yet' },
        { section: 'payroll', reason: 'no payroll data model yet' },
        {
          section: 'actualCosts',
          reason: 'no Finance transaction ledger — actuals are not fabricated',
        },
        {
          section: 'commitments',
          reason: 'no procurement/commitment data model yet',
        },
        { section: 'reports', reason: 'reporting slice not implemented' },
      ];
      if (workforce === null) {
        unavailable.push({
          section: 'workforce',
          reason: 'requires FINANCE_EMPLOYEE_READ + FINANCE_EMPLOYEE_DIRECTORY_VIEW',
        });
      }

      return {
        generatedAt: new Date(),
        projects: byStatusOf(projects),
        sites: byStatusOf(sites),
        budgets: { ...byStatusOf(budgets), approvedTotals },
        pendingBudgetReviews: pendingReviews,
        cashFlowForecasts: {
          active: activeForecasts.length,
          byCurrency: [...cashByCurrency.entries()].map(([currency, b]) => ({
            currency,
            forecasts: b.forecasts,
            totalInflow: b.inflow.toFixed(2),
            totalOutflow: b.outflow.toFixed(2),
            net: b.inflow.minus(b.outflow).toFixed(2),
          })),
        },
        workforce,
        unavailable,
      };
    });
  }
}

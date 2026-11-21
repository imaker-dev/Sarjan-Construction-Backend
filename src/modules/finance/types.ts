import { Type } from '@sinclair/typebox';
import type {
  BudgetCategory,
  BudgetReviewAction,
  BudgetRevisionStatus,
  CashFlowCategory,
  CashFlowDirection,
  EmployeeStatus,
  OrgNodeStatus,
  ProjectStatus,
} from '@prisma/client';

// ---------------------------------------------------------------------------
// Request inputs (validated by TypeBox schemas in routes.ts)
// ---------------------------------------------------------------------------

const MONEY_RE = '^(0|[1-9][0-9]{0,15})(\\.[0-9]{1,2})?$';
const CURRENCY_RE = '^[A-Za-z]{3}$';

export const MoneyAmount = Type.String({
  pattern: MONEY_RE,
  description: 'Non-negative decimal amount, up to 2 fractional digits',
});

export const CurrencyCode = Type.String({
  pattern: CURRENCY_RE,
  description: 'ISO 4217 currency code, e.g. INR, USD',
});

export const BudgetCategoryEnum = Type.Union(
  (
    ['MATERIAL', 'LABOUR', 'EQUIPMENT', 'SUBCONTRACT', 'OVERHEAD', 'CONTINGENCY', 'OTHER'] as const
  ).map((v) => Type.Literal(v)),
  { description: 'Budget cost category' },
);

export const CashFlowDirectionEnum = Type.Union([
  Type.Literal('INFLOW'),
  Type.Literal('OUTFLOW'),
] as const);

export const CashFlowCategoryEnum = Type.Union(
  (
    [
      'CLIENT_RECEIPT',
      'ADVANCE_RECEIPT',
      'RETENTION_RELEASE',
      'MATERIAL',
      'LABOUR',
      'EQUIPMENT',
      'SUBCONTRACT',
      'OVERHEAD',
      'TAX',
      'OTHER',
    ] as const
  ).map((v) => Type.Literal(v)),
  { description: 'Cash-flow line category' },
);

export const BudgetLineInput = Type.Object({
  category: BudgetCategoryEnum,
  description: Type.String({ minLength: 1, maxLength: 500 }),
  amount: MoneyAmount,
});

export const ForecastLineInput = Type.Object({
  direction: CashFlowDirectionEnum,
  category: CashFlowCategoryEnum,
  amount: MoneyAmount,
  expectedDate: Type.Optional(Type.String({ format: 'date' })),
  description: Type.Optional(Type.String({ maxLength: 500 })),
});

export interface CreateBudgetInput {
  code: string;
  name: string;
  description?: string;
  currency: string;
  idempotencyKey?: string;
}

export interface UpdateBudgetInput {
  name?: string;
  description?: string | null;
  currency?: string;
  expectedVersion: number;
}

export interface CreateBudgetRevisionInput {
  notes?: string;
  lines: { category: BudgetCategory; description: string; amount: string }[];
  idempotencyKey?: string;
}

export interface DecideBudgetRevisionInput {
  action: BudgetReviewAction;
  reason?: string;
  expectedVersion?: number;
  idempotencyKey?: string;
}

export interface CreateForecastInput {
  name: string;
  description?: string;
  currency: string;
  periodStart: string;
  periodEnd: string;
  lines: {
    direction: CashFlowDirection;
    category: CashFlowCategory;
    amount: string;
    expectedDate?: string;
    description?: string;
  }[];
  idempotencyKey?: string;
}

export interface ReviseForecastInput {
  name?: string;
  description?: string | null;
  currency?: string;
  periodStart?: string;
  periodEnd?: string;
  lines?: {
    direction: CashFlowDirection;
    category: CashFlowCategory;
    amount: string;
    expectedDate?: string;
    description?: string;
  }[];
  reason?: string;
  expectedVersion: number;
  idempotencyKey?: string;
}

export interface BudgetListFilter {
  status?: OrgNodeStatus;
  limit: number;
  cursor?: string;
}

export interface RevisionListFilter {
  status?: BudgetRevisionStatus;
}

export interface ForecastListFilter {
  status?: OrgNodeStatus;
  limit: number;
  cursor?: string;
}

// ---------------------------------------------------------------------------
// Read-only portfolio / workforce / dashboard slice
// ---------------------------------------------------------------------------

export interface PortfolioProjectFilter {
  status?: ProjectStatus;
  search?: string;
  limit: number;
  cursor?: string;
}

export interface SiteListFilter {
  status?: OrgNodeStatus;
  limit: number;
  cursor?: string;
}

export interface EmployeeListFilter {
  projectId?: string;
  siteId?: string;
  departmentId?: string;
  status?: EmployeeStatus;
  search?: string;
  limit: number;
  cursor?: string;
}

export interface AttendanceSummaryRange {
  /** YYYY-MM-DD business dates, inclusive. */
  from: string;
  to: string;
}

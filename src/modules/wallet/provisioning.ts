import type { Prisma } from '@prisma/client';
import { WALLET_FUNDING_OPERATION_KEY } from './types.js';

type Tx = Prisma.TransactionClient;

const DEPARTMENT_CODE = 'SITE-WALLET-FIN';
const WORKFLOW_KEY = 'SITE-WALLET-FUNDING';

/** Single-stage Finance review — ROLE_KEY FINANCE_MANAGER, no self-approval. */
const WORKFLOW_DEFINITION = {
  initialState: 'SUBMITTED',
  steps: [
    {
      key: 'approve',
      kind: 'APPROVAL',
      from: 'SUBMITTED',
      action: 'APPROVE',
      to: 'APPROVED',
      stageKey: 'finance-review',
      assignee: { type: 'ROLE_KEY', value: 'FINANCE_MANAGER' },
      selfApprove: false,
    },
    {
      key: 'reject',
      kind: 'APPROVAL',
      from: 'SUBMITTED',
      action: 'REJECT',
      to: 'REJECTED',
      stageKey: 'finance-review',
      assignee: { type: 'ROLE_KEY', value: 'FINANCE_MANAGER' },
      selfApprove: false,
    },
    {
      key: 'return',
      kind: 'APPROVAL',
      from: 'SUBMITTED',
      action: 'RETURN',
      to: 'RETURNED',
      stageKey: 'finance-review',
      assignee: { type: 'ROLE_KEY', value: 'FINANCE_MANAGER' },
      selfApprove: false,
    },
  ],
} as const;

/**
 * Lazily provisions the wallet-funding approval workflow for a company:
 * a COMPANY-scope department, the WALLET-FUNDING-REQUEST operation with a
 * published version, and the single-stage review workflow. Idempotent —
 * every step is an upsert keyed by the schema's natural unique constraints,
 * so concurrent first submissions cannot duplicate anything. Returns the
 * workflow id used by `startInstance`.
 */
export async function ensureWalletFundingWorkflow(tx: Tx, companyId: string): Promise<string> {
  // Department.code uniqueness is a per-scope partial index in SQL (Prisma
  // cannot express it), so this is find-or-create — a concurrent first
  // submit that loses the race sees P2002 and retries the whole submit
  // (idempotent by idempotencyKey).
  let department = await tx.department.findFirst({
    where: { companyId, code: DEPARTMENT_CODE, scopeType: 'COMPANY' },
    select: { id: true },
  });
  department ??= await tx.department.create({
    data: {
      companyId,
      scopeType: 'COMPANY',
      code: DEPARTMENT_CODE,
      name: 'Site Wallet Finance',
      category: 'CUSTOM',
      categoryLabel: 'Site Wallet',
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  const operation = await tx.operation.upsert({
    where: {
      companyId_departmentId_key: {
        companyId,
        departmentId: department.id,
        key: WALLET_FUNDING_OPERATION_KEY,
      },
    },
    create: {
      companyId,
      departmentId: department.id,
      key: WALLET_FUNDING_OPERATION_KEY,
      name: 'Site Wallet Funding Request',
      definition: {},
      status: 'ACTIVE',
    },
    update: {},
    select: { id: true },
  });
  const operationVersion = await tx.operationVersion.upsert({
    where: {
      companyId_operationId_revision: {
        companyId,
        operationId: operation.id,
        revision: 1,
      },
    },
    create: { companyId, operationId: operation.id, revision: 1, definition: {} },
    update: {},
    select: { id: true },
  });
  await tx.operation.updateMany({
    where: { id: operation.id, companyId, currentVersionId: null },
    data: { currentVersionId: operationVersion.id, latestRevision: 1, status: 'ACTIVE' },
  });
  const workflow = await tx.workflow.upsert({
    where: {
      companyId_operationId_key: {
        companyId,
        operationId: operation.id,
        key: WORKFLOW_KEY,
      },
    },
    create: {
      companyId,
      operationId: operation.id,
      operationVersionId: operationVersion.id,
      key: WORKFLOW_KEY,
      name: 'Site Wallet Funding Approval',
      definition: WORKFLOW_DEFINITION,
      status: 'ACTIVE',
    },
    update: {},
    select: { id: true },
  });
  const workflowVersion = await tx.workflowVersion.upsert({
    where: {
      companyId_workflowId_revision: { companyId, workflowId: workflow.id, revision: 1 },
    },
    create: {
      companyId,
      workflowId: workflow.id,
      revision: 1,
      definition: WORKFLOW_DEFINITION,
    },
    update: {},
    select: { id: true },
  });
  await tx.workflow.updateMany({
    where: { id: workflow.id, companyId, currentVersionId: null },
    data: { currentVersionId: workflowVersion.id, latestRevision: 1, status: 'ACTIVE' },
  });
  return workflow.id;
}

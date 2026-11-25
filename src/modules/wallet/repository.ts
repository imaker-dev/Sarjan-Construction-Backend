import type { Prisma, PrismaClient, SiteWallet } from '@prisma/client';
import { makeWorkflowInstanceRepos } from '../workflow-instance/repository.js';
import type { WorkflowInstanceRepos } from '../workflow-instance/repository.js';

type Tx = Prisma.TransactionClient;

/**
 * Wallet repositories run inside the caller's unit of work. Audit and outbox
 * reuse the workflow-instance emit-side implementations — same tables, same
 * dedupe semantics. `tx` is exposed for wallet-model reads/writes and for the
 * few raw-SQL paths (row locks, atomic voucher numbering) Prisma cannot
 * express.
 */
export interface WalletRepos {
  tx: Tx;
  /** Workflow-instance write/read repos — instances, tasks, versions. */
  wf: WorkflowInstanceRepos;
  audit: WorkflowInstanceRepos['audit'];
  outbox: WorkflowInstanceRepos['outbox'];
}

export function makeWalletRepos(tx: Tx): WalletRepos {
  const wf = makeWorkflowInstanceRepos(tx);
  return { tx, wf, audit: wf.audit, outbox: wf.outbox };
}

export interface WalletUnitOfWork {
  run<T>(fn: (repos: WalletRepos) => Promise<T>): Promise<T>;
}

export class PrismaWalletUnitOfWork implements WalletUnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}
  run<T>(fn: (repos: WalletRepos) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(makeWalletRepos(tx)));
  }
}

/** Row-level lock before any ledger posting — serializes balance chains. */
export async function lockWallet(
  tx: Tx,
  companyId: string,
  walletId: string,
): Promise<SiteWallet | null> {
  const rows = await tx.$queryRaw<SiteWallet[]>`
    SELECT * FROM "SiteWallet"
    WHERE "id" = ${walletId}::uuid AND "companyId" = ${companyId}::uuid
    FOR UPDATE`;
  return rows[0] ?? null;
}

/** Gapless company-scoped voucher number — atomic under concurrency. */
export async function allocVoucherNo(tx: Tx, companyId: string): Promise<bigint> {
  const rows = await tx.$queryRaw<{ nextvoucherno: bigint }[]>`
    INSERT INTO "WalletVoucherCounter" ("companyId", "nextVoucherNo")
    VALUES (${companyId}::uuid, 2)
    ON CONFLICT ("companyId")
    DO UPDATE SET "nextVoucherNo" = "WalletVoucherCounter"."nextVoucherNo" + 1
    RETURNING "nextVoucherNo" - 1 AS nextvoucherno`;
  const row = rows[0];
  if (row === undefined) throw new Error('voucher number allocation failed');
  return row.nextvoucherno;
}

/**
 * Active principals holding a role whose assignment covers the given scope
 * chain — notification recipient resolution for wallet events. A COMPANY
 * assignment covers everything below it; narrower scopes must match the
 * chain's ids exactly.
 */
export async function principalsByRoleCovering(
  tx: Tx,
  companyId: string,
  roleKey: string,
  chain: { headOfficeId?: string; projectId?: string; siteId?: string },
): Promise<string[]> {
  const rows = await tx.$queryRaw<{ principalid: string }[]>`
    SELECT DISTINCT ra."principalId" AS principalid
    FROM "RoleAssignment" ra
    JOIN "Role" r ON r."id" = ra."roleId" AND r."companyId" = ra."companyId"
    WHERE ra."companyId" = ${companyId}::uuid
      AND r."key" = ${roleKey}
      AND ra."revokedAt" IS NULL
      AND (ra."effectiveFrom" IS NULL OR ra."effectiveFrom" <= now())
      AND (ra."effectiveTo" IS NULL OR ra."effectiveTo" > now())
      AND (
        ra."scopeType" = 'COMPANY'
        OR (ra."scopeType" = 'HEAD_OFFICE' AND ra."headOfficeId" = ${chain.headOfficeId ?? null}::uuid)
        OR (ra."scopeType" = 'PROJECT' AND ra."projectId" = ${chain.projectId ?? null}::uuid)
        OR (ra."scopeType" = 'SITE' AND ra."siteId" = ${chain.siteId ?? null}::uuid)
      )`;
  return rows.map((r) => r.principalid);
}

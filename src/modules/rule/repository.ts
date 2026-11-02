import type { PrismaClient, Rule, RuleStatus, RuleVersion } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { mapOrgWriteError } from '../organization/errors.js';
import {
  makeOrgRepos,
  scopedUpdate,
  type AuditRepository,
  type OrgRepos,
} from '../organization/repository.js';
import type { OperationRepository } from '../operation/repository.js';
import { makeOperationRepos } from '../operation/repository.js';
import type { DepartmentRepository } from '../department/repository.js';

type Tx = Prisma.TransactionClient;

export interface RuleRepository {
  findById(companyId: string, id: string): Promise<Rule | null>;
  list(companyId: string, filter?: { status?: RuleStatus; operationId?: string }): Promise<Rule[]>;
  create(
    companyId: string,
    operationId: string,
    data: {
      key: string;
      name: string;
      description?: string;
      definition?: Prisma.InputJsonValue;
    },
  ): Promise<Rule>;
  update(
    companyId: string,
    id: string,
    data: Record<string, unknown>,
    expectedVersion?: number,
  ): Promise<Rule>;
  updateForPublish(
    companyId: string,
    id: string,
    latestRevision: number,
    currentVersionId: string,
    expectedVersion?: number,
  ): Promise<Rule>;
}

// Append-only: no update or delete methods by design.
export interface RuleVersionRepository {
  create(data: {
    companyId: string;
    ruleId: string;
    revision: number;
    definition: Prisma.InputJsonValue;
    publishedByPrincipalId?: string;
  }): Promise<RuleVersion>;
  list(companyId: string, ruleId: string): Promise<RuleVersion[]>;
}

// Publish-time binding: a referenced FormVersion must exist in the company,
// belong to the same operation, and declare the referenced field key/type.
export interface FormVersionFieldQuery {
  /** Returns {operationId, fieldType} for the (version, fieldKey) — nulls when absent. */
  findField(
    companyId: string,
    formVersionId: string,
    fieldKey: string,
  ): Promise<{ operationId: string | null; fieldType: string | null }>;
}

export interface RuleRepos {
  rules: RuleRepository;
  ruleVersions: RuleVersionRepository;
  formVersions: FormVersionFieldQuery;
  operations: OperationRepository;
  departments: DepartmentRepository;
  audit: AuditRepository;
}

export interface RuleUnitOfWork {
  run<T>(fn: (repos: RuleRepos) => Promise<T>): Promise<T>;
}

function extractFieldType(schema: unknown, fieldKey: string): string | null {
  const fields = (schema as { fields?: unknown[] } | null)?.fields;
  if (!Array.isArray(fields)) return null;
  for (const f of fields) {
    const rec = f as { key?: unknown; type?: unknown };
    if (rec.key === fieldKey) return typeof rec.type === 'string' ? rec.type : null;
  }
  return null;
}

export function makeRuleRepos(tx: Tx): RuleRepos {
  const org: OrgRepos = makeOrgRepos(tx);
  const ops = makeOperationRepos(tx);
  return {
    departments: ops.departments,
    operations: ops.operations,
    audit: org.audit,
    rules: {
      findById: (companyId, id) => tx.rule.findFirst({ where: { id, companyId } }),
      list: (companyId, filter) =>
        tx.rule.findMany({
          where: {
            companyId,
            ...(filter?.status ? { status: filter.status } : {}),
            ...(filter?.operationId ? { operationId: filter.operationId } : {}),
          },
          orderBy: { id: 'asc' },
        }),
      create: async (companyId, operationId, data) => {
        try {
          return await tx.rule.create({ data: { ...data, companyId, operationId } });
        } catch (error) {
          mapOrgWriteError(error, 'RULE');
        }
      },
      update: (companyId, id, data, expectedVersion) =>
        scopedUpdate(
          'RULE',
          { id, companyId },
          data,
          expectedVersion,
          (args) => tx.rule.updateMany(args),
          () => tx.rule.findFirst({ where: { id, companyId } }),
        ),
      updateForPublish: (companyId, id, latestRevision, currentVersionId, expectedVersion) =>
        scopedUpdate(
          'RULE',
          { id, companyId },
          { latestRevision, currentVersionId },
          expectedVersion,
          (args) => tx.rule.updateMany(args),
          () => tx.rule.findFirst({ where: { id, companyId } }),
        ),
    },
    ruleVersions: {
      create: async (data) => {
        try {
          return await tx.ruleVersion.create({ data });
        } catch (error) {
          mapOrgWriteError(error, 'RULE_VERSION');
        }
      },
      list: (companyId, ruleId) =>
        tx.ruleVersion.findMany({
          where: { companyId, ruleId },
          orderBy: { revision: 'asc' },
        }),
    },
    formVersions: {
      findField: async (companyId, formVersionId, fieldKey) => {
        const row = await tx.formVersion.findFirst({
          where: { id: formVersionId, companyId },
          select: { schema: true, form: { select: { operationId: true } } },
        });
        return {
          operationId: row?.form.operationId ?? null,
          fieldType: row === null ? null : extractFieldType(row.schema, fieldKey),
        };
      },
    },
  };
}

export class PrismaRuleUnitOfWork implements RuleUnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}

  run<T>(fn: (repos: RuleRepos) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(makeRuleRepos(tx)));
  }
}

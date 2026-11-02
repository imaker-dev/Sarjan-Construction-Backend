import type { Department, Operation, Rule, RuleVersion } from '@prisma/client';
import type { RuleRepos, RuleUnitOfWork } from '../../../src/modules/rule/repository.js';
import type { AuditRecord } from '../../../src/modules/organization/types.js';
import {
  DuplicateCodeError,
  VersionConflictError,
} from '../../../src/modules/organization/errors.js';
import { FakeAuthorizer, fakeDepartment } from '../department/fakes.js';
import { fakeOperation } from '../operation/fakes.js';

export { FakeAuthorizer, fakeDepartment, fakeOperation };

export interface RuleStore {
  departments: Department[];
  operations: Operation[];
  formVersionFields: {
    id: string;
    companyId: string;
    operationId: string;
    fields: Map<string, string>; // fieldKey -> declared type
  }[];
  rules: Rule[];
  ruleVersions: RuleVersion[];
  auditLog: AuditRecord[];
}

export function emptyRuleStore(): RuleStore {
  return {
    departments: [],
    operations: [],
    formVersionFields: [],
    rules: [],
    ruleVersions: [],
    auditLog: [],
  };
}

let nextId = 0;
const genId = () => `rule-id-${++nextId}`;

export function fakeRule(over: Partial<Rule> = {}): Rule {
  return {
    id: genId(),
    companyId: 'c1',
    operationId: 'op1',
    key: 'CHK',
    name: 'Check Rule',
    description: null,
    definition: null,
    status: 'DRAFT',
    latestRevision: 0,
    currentVersionId: null,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

export function makeRuleRepos(store: RuleStore): RuleRepos {
  return {
    departments: {
      findById: async (companyId, id) => {
        const row = store.departments.find((d) => d.id === id && d.companyId === companyId);
        return row ? { ...row } : null;
      },
      list: async () => [],
      create: async () => store.departments[0] as never,
      update: async () => store.departments[0] as never,
    },
    operations: {
      findById: async (companyId, id) => {
        const row = store.operations.find((o) => o.id === id && o.companyId === companyId);
        return row ? { ...row } : null;
      },
      list: async () => [],
      create: async () => store.operations[0] as never,
      update: async () => store.operations[0] as never,
      updateForPublish: async () => store.operations[0] as never,
    },
    rules: {
      findById: async (companyId, id) => {
        const row = store.rules.find((r) => r.id === id && r.companyId === companyId);
        return row ? { ...row } : null;
      },
      list: async (companyId, filter) =>
        store.rules
          .filter(
            (r) =>
              r.companyId === companyId &&
              (filter?.status === undefined || r.status === filter.status) &&
              (filter?.operationId === undefined || r.operationId === filter.operationId),
          )
          .map((r) => ({ ...r })),
      create: async (companyId, operationId, data) => {
        if (
          store.rules.some(
            (r) => r.companyId === companyId && r.operationId === operationId && r.key === data.key,
          )
        ) {
          throw new DuplicateCodeError('RULE');
        }
        const rule: Rule = {
          id: genId(),
          companyId,
          operationId,
          key: data.key,
          name: data.name,
          description: data.description ?? null,
          definition: (data.definition ?? null) as Rule['definition'],
          status: 'DRAFT',
          latestRevision: 0,
          currentVersionId: null,
          version: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        store.rules.push(rule);
        return { ...rule };
      },
      update: async (companyId, id, data, expectedVersion) => {
        const rule = store.rules.find((r) => r.id === id && r.companyId === companyId);
        if (!rule) throw new VersionConflictError('RULE');
        if (expectedVersion !== undefined && rule.version !== expectedVersion) {
          throw new VersionConflictError('RULE');
        }
        Object.assign(rule, data);
        rule.version += 1;
        return { ...rule };
      },
      updateForPublish: async (
        companyId,
        id,
        latestRevision,
        currentVersionId,
        expectedVersion,
      ) => {
        const rule = store.rules.find((r) => r.id === id && r.companyId === companyId);
        if (!rule) throw new VersionConflictError('RULE');
        if (expectedVersion !== undefined && rule.version !== expectedVersion) {
          throw new VersionConflictError('RULE');
        }
        rule.latestRevision = latestRevision;
        rule.currentVersionId = currentVersionId;
        rule.version += 1;
        return { ...rule };
      },
    },
    ruleVersions: {
      create: async (data) => {
        const v: RuleVersion = {
          id: genId(),
          companyId: data.companyId,
          ruleId: data.ruleId,
          revision: data.revision,
          definition: data.definition as RuleVersion['definition'],
          publishedAt: new Date(),
          publishedByPrincipalId: data.publishedByPrincipalId ?? null,
          createdAt: new Date(),
        };
        store.ruleVersions.push(v);
        return v;
      },
      list: async (companyId, ruleId) =>
        store.ruleVersions.filter((v) => v.companyId === companyId && v.ruleId === ruleId),
    },
    formVersions: {
      findField: async (companyId, formVersionId, fieldKey) => {
        const row = store.formVersionFields.find(
          (f) => f.id === formVersionId && f.companyId === companyId,
        );
        return {
          operationId: row?.operationId ?? null,
          fieldType: row?.fields.get(fieldKey) ?? null,
        };
      },
    },
    audit: {
      record: async (entry) => {
        store.auditLog.push(entry);
      },
    },
  };
}

export class FakeRuleUoW implements RuleUnitOfWork {
  constructor(public readonly store: RuleStore) {}

  async run<T>(fn: (repos: RuleRepos) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.store);
    try {
      return await fn(makeRuleRepos(this.store));
    } catch (error) {
      Object.assign(this.store, structuredClone(snapshot));
      throw error;
    }
  }
}

import { describe, it, expect } from 'vitest';
import { PERMISSIONS } from '../../../src/modules/access-control/catalogue.js';
import {
  TENANT_ROLE_TEMPLATES,
  FINANCE_API_PERMISSIONS,
  FINANCE_STAFF_API_PERMISSIONS,
} from '../../../src/modules/setup/role-templates.js';
import { RECONCILE_KEYS } from '../../../src/modules/setup/reconcile.js';
import { TENANT_OWNER_PERMISSIONS } from '../../../src/modules/setup/bootstrap.js';

const CATALOGUE = new Set<string>(PERMISSIONS);
const FINANCE_KEYS = [...PERMISSIONS].filter((k) => k.startsWith('FINANCE_'));

const template = (key: string) => {
  const tpl = TENANT_ROLE_TEMPLATES.find((t) => t.key === key);
  if (tpl === undefined) throw new Error(`template ${key} missing`);
  return tpl;
};

describe('Finance permission provisioning', () => {
  it('every FINANCE_* template/reconcile key exists in the permission catalogue', () => {
    for (const key of [...FINANCE_API_PERMISSIONS, ...FINANCE_STAFF_API_PERMISSIONS]) {
      expect(CATALOGUE.has(key), `catalogue missing ${key}`).toBe(true);
    }
    for (const key of RECONCILE_KEYS) {
      expect(CATALOGUE.has(key), `catalogue missing reconcile key ${key}`).toBe(true);
    }
  });

  it('no template key collides with an operation-catalogue key namespace', () => {
    // API keys are FINANCE_*; operation keys like EMPLOYEE_PAYROLL_PREPARE and
    // PURCHASE_PAYMENT_PROCESS must never appear in the API permission layer.
    for (const tpl of TENANT_ROLE_TEMPLATES) {
      for (const key of tpl.permissions) {
        expect(key).not.toBe('EMPLOYEE_PAYROLL_PREPARE');
        expect(key).not.toBe('PURCHASE_PAYMENT_PROCESS');
        expect(CATALOGUE.has(key)).toBe(true);
      }
    }
  });

  it('FINANCE_MANAGER holds the full Finance API surface incl. sensitive tiers', () => {
    const perms = new Set(template('FINANCE_MANAGER').permissions);
    for (const key of FINANCE_KEYS) {
      expect(perms.has(key), `FINANCE_MANAGER missing ${key}`).toBe(true);
    }
  });

  it('FINANCE_STAFF is least-privilege: no payroll, sensitive, budget-manage, export', () => {
    const perms = new Set(template('FINANCE_STAFF').permissions);
    // Day-to-day finance work is present.
    for (const key of [
      'FINANCE_DASHBOARD_READ',
      'FINANCE_PORTFOLIO_READ',
      'FINANCE_EMPLOYEE_READ',
      'FINANCE_BUDGET_READ',
      'FINANCE_WALLET_READ',
      'FINANCE_WALLET_MANAGE',
      'FINANCE_QUOTATION_MANAGE',
      'FINANCE_BILLING_MANAGE',
      'FINANCE_REPORT_READ',
    ]) {
      expect(perms.has(key), `FINANCE_STAFF missing ${key}`).toBe(true);
    }
    // Explicitly withheld — manager/owner tiers only.
    for (const key of [
      'FINANCE_EMPLOYEE_SENSITIVE_READ',
      'FINANCE_PAYROLL_READ',
      'FINANCE_PAYROLL_MANAGE',
      'FINANCE_BUDGET_MANAGE',
      'FINANCE_REPORT_EXPORT',
    ]) {
      expect(perms.has(key), `FINANCE_STAFF should not hold ${key}`).toBe(false);
    }
    // Staff still need approval-decide for their assignee-scoped tasks.
    expect(perms.has('WORKFLOW_APPROVAL_DECIDE')).toBe(true);
  });

  it('RECONCILE_KEYS grants the whole Finance surface to COMPANY_OWNER', () => {
    for (const key of FINANCE_KEYS) {
      expect(RECONCILE_KEYS, `owner reconcile missing ${key}`).toContain(key);
    }
    // All reconcile keys are real catalogue permissions.
    expect(FINANCE_KEYS.length).toBe(16);
  });

  it('new-company onboarding grants the same Finance keys as reconcile — one shared list', () => {
    // TENANT_OWNER_PERMISSIONS is the COMPANY_OWNER keyset written at company
    // creation; it must carry the identical finance surface, not a stale copy.
    for (const key of FINANCE_API_PERMISSIONS) {
      expect(TENANT_OWNER_PERMISSIONS, `onboarding owner missing ${key}`).toContain(key);
      expect(RECONCILE_KEYS, `reconcile owner missing ${key}`).toContain(key);
    }
    // Both draw from the canonical list — no second source can drift.
    const ownerFinance = TENANT_OWNER_PERMISSIONS.filter((k) => k.startsWith('FINANCE_'));
    const reconcileFinance = RECONCILE_KEYS.filter((k) => k.startsWith('FINANCE_'));
    expect(new Set(ownerFinance)).toEqual(new Set(FINANCE_API_PERMISSIONS));
    expect(new Set(reconcileFinance)).toEqual(new Set(FINANCE_API_PERMISSIONS));
  });

  it('finance templates are tenant-scoped — no platform keys anywhere', () => {
    for (const key of ['FINANCE_MANAGER', 'FINANCE_STAFF']) {
      expect(template(key).scopeShape).toBe('COMPANY');
    }
    // No platform keys leak into any tenant template.
    for (const tpl of TENANT_ROLE_TEMPLATES) {
      for (const key of tpl.permissions) {
        expect(key.startsWith('PLATFORM_')).toBe(false);
      }
    }
  });
});

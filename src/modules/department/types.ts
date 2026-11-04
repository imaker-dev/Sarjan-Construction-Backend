import type { DepartmentCategory } from '@prisma/client';
// Departments support only these scopes (HEAD_OFFICE is rejected).
export type DepartmentScopeType = 'COMPANY' | 'PROJECT' | 'SITE';

export interface CreateDepartmentInput {
  scopeType: DepartmentScopeType;
  // Required for PROJECT/SITE scopes; ignored (must be absent) for COMPANY.
  scopeId?: string;
  code: string;
  name: string;
  category?: DepartmentCategory; // API requires it; service defaults CUSTOM
  categoryLabel?: string;
  capabilityKey?: string;
  headEmployeeId?: string;
  // Physical location only — never a permission scope.
  baseHeadOfficeId?: string;
}

export interface UpdateDepartmentInput {
  name?: string;
  capabilityKey?: string | null;
  headEmployeeId?: string | null;
  baseHeadOfficeId?: string | null;
}

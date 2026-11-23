# Operation Access — Catalogue Metadata, Inheritance & Inspection

How business-operation authorization works after the access-hardening change:
what the catalogue metadata means, the exact effective-operation rules, and the
project/site inspection endpoints.

## Catalogue metadata (`OperationCatalogueEntry`)

| Field                   | Meaning                                                                                                                                                                                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sensitive`             | Never inheritable by roles; requires dept enablement + direct grant.                                                                                                                                                                                                                                  |
| `appliesTo`             | Department scopes the operation may be enabled on (`COMPANY`, `HEAD_OFFICE`, `PROJECT`, `SITE`). Enabling an op on a dept whose `scopeType` is not listed is rejected with a validation error.                                                                                                        |
| `leadershipInheritable` | Whether PROJECT-scoped `PROJECT_DIRECTOR` / `PROJECT_INCHARGE` assignments inherit the op from departments under their projects/sites. **Defaults `false`** — only explicitly reviewed, project-relevant ops are `true`. Approval, payment, payroll, and other high-impact ops are never inheritable. |

New catalogue rows default to `appliesTo=[COMPANY]`, `leadershipInheritable=false`.
Eligibility is never inferred from key prefixes, domain names, or
`sensitive=false`. Migration `20261130000000_operation_scope_metadata` holds the
explicit reviewed backfill.

Platform admin create:

```http
POST /api/v1/platform/operations
{
  "key": "SITE_RISK_REGISTER",
  "domain": "SAFETY",
  "name": "Site risk register",
  "appliesTo": ["COMPANY", "HEAD_OFFICE", "PROJECT", "SITE"],
  "leadershipInheritable": true
}
```

`leadershipInheritable: true` combined with `sensitive: true` is rejected.

## Effective-operation rules

`getEffectiveOperations(companyId, employeeId)` returns the union of:

1. **DEPARTMENT** — `ACTIVE` ops on `ACTIVE` departments where the employee
   holds an open membership (`endedAt IS NULL`), minus `INACTIVE`/`REVOKED`
   employee overrides.
2. **DIRECT** — `ACTIVE` `EmployeeOperation` rows **only while dept-backed**:
   the op must still be enabled on an ACTIVE department the employee belongs
   to. A direct row alone grants nothing — ending the membership, disabling
   the dept op, or deactivating the dept removes access on the next check.
3. **ROLE** — live-resolved coverage, minus overrides:
   - _PD/PI_: ops that are `ACTIVE`-enabled on ACTIVE departments scoped to
     the assigned project(s) or their child sites, **and** marked
     `leadershipInheritable`, non-sensitive, and valid for that dept's scope.
     A project assignment covers child sites, never another project. A PD may
     hold assignments on multiple projects. Revocation takes effect on the
     next check.
   - _Finance roles_: unchanged — non-sensitive ops in
     `FINANCE_OPERATION_DOMAINS` + `PROJECT_DASHBOARD_VIEW`.

**Direct-grant admission** (`POST /employees/:id/operations` and toggling a
grant `ACTIVE`): requires an active same-company employee with an open
membership in an ACTIVE department that has the op `ACTIVE`-enabled **and**
valid for that dept's `scopeType`. There is no override bypass — leadership
coverage is the separate approved path for PD/PI.

## Authorization of configuration routes

Department/employee operation routes authorize at `COMPANY` scope
(`OPERATION_CONFIGURE`, `OPERATION_EMPLOYEE_ASSIGN`, `OPERATION_READ` for the
catalogue). Only COMPANY-scoped role templates (e.g. `DEPT_HEAD`,
`COMPANY_OWNER`) carry these grants; `HO_ADMIN`, `PROJECT_MANAGER`, and other
narrower templates intentionally do not — a HEAD_OFFICE/PROJECT-scoped grant
could never cover a COMPANY-scope check. `OPERATION_READ` remains on scoped
templates because it is also enforced at department scope for
operation-definition reads.

## Inspection endpoints

```
GET /api/v1/org/projects/{id}/effective-operations?cursor=&limit=
GET /api/v1/org/sites/{id}/effective-operations?cursor=&limit=
```

- `ORG_PROJECT_READ` / `ORG_SITE_READ` at the requested scope; same-company
  parent check (unknown/cross-company scope → 404).
- Project view: departments scoped to the project **or its sites** + PD/PI
  leadership coverage on that project.
- Site view: departments scoped to the site + PD/PI coverage inherited from
  the parent project.
- Keyset pagination on `(employeeId, operationKey)`; `limit` 1–200
  (default 50). Pass `nextCursor` back as `cursor`.

Item shape:

```json
{
  "employeeId": "…",
  "employeeCode": "EMP-1",
  "displayName": "…",
  "operationKey": "DAILY_SITE_REPORT_SUBMIT",
  "name": "Daily Site Report",
  "domain": "PROJECT_REPORTS",
  "sensitive": false,
  "leadershipInheritable": true,
  "source": "ROLE",
  "inherited": true,
  "department": { "id": "…", "code": "S1", "name": "Site 1 Dept", "scopeType": "SITE" },
  "roleAssignment": {
    "id": "…",
    "roleKey": "PROJECT_DIRECTOR",
    "scopeType": "PROJECT",
    "projectId": "…"
  }
}
```

`source` is `DEPARTMENT` (inherited via membership), `DIRECT` (explicit
dept-backed grant), or `ROLE` (PD/PI coverage). Only safe identity fields are
returned; no contact details, no cross-project rows.

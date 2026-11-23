# Project Incharge (PI) — Complete Work & System Scope

> **Authoritative scope spec for all future PI API work.** When designing or
> implementing PI-facing endpoints, read this first and map every capability
> to the five independent controls in §0. See the **Repository Mapping**
> appendix at the bottom for what already exists vs. what is pending.

The PI is the day-to-day operational lead for their assigned project and its
sites. They coordinate site departments and employees, plan work, review
submissions, manage site requests, and keep the PD informed.

The PI can be given broad authority over project execution, but approval
authority should still follow configured limits. For example, the PI may
approve a routine site task or expense within a company-set limit, while a
larger quotation or wallet top-up goes to the PD or Finance. **The PI should
not approve their own request.**

## 0. Composition rule (binding)

PI access = **project assignment + department placement + assigned operations

- API permissions + approval limits.** These are five separate controls.

A PI role must not automatically grant every finance, HR, or company
administration action — and a role assignment alone must never silently
bypass the operation policy.

## 1. Project and site control

The PI should be able to:

- View the projects and sites assigned to them.
- Create sites under their assigned project, **if the company has enabled
  that authority** (delegated capability, off by default).
- Update site details, contacts, operating status, and site records.
- View project scope, drawings, specifications, milestones, target dates,
  and instructions.
- Record site constraints, delays, risks, and decisions needed.
- Coordinate work across all departments at their sites.
- Escalate changes to scope, budget, schedule, or contract to the PD.

**Boundary:** a PI sees and acts only within their assigned project(s).
Assignment to one project never grants access to another.

## 2. Site departments and employees

- Create or request site departments (Site Engineering, Safety, Quality,
  Stores, Administration).
- Set department name/category, site, department head, and active status.
- Add employees or invite them to join a site, **if onboarding is delegated**.
- Assign employees to site departments and designate department heads.
- View employee work profiles, department placement, project/site assignment.
- Request employee transfer, replacement, onboarding, or deactivation.
- Assign operational tasks to departments or specific employees.

**Excluded by default:** employee login access, sensitive HR details,
salary/bank information, company-wide personnel changes — separate
permissions.

## 3. Task creation and work tracking

The PI can create tasks for any department in their project or site.

**Task fields:** title, description; project + site + department; assigned
employee/team; priority + due date; planned start/completion; related
milestone/drawing/document/work item; required evidence or checklist;
dependencies and blockers; status + completion notes.

**Lifecycle:**

```
Draft → Assigned → In progress → Submitted for review → Approved | Returned → Closed
```

- PI reviews submissions: approve / reject (reason required) / return
  (must identify what needs correction and who acts next).
- Approval records preserve reviewer, timestamp, decision, comments.

## 4. Weekly, monthly, and forward planning

Plans the PI manages: weekly work plan; monthly project/site plan;
next-month forecast; planned labour & department capacity; materials,
equipment, subcontractor requirements; milestones & target quantities;
planned expenses & cash requirements; risks, dependencies, expected delays.

- Each plan: period, version, owner, status, approval history.
- PI drafts/revises; **PD reviews** — approve / return / reject per policy.
- Approved plans remain as **snapshots** — later edits never rewrite history.

## 5. Site attendance and workforce

- View attendance totals and exceptions for assigned sites.
- See present / absent / late / on-leave / correction-pending.
- Review attendance corrections submitted by employees or supervisors.
- Track overtime and site-wise workforce availability.
- Compare planned staffing vs actual attendance.
- Escalate missing workers or attendance issues.

Attendance rules (shift times, holidays, overtime, leave balances, approval
chains) come from company-configured attendance policies. The PI cannot
silently alter historical punches or approved records.

## 6. Site wallet and petty cash

Recommended flow:

1. PI submits wallet top-up request: amount, purpose, site, period,
   supporting documents.
2. Request follows the configured review/approval workflow.
3. Finance processes the approved credit into the ledger.
4. PI confirms receipt of the credited amount.
5. Site expenses submitted with category, date, amount, vendor/payee,
   purpose, receipts.
6. Authorized reviewer checks the expense; Finance reconciles vs ledger.

PI can view: current available balance; pending credits & expense claims;
credits, debits, reversals, adjustments; transaction date, reference,
amount, category, requester, approver, supporting documents; reconciliation
status and discrepancies.

**Ledger is append-only** — corrections are reversals/adjustments, never
edits or deletes. Balance is computed from ledger entries.

## 7. Expenses and cash forecasts

- Current expenses and submitted claims; weekly/monthly expense plans;
  forecasts for next month / future periods.
- Budget-vs-actual summaries; categories, site, department, vendor,
  supporting documents; pending approvals, rejected claims, reconciliation
  issues.
- PI prepares and submits expense plans/claims. Approval thresholds and
  final payment authority stay configured by Finance/company policy.
- **A forecast is not a payment approval**; an expense request does not
  itself change the wallet balance.

## 8. Quotations and procurement requests

- Raise RFQ: scope, quantities, specifications, delivery site, required date.
- Attach drawings, BOQ, or supporting files.
- Compare submitted quotations; record technical comments.
- Recommend a vendor or quotation for review.
- Track revision, approval, issue, and expiry status.

PI prepares or technically reviews. **PD approves or returns** — PD remarks
optional in the current version; the system must still record the decision.
Finance/procurement retain commercial, budget, and payment checks.

## 9. Milestones and project workflow

- Create/update milestone plans where permitted; assign milestone work to
  departments and employees.
- Track planned vs actual dates, completion %, dependencies.
- Submit milestone completion with evidence.
- Review department submissions: accept / return / reject.
- Escalate milestone delays or scope changes to the PD.
- View approval status and workflow history.

**A milestone is never complete just because its date passed** — completion
requires a recorded submission plus an authorized review decision.

## 10. Reports and P&L visibility

Project/site reports allowed by assignment: daily/weekly progress; milestone
status & delays; attendance/workforce summaries; department task completion;
material & equipment requests; safety & quality issues; wallet ledger &
expense summaries; budget vs submitted/approved expenses; quotation &
procurement status; forecasts & risks; project cost summaries and
management P&L views.

**P&L shown before a defined accounting/cost-recognition model exists must
be labeled "management estimate"** — showing calculation basis and period,
never implying audited or statutory accounting.

## 11. Logs, approvals, and documents

Project-scoped activity history for the PI: department & employee changes;
task assignment & review decisions; plan submissions & approvals; wallet
requests, credits, confirmations, expenses; quotation revisions & decisions;
milestone submissions; attendance corrections; document uploads, links,
status changes.

"Access every log" = all relevant logs **within the PI's assigned
project/site scope**. Company-wide identity, security, payroll, or other
project logs need separate authority. Log entries show actor, action,
entity, time, result, and before/after detail — while protecting passwords,
tokens, bank details, and other secrets.

## 12. PI vs PD vs Finance

| Area                   | PI                                             | Project Director                  | Finance                                    |
| ---------------------- | ---------------------------------------------- | --------------------------------- | ------------------------------------------ |
| Daily site work        | Plans and coordinates                          | Oversees across assigned projects | —                                          |
| Site departments/tasks | Creates or manages within delegated scope      | Reviews higher-level changes      | —                                          |
| Employee placement     | Manages site placement if authorized           | Oversees project staffing         | Finance employee records only as permitted |
| Weekly/monthly plans   | Prepares and tracks                            | Reviews/approves by policy        | Reviews financial forecasts where needed   |
| Wallet                 | Requests funds, views ledger, confirms receipt | Approves above delegated limits   | Processes credits and reconciles           |
| Expenses               | Submits and reviews within delegation          | Approves above PI limit           | Verifies and processes payment             |
| Quotations             | Prepares and performs technical review         | Approves as configured            | Performs commercial/budget checks          |
| Payroll and banking    | No default access                              | No default access                 | Restricted to authorized Finance users     |

This gives the PI broad control over site execution while keeping financial
disbursement, payroll, sensitive employee data, and cross-project access
appropriately governed.

---

## Appendix — Repository mapping (verified 2026-11-29)

| PI capability                                                                       | Status in repo                              | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PI role template (`PROJECT` scope, one holder/project)                              | ✅ exists                                   | `role-templates.ts` → `PROJECT_INCHARGE_PERMISSIONS`; grant via `POST /employees/:id/assignments`                                                                                                                                                                                                                                                                                                                                                                |
| Project-scoped operation coverage (non-sensitive ops enabled on project/site depts) | ✅ exists                                   | `OperationAssignmentService.getLeadershipScopedOperationKeys` — live-resolved, revocable, `source:'ROLE'`                                                                                                                                                                                                                                                                                                                                                        |
| View own projects/sites                                                             | ✅ exists                                   | `GET /org/projects/:id`, `GET /org/sites/:id` at PROJECT/SITE scope                                                                                                                                                                                                                                                                                                                                                                                              |
| Project/site document register (upload, link, review)                               | ✅ exists                                   | `/org/projects/:id/documents*`, `/org/sites/:id/documents*` — `DOCUMENT_*` @ scope                                                                                                                                                                                                                                                                                                                                                                               |
| Site attendance + corrections                                                       | ⚠️ partial                                  | `attendance` module + PI/PD `ATTENDANCE_*` template keys exist, but attendance routes still gate at COMPANY scope — scoped PI/PD holders are denied; scoped route targets are a later milestone                                                                                                                                                                                                                                                                  |
| Budgets + cash-flow forecasts                                                       | ✅ exists (read/plan side)                  | `finance` module budgets, forecasts; PI needs explicit ops for access                                                                                                                                                                                                                                                                                                                                                                                            |
| Wallet / petty-cash ledger                                                          | ⏳ catalogue ops seeded, **module pending** | `PETTY_CASH_REQUEST_*`, `PROJECT_WALLET_*` keys exist in `OperationCatalogueEntry`; no routes yet                                                                                                                                                                                                                                                                                                                                                                |
| Quotation / RFQ flow                                                                | ⏳ catalogue ops seeded, **module pending** | `*_QUOTATION_*` keys exist; no routes yet                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Task creation & work tracking                                                       | ❌ pending                                  | no task module                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Weekly/monthly/forward plans                                                        | ❌ pending                                  | no plan module (approval/workflow engine exists to reuse)                                                                                                                                                                                                                                                                                                                                                                                                        |
| Milestone register & reviews                                                        | ❌ pending                                  | scalar project dates only; no `ProjectMilestone` model                                                                                                                                                                                                                                                                                                                                                                                                           |
| Delegated site creation / dept creation by PI                                       | ✅ done (M2)                                | `CompanyDelegationPolicy` (`siteCreate`/`siteUpdate`/`deptManage`, default off) gates `ORG_SITE_*`/`DEPARTMENT_CONFIGURE` at project/site scope — `GET/PATCH /org/company/delegations`                                                                                                                                                                                                                                                                           |
| Site dept/employee placement by PI                                                  | ✅ done (M3/W2)                             | `EMPLOYEE_MEMBER_MANAGE` @ scope + `placement` delegation flag; `POST/PATCH /departments/:id/members[/:mid]`, `POST …/end`, `POST …/transfer` — atomic transfer, `PRIMARY_OUT_OF_SCOPE`/`AMBIGUOUS_PRIMARY` 409s, server-set `endedAt`, head auto-clear, `GET /departments?projectId=/siteId=` scoped filter                                                                                                                                                     |
| Site workforce onboarding by PI/PD                                                  | ✅ done (W3)                                | `EMPLOYEE_ONBOARD` @ scope + `employeeOnboard` delegation flag; `POST /departments/:id/onboard` — atomic profile (`principalId` null, no login/invite/role/op) + initial primary membership + optional company-document links, `EMPLOYEE_ONBOARDED` audit; `GET /departments/:id/members/:mid` scoped contact read-back                                                                                                                                          |
| Site workforce suspend / exit / reinstate by PI/PD                                  | ✅ done (W4)                                | `EMPLOYEE_MEMBER_MANAGE` @ scope + `memberSuspend`/`memberExit` delegation flags; `POST /org/{sites,projects}/:id/workforce/:employeeId/{suspend,exit,reinstate}` — append-only `SUSPENDED`/`EXITED` end reasons + `SiteWorkforceExit` marker blocks reinstate, supersession-linked reinstate rows, all-or-nothing restore, `AMBIGUOUS_PRIMARY`/`ALREADY_EXITED` 409s, head auto-clear, `hasActiveAtSite` punch gate; company-wide admin paths bypass delegation |
| Project/site workforce directory                                                    | ✅ done (W1)                                | `GET /org/projects/:id/team`, `GET /org/sites/:id/team` (`EMPLOYEE_READ` @ scope), `GET /departments/:id/members` (`DEPARTMENT_READ` @ dept scope) — safe-field projection, keyset paging, `includeEnded` history                                                                                                                                                                                                                                                |
| Expense claims & reconciliation                                                     | ❌ pending                                  | no expense module                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| P&L / management-estimate reports                                                   | ❌ pending                                  | finance dashboard/portfolio exists; no project P&L view                                                                                                                                                                                                                                                                                                                                                                                                          |
| PI-scoped activity log                                                              | ✅ done (M1)                                | `GET /org/projects/:id/activity`, `GET /org/sites/:id/activity` — trusted scope resolution, allowlist-redacted `changedFields`                                                                                                                                                                                                                                                                                                                                   |
| Approval/return/reject engine                                                       | ✅ reusable                                 | `approval` + `workflow-instance` modules                                                                                                                                                                                                                                                                                                                                                                                                                         |

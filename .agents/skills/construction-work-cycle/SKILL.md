---
name: construction-work-cycle
description: >-
  Construction ERP domain architecture, operational work cycles, and organizational invariants.
  Use when designing or authoring modules for organizational hierarchy (Company -> Project -> Site),
  multi-site concurrency, site fund isolation, workforce categories (A/B/C), muster verification,
  or site shift compliance.
---

# Construction Work Cycle & Architecture Guide

Derived from the client-approved architecture reference (`Construction_ERP_Architecture_RBAC_Documentation_Client_Review_v2.docx`).

---

## 1. Organizational Hierarchy & Concurrency

The system is organized into a fixed three-tier hierarchy:
```
Company (Head Office) ──► Single legal entity; master data, policy, fund release, roll-up audit
      │
      ▼
   Project            ──► Client engagement / contract; multiple concurrent projects per company
      │
      ▼
    Site              ──► Physical construction location; multiple concurrent sites per project
```

### Multi-Project / Multi-Site Concurrency Invariant
- Multiple projects and multiple sites operate **simultaneously in parallel**.
- Every transactional entity (`AttendanceSession`, `FundLedger`, `Expense`, `PurchaseOrder`, `StoreStock`, `SafetyTvtSession`) carries a mandatory `siteId` (and via it, `projectId` and `companyId`).
- Data isolation is **structural at the database level**, never a late client-side filter.
- Document numbers (e.g. `PO-001`, `MRR-001`, `EXP-001`) are scoped per site using site-code prefixes to prevent collisions across parallel sites.

---

## 2. Four Core Structural Invariants (Enforced in Code & Schema)

### 2.1 Site Fund Isolation
- Each site's fund is a closed ledger scoped strictly to that site.
- **No site-to-site fund transfer transaction exists.**
- Money only moves:
  - $\text{HO} \longrightarrow \text{Site}$ (Allocation / Imprest release)
  - $\text{Site} \longrightarrow \text{HO}$ (Return / Reconciliation)
- If two sites require funds, Head Office issues two distinct allocations.

### 2.2 Employee – Site Lock
- An active employee record carries **exactly one active site assignment**, never a list.
- There is no direct "reassign to another site" shortcut.
- Site transfer is modeled as: **Relieving from current site $\longrightarrow$ Onboarding at new site**. This preserves untainted historical auditing for payroll and site fund charges.

### 2.3 Per-Site HR Portal & Partitioning
- Attendance, muster roll, and labour compliance are partitioned strictly by site.
- Site personnel (Time Keeper, Site Admin, Site Engineer, PM) only see their assigned site's data.
- Head Office HR & MD view aggregated roll-up reports across all active projects and sites in real time without selecting or switching projects.

### 2.4 Dynamic Roles via Fixed Permission Templates
- Project Managers can create and name custom site roles tailored to site scale (e.g., "Senior Façade Engineer", "Batching Plant In-charge").
- Every created role **must map to a fixed permission template**:
  - `HO – admin` (company-wide master configuration)
  - `HO – approver` (company-wide approvals above site delegation limits)
  - `Site – approver` (approves indents, muster, and expenses within site delegation)
  - `Site – data entry` (raises indents, logs daily progress, records muster/stock)
  - `Site – read only` (dashboards, inspection, audits)
  - `External – limited` (subcontractor supervisor/mukadam: submits gang muster & measurements only)
  - `Site – functional access` (specialists covering 1–2 specific sites, e.g. QA/QC, Site Accountant, P&M)

---

## 3. Workforce Categories & Pay Cycles

Workers belong to one of three distinct operational categories:

| Cat | Category Name | Employer of Record | Paid By | Attendance Chain | Pay Cycle |
|---|---|---|---|---|---|
| **A** | **Company Staff** (PM, Engineers, QS, Store, Accounts, HSE) | Company | Company Payroll | Self-punch (Mobile/Web) $\rightarrow$ PM approval | Monthly (cut-off: month end; paid by 7th via bank transfer) |
| **B** | **Direct Site Labour** (Daily / weekly wage) | Company | Company (Site Cashier / HO) | Time Keeper logs muster $\rightarrow$ Site Eng countersigns $\rightarrow$ PM final check | Fortnightly (within 10 days of cut-off; bank transfer, cash by exception only) |
| **C** | **Subcontractor Labour** (Item-rate / piece-rate gangs) | Subcontractor | Subcontractor | Mukadam submits $\rightarrow$ Time Keeper verifies $\rightarrow$ PM final check | Against certified RA bill / work order terms |

> **Statutory Principal Employer Rule:** Category C workers are the legal compliance responsibility of the company. They must be registered, ID-carded, and tracked for statutory welfare with the same rigour as Categories A & B, even though the company does not pay them directly.

---

## 4. Construction Shift & Site Operating Rules

1. **Standard Shift Day:**
   - 9 hours on site with 1 hour rest = **8 productive working hours** (default: 08:00 – 17:00).
   - Adjustable per site by the Project Manager with Head–Projects approval.
2. **Weekly Off:**
   - Sundays are half-day; working requires Project Manager approval.
3. **Weekly Cap & Overtime:**
   - Regular working hours capped at **48 hours per week**.
   - Hours beyond 48 are overtime, compensated as paid leave/overtime with PM approval.
4. **Night Shift Invariant:**
   - Night shift requires: **Written PM approval + HSE safety clearance + Certified lux lighting levels**.
5. **Age & Compliance Gate:**
   - **Zero tolerance:** Strictly no person below 18 years of age is permitted on site under any category for any reason.
6. **Geofencing & Daily TVT:**
   - Geofencing enforced at site perimeter.
   - Mandatory morning Safety Toolbox Talk (TVT) logged before workers enter the work face.

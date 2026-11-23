# Head Office Admin & Finance — Daily Reporting & Settlement API Guide

Comprehensive integration reference for **Head Office Admin**, **Finance Managers**, and **Central ERP Administrators** managing Daily Site Reports (DSR), workforce attendance settlement, audit verification, and final payroll/billing locking across all company projects and sites.

---

## 1. Persona & Architectural Scope

In the Sarjan Construction ERP architecture, the **Head Office Admin / Finance Manager** operates at the central **Company / Head Office** scope. While Site Engineers and Project Managers manage day-to-day site operations, the Central Admin owns company-wide financial integrity, workforce audit compliance, and final payroll/billing locking.

### Role & Permission Mapping

| Persona | Role Template Key | Scope Shape | Required API Permissions |
|---|---|---|---|
| **Head Office Admin** | `HO_ADMIN` | `HEAD_OFFICE` / `COMPANY` | `ATTENDANCE_READ`, `ATTENDANCE_MANAGE` |
| **Finance Manager** | `FINANCE_MANAGER` | `COMPANY` | `ATTENDANCE_READ`, `ATTENDANCE_MANAGE` |
| **Company Owner** | `COMPANY_OWNER` | `COMPANY` | Super-admin access |

### Core Invariants

1. **Company-Wide Visibility**: Unlike Site Engineers (restricted to a single site) or Project Managers (restricted to a single project), Head Office Admin and Finance Managers can query, filter, and inspect daily reports across **all projects and sites**.
2. **Sequential Workflow Enforcement**:
   $$\text{DRAFT} \xrightarrow{\text{Submit (Site Eng)}} \text{SUBMITTED} \xrightarrow{\text{Approve (PM)}} \text{APPROVED} \xrightarrow{\text{Lock (HO Admin/Finance)}} \text{LOCKED}$$
3. **Immutability of LOCKED Reports**: Once a report is moved to `LOCKED` status by Head Office Admin/Finance, it is **strictly immutable**. No further edits, headcount adjustments, approvals, or rejections can be performed. It becomes the legal source of truth for:
   - Monthly staff and labour payroll disbursements.
   - Subcontractor (Cat C) work-order measurement and billing settlements.
   - Statutory compliance and safety muster audits.

---

## 2. API Authentication & Headers

Every request to tenant APIs requires:

```http
Authorization: Bearer <JWT_ACCESS_TOKEN>
x-company-id: <COMPANY_UUID>
Content-Type: application/json
```

- **Base URL**: `/api/v1`

---

## 3. Endpoints & Workflows for Central Admin

```
                             +----------------------------------------+
                             |  Central Admin Daily Reports Dashboard |
                             +----------------------------------------+
                                                 |
                       +-------------------------+-------------------------+
                       |                                                   |
                       v                                                   v
          [1. List & Filter Reports]                             [2. Trigger Recalculate]
          GET /attendance/daily-reports                          POST /attendance/daily-reports/calculate
                       |                                                   |
                       +-------------------------+-------------------------+
                                                 |
                                                 v
                                   [3. Inspect Report Details]
                                   GET /attendance/daily-reports/:id
                                                 |
                       +-------------------------+-------------------------+
                       |                                                   |
                       v                                                   v
        [4. View Audit Timeline]                               [5. Final Lock for Payroll]
        GET /attendance/daily-reports/:id/audit-trail           POST /attendance/daily-reports/:id/lock
```

---

### Workflow 1: Company-Wide Daily Reports Explorer

Central Admin needs to view reports across all sites, filter by date, project, or status (e.g. find all reports in `APPROVED` status ready to be locked).

#### `GET /api/v1/attendance/daily-reports`

**Permission Required**: `ATTENDANCE_READ` (at Company scope)

#### Query Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `siteId` | UUID | No | - | Filter by a specific construction site. |
| `status` | String | No | - | Filter by status: `DRAFT`, `SUBMITTED`, `APPROVED`, `REJECTED`, `LOCKED`. |
| `fromDate` | String (`YYYY-MM-DD`) | No | - | Start date of the business day range. |
| `toDate` | String (`YYYY-MM-DD`) | No | - | End date of the business day range. |
| `limit` | Integer (1–100) | No | 20 | Number of records per page. |
| `offset` | Integer ($\ge 0$) | No | 0 | Number of records to skip. |

#### Request Example (cURL)
```bash
curl -X GET "https://api.sarjan.com/api/v1/attendance/daily-reports?status=APPROVED&fromDate=2026-11-01&toDate=2026-11-21&limit=20&offset=0" \
  -H "Authorization: Bearer <token>" \
  -H "x-company-id: 00000000-0000-4000-8000-0000000000c1"
```

#### Response Example (`200 OK`)
```json
{
  "items": [
    {
      "id": "9a1d4f20-b389-4fa2-bca4-d89163b9e4a1",
      "companyId": "00000000-0000-4000-8000-0000000000c1",
      "projectId": "10000000-0000-4000-8000-000000000001",
      "siteId": "20000000-0000-4000-8000-000000000001",
      "businessDate": "2026-11-20",
      "status": "APPROVED",
      "weather": "CLEAR",
      "weatherStoppageHours": "0.00",
      "workProgressNotes": "Ground floor slab casting completed successfully.",
      "siteObstaclesRemarks": null,
      "safetyIncidentReported": false,
      "safetyNotes": "Toolbox Talk (TVT) conducted at 08:30 AM for all 45 workers.",
      "totalWorkersHeadcount": 45,
      "totalPresentUnits": "45.0",
      "totalOvertimeHours": "12.50",
      "totalOvertimePUnits": "0.0",
      "totalFlaggedSessions": 0,
      "catAStaffCount": 5,
      "catAStaffUnits": "5.0",
      "catBDirectCount": 20,
      "catBDirectUnits": "20.0",
      "catCSubconCount": 20,
      "catCSubconUnits": "20.0",
      "submittedById": "emp-supervisor-1",
      "submittedAt": "2026-11-20T18:30:00.000Z",
      "approvedById": "emp-pm-1",
      "approvedAt": "2026-11-20T20:15:00.000Z",
      "rejectionReason": null,
      "lockedById": null,
      "lockedAt": null,
      "version": 1,
      "createdAt": "2026-11-20T08:00:00.000Z",
      "updatedAt": "2026-11-20T20:15:00.000Z",
      "site": {
        "id": "20000000-0000-4000-8000-000000000001",
        "code": "SITE-A1",
        "name": "Tower A Construction"
      },
      "project": {
        "id": "10000000-0000-4000-8000-000000000001",
        "code": "PRJ-HIGHLAND",
        "name": "Highland Heights Commercial"
      }
    }
  ],
  "total": 1
}
```

---

### Workflow 2: Detailed Verification & Workforce Breakdown

Before locking, Central Admin inspects the complete labour breakdown (`DailySiteReportLabour`) separated into Category A (Company Staff), Category B (Direct Labour), and Category C (Subcontractors).

#### `GET /api/v1/attendance/daily-reports/:id`

**Permission Required**: `ATTENDANCE_READ`

#### Response Example (`200 OK`)
```json
{
  "id": "9a1d4f20-b389-4fa2-bca4-d89163b9e4a1",
  "companyId": "00000000-0000-4000-8000-0000000000c1",
  "projectId": "10000000-0000-4000-8000-000000000001",
  "siteId": "20000000-0000-4000-8000-000000000001",
  "businessDate": "2026-11-20",
  "status": "APPROVED",
  "weather": "CLEAR",
  "weatherStoppageHours": "0.00",
  "workProgressNotes": "Ground floor slab casting completed successfully.",
  "totalWorkersHeadcount": 45,
  "totalPresentUnits": "45.0",
  "totalOvertimeHours": "12.50",
  "catAStaffCount": 5,
  "catAStaffUnits": "5.0",
  "catBDirectCount": 20,
  "catBDirectUnits": "20.0",
  "catCSubconCount": 20,
  "catCSubconUnits": "20.0",
  "site": {
    "id": "20000000-0000-4000-8000-000000000001",
    "code": "SITE-A1",
    "name": "Tower A Construction"
  },
  "project": {
    "id": "10000000-0000-4000-8000-000000000001",
    "code": "PRJ-HIGHLAND",
    "name": "Highland Heights Commercial"
  },
  "submittedBy": {
    "id": "emp-supervisor-1",
    "employeeCode": "EMP-0042",
    "displayName": "Vikram Patel"
  },
  "approvedBy": {
    "id": "emp-pm-1",
    "employeeCode": "EMP-0010",
    "displayName": "Arjun Sharma (Project Manager)"
  },
  "lockedBy": null,
  "labourSummaries": [
    {
      "id": "labour-sum-01",
      "reportId": "9a1d4f20-b389-4fa2-bca4-d89163b9e4a1",
      "category": "CAT_A_STAFF",
      "subcontractorId": null,
      "subcontractorName": null,
      "tradeCategory": "ENGINEERING",
      "headcount": 5,
      "presentUnits": "5.0",
      "overtimeHours": "0.00",
      "remarks": "Site engineers and safety supervisors"
    },
    {
      "id": "labour-sum-02",
      "reportId": "9a1d4f20-b389-4fa2-bca4-d89163b9e4a1",
      "category": "CAT_B_DIRECT_LABOUR",
      "subcontractorId": null,
      "subcontractorName": null,
      "tradeCategory": "MASON",
      "headcount": 20,
      "presentUnits": "20.0",
      "overtimeHours": "7.50",
      "remarks": "Company direct roll masons"
    },
    {
      "id": "labour-sum-03",
      "reportId": "9a1d4f20-b389-4fa2-bca4-d89163b9e4a1",
      "category": "CAT_C_SUBCONTRACTOR",
      "subcontractorId": "subcon-0001",
      "subcontractorName": "Apex Shuttering Works LLP",
      "tradeCategory": "CARPENTER",
      "headcount": 20,
      "presentUnits": "20.0",
      "overtimeHours": "5.00",
      "remarks": "Centering and formwork gang"
    }
  ]
}
```

---

### Workflow 3: On-Demand Recalculation (Day Settlement)

Normally, the background cron executes auto-calculation at 8:00 AM daily rollover. However, if late biometric logs arrived from offline kiosks or supervisor regularizations occurred, Central Admin can trigger an on-demand recalculation:

#### `POST /api/v1/attendance/daily-reports/calculate`

**Permission Required**: `ATTENDANCE_MANAGE`

#### Request Body
```json
{
  "siteId": "20000000-0000-4000-8000-000000000001",
  "businessDate": "2026-11-20"
}
```

#### Response Example (`200 OK`)
Returns the freshly computed `DailySiteReport` with all aggregated workforce totals and labour category breakdowns.

---

### Workflow 4: Final Locking for Payroll & Billing

When the Project Manager has approved the report and Central Admin / Finance has verified subcontractor muster counts against invoices, Central Admin issues the final lock.

#### `POST /api/v1/attendance/daily-reports/:id/lock`

**Permission Required**: `ATTENDANCE_MANAGE`

> [!IMPORTANT]
> The report **must be in `APPROVED` status** to be locked. Attempting to lock a report in `DRAFT` or `SUBMITTED` status will return `409 Conflict`.
> Once locked, the report is **permanently immutable**.

#### Request Body (Optional)
```json
{
  "reason": "Audited and verified against turnstile logs for November Payroll cycle"
}
```

#### Request Example (cURL)
```bash
curl -X POST "https://api.sarjan.com/api/v1/attendance/daily-reports/9a1d4f20-b389-4fa2-bca4-d89163b9e4a1/lock" \
  -H "Authorization: Bearer <token>" \
  -H "x-company-id: 00000000-0000-4000-8000-0000000000c1" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Audited and verified against turnstile logs for November Payroll cycle"}'
```

#### Response Example (`200 OK`)
```json
{
  "id": "9a1d4f20-b389-4fa2-bca4-d89163b9e4a1",
  "status": "LOCKED",
  "lockedById": "emp-ho-admin-1",
  "lockedAt": "2026-11-23T06:00:00.000Z",
  "version": 2,
  "updatedAt": "2026-11-23T06:00:00.000Z"
}
```

---

### Workflow 5: Audit Trail & Compliance Inspection

For tax audits, statutory labour welfare inspections, or contractor dispute resolution, Central Admin can retrieve the tamper-evident audit history of any report.

#### `GET /api/v1/attendance/daily-reports/:id/audit-trail`

**Permission Required**: `ATTENDANCE_READ`

#### Response Example (`200 OK`)
```json
[
  {
    "id": "audit-log-001",
    "reportId": "9a1d4f20-b389-4fa2-bca4-d89163b9e4a1",
    "actorId": "sys-cron",
    "action": "AUTO_CALCULATED",
    "fieldName": null,
    "oldValue": null,
    "newValue": null,
    "reason": "End-of-day automatic muster roll calculation",
    "createdAt": "2026-11-20T08:00:00.000Z"
  },
  {
    "id": "audit-log-002",
    "reportId": "9a1d4f20-b389-4fa2-bca4-d89163b9e4a1",
    "actorId": "emp-supervisor-1",
    "action": "SUBMITTED",
    "fieldName": null,
    "oldValue": "DRAFT",
    "newValue": "SUBMITTED",
    "reason": "Submitted for PM review",
    "createdAt": "2026-11-20T18:30:00.000Z"
  },
  {
    "id": "audit-log-003",
    "reportId": "9a1d4f20-b389-4fa2-bca4-d89163b9e4a1",
    "actorId": "emp-pm-1",
    "action": "APPROVED",
    "fieldName": null,
    "oldValue": "SUBMITTED",
    "newValue": "APPROVED",
    "reason": "Approved by Project Manager",
    "createdAt": "2026-11-20T20:15:00.000Z"
  },
  {
    "id": "audit-log-004",
    "reportId": "9a1d4f20-b389-4fa2-bca4-d89163b9e4a1",
    "actorId": "emp-ho-admin-1",
    "action": "LOCKED",
    "fieldName": null,
    "oldValue": "APPROVED",
    "newValue": "LOCKED",
    "reason": "Audited and verified against turnstile logs for November Payroll cycle",
    "createdAt": "2026-11-23T06:00:00.000Z"
  }
]
```

---

### Workflow 6: Emergency Pre-Lock Adjustments (HO Admin Override)

If Head Office Admin spots a billing mistake before locking (e.g. subcontractor billed 25 masons but muster was 20), HO Admin has permission to adjust the labour summary directly:

#### `PATCH /api/v1/attendance/daily-reports/:id/labour-summary/:summaryId`

**Permission Required**: `ATTENDANCE_MANAGE`

> [!NOTE]
> `reason` is **mandatory** (min 3 characters). Any edit recalculates the parent report's totals automatically and logs an entry in `DailyReportAuditLog`.

#### Request Body
```json
{
  "headcount": 20,
  "presentUnits": 20.0,
  "overtimeHours": 5.0,
  "reason": "Adjusted after verifying gate biometric log with contractor representative"
}
```

---

## 4. Frontend UI Architecture for Central Admin

Recommended page layout and component structure for the Central Admin / Finance portal:

### 1. Daily Reports Hub (`/admin/attendance/daily-reports`)
- **Top KPI Cards**:
  - `Ready to Lock (APPROVED)`: Count of reports awaiting central finance sign-off.
  - `In Review (SUBMITTED)`: Count of reports waiting for Project Manager review.
  - `Total Mandays Today`: Sum of `totalPresentUnits` across all sites for today.
  - `Total OT Hours`: Accumulated overtime hours.
- **Filter Bar**:
  - Multi-select: `Project`, `Site`.
  - Date Range Picker (`fromDate` to `toDate`).
  - Status Dropdown (`ALL`, `DRAFT`, `SUBMITTED`, `APPROVED`, `REJECTED`, `LOCKED`).
- **Reports Table**:
  - Columns: Date | Project | Site | Total Workers | Staff (Cat A) | Direct (Cat B) | Subcon (Cat C) | Total Units | Status Badge | Actions.
  - Action button:
    - If `status === 'APPROVED'`: Green button **"Lock Report"**.
    - If `status === 'LOCKED'`: Grey locked padlock icon with tooltip `"Locked by {lockedBy.displayName} on {lockedAt}"`.

### 2. Report Detail & Settlement View Modal (`/admin/attendance/daily-reports/:id`)
- **Header Section**: Project Name, Site Name, Business Date, Weather pill, Weather Stoppage Hours, Status Badge.
- **Sign-off Info Box**:
  - Prepared by: `Vikram Patel (Site Supervisor)` on `20 Nov 2026, 18:30`
  - Approved by: `Arjun Sharma (Project Manager)` on `20 Nov 2026, 20:15`
  - Locked by: `(Pending)` or `Rajesh Gupta (HO Finance)` on `23 Nov 2026, 06:00`
- **Workforce Category Breakdown (3-Tab or 3-Card Table)**:
  - **Category A (Staff)**: Engineers, Supervisors, Quality, Safety (Headcount, Present Hazri Units).
  - **Category B (Direct Company Labour)**: Masons, Barbenders, Helpers (Headcount, Units, Overtime Hours).
  - **Category C (Subcontractors)**: Grouped by Subcontractor Name (e.g. *Apex Shuttering*, *Delta Electricals*) showing trade, headcount, units, and OT hours.
- **Audit Drawer Component**:
  - Chronological vertical timeline showing every action, actor, timestamp, and justification reason.
- **Action Footer**:
  - `Recalculate`: Trigger `POST /calculate` (if pre-lock adjustments made).
  - `Lock for Payroll`: Opens confirmation dialog.

### 3. Lock Confirmation Dialog
- Warning: *"Locking this report is permanent and irreversible. Once locked, no site supervisor, engineer, or project manager can modify these attendance numbers."*
- Input: `Audit Reason / Billing Cycle Notes` (optional, e.g. "Verified for Nov-2026 Subcontractor Invoicing").
- Button: **"Confirm & Lock Report"**.

---

## 5. TypeScript Client & Types

Frontend developers can copy and use these standard TypeScript types:

```typescript
export type DailyReportStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'LOCKED';
export type WeatherCondition = 'CLEAR' | 'OVERCAST' | 'LIGHT_RAIN' | 'HEAVY_RAIN' | 'STORMY' | 'EXTREME_HEAT';
export type LabourCategory = 'CAT_A_STAFF' | 'CAT_B_DIRECT_LABOUR' | 'CAT_C_SUBCONTRACTOR';

export interface DailySiteReportLabour {
  id: string;
  reportId: string;
  category: LabourCategory;
  subcontractorId?: string | null;
  subcontractorName?: string | null;
  tradeCategory: string;
  headcount: number;
  presentUnits: string | number;
  overtimeHours: string | number;
  remarks?: string | null;
}

export interface DailyReportAuditLog {
  id: string;
  reportId: string;
  actorId: string;
  action: string;
  fieldName?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  reason: string;
  createdAt: string;
}

export interface DailySiteReport {
  id: string;
  companyId: string;
  projectId: string;
  siteId: string;
  businessDate: string;
  status: DailyReportStatus;
  weather: WeatherCondition;
  weatherStoppageHours: string | number;
  workProgressNotes?: string | null;
  siteObstaclesRemarks?: string | null;
  safetyIncidentReported: boolean;
  safetyNotes?: string | null;
  totalWorkersHeadcount: number;
  totalPresentUnits: string | number;
  totalOvertimeHours: string | number;
  catAStaffCount: number;
  catAStaffUnits: string | number;
  catBDirectCount: number;
  catBDirectUnits: string | number;
  catCSubconCount: number;
  catCSubconUnits: string | number;
  submittedAt?: string | null;
  approvedAt?: string | null;
  lockedAt?: string | null;
  rejectionReason?: string | null;
  version: number;
  site: { id: string; code: string; name: string };
  project: { id: string; code: string; name: string };
  submittedBy?: { id: string; employeeCode: string; displayName: string } | null;
  approvedBy?: { id: string; employeeCode: string; displayName: string } | null;
  lockedBy?: { id: string; employeeCode: string; displayName: string } | null;
  labourSummaries?: DailySiteReportLabour[];
  auditLogs?: DailyReportAuditLog[];
}
```

### API Service Helper Example (Axios / Fetch)

```typescript
import axios from 'axios';

const api = axios.create({
  baseURL: '/api/v1',
  headers: { 'Content-Type': 'application/json' },
});

export const dailyReportsApi = {
  // 1. List company reports with filters
  list: (companyId: string, params: {
    status?: DailyReportStatus;
    siteId?: string;
    fromDate?: string;
    toDate?: string;
    limit?: number;
    offset?: number;
  }) => api.get<{ items: DailySiteReport[]; total: number }>('/attendance/daily-reports', {
    headers: { 'x-company-id': companyId },
    params,
  }).then(r => r.data),

  // 2. Get single report details
  getById: (companyId: string, id: string) =>
    api.get<DailySiteReport>(`/attendance/daily-reports/${id}`, {
      headers: { 'x-company-id': companyId },
    }).then(r => r.data),

  // 3. Final Lock for Payroll / Billing
  lock: (companyId: string, id: string, reason?: string) =>
    api.post<DailySiteReport>(`/attendance/daily-reports/${id}/lock`, { reason }, {
      headers: { 'x-company-id': companyId },
    }).then(r => r.data),

  // 4. View Audit History
  getAuditTrail: (companyId: string, id: string) =>
    api.get<DailyReportAuditLog[]>(`/attendance/daily-reports/${id}/audit-trail`, {
      headers: { 'x-company-id': companyId },
    }).then(r => r.data),

  // 5. Trigger On-Demand Recalculate
  recalculate: (companyId: string, siteId: string, businessDate: string) =>
    api.post<DailySiteReport>('/attendance/daily-reports/calculate', { siteId, businessDate }, {
      headers: { 'x-company-id': companyId },
    }).then(r => r.data),
};
```

---

## 6. Error Handling & Edge Cases

| HTTP Status | Error Code | Cause | Recommended UI Action |
|---|---|---|---|
| `401 Unauthorized` | `COMPANY_REQUIRED` | Missing `x-company-id` header. | Re-check active tenant context in local storage. |
| `403 Forbidden` | `ACCESS_DENIED` | Caller lacks `ATTENDANCE_READ` or `ATTENDANCE_MANAGE`. | Show *"You do not have administrative permission to view/lock daily site reports"*. |
| `404 Not Found` | `DAILY_REPORT_NOT_FOUND` | Report ID does not exist in this company. | Display error and redirect back to reports list. |
| `409 Conflict` | `DAILY_REPORT_ALREADY_LOCKED` | Attempted edit or lock on an already locked report. | Refresh screen and disable all action buttons. |
| `409 Conflict` | `INVALID_STATE_TRANSITION` | Attempted to lock a report that is not in `APPROVED` status. | Prompt user that Project Manager approval is required first. |
| `400 Bad Request` | `VALIDATION_ERROR` | Malformed date (`YYYY-MM-DD`) or missing mandatory justification reason. | Show inline form field validation error. |

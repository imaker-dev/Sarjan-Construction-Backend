# Attendance Module — API Guide

Step-by-step reference for the attendance lifecycle: setup prerequisites → policies →
daily punch flow (mobile / kiosk / offline) → breaks → sessions & summaries →
corrections → muster-roll export.

Base URL: `/api/v1`

## Prerequisites (setup chain)

Attendance needs this org structure in place first. Each entity is created via the
org/employee APIs (see `docs/API-FLOW.md`); attendance APIs only _consume_ them.

```
Platform Admin
  └─ POST /platform/companies                     → Company (tenant)
       └─ POST /org/head-offices                  → Head Office
            └─ POST /org/projects                 → Project (under a head office)
                 └─ POST /org/sites               → Site  ← set geofence here!
                      └─ POST /departments        → Site / Project department
                           └─ POST /employees     → Employee (linked login)
                                └─ memberships    → Employee ↔ Department
```

Critical fields for attendance:

| Entity       | Fields attendance uses                                             | Why                                             |
| ------------ | ------------------------------------------------------------------ | ----------------------------------------------- |
| `Site`       | `geoLatitude`, `geoLongitude`, `geoFenceRadiusM`, `status: ACTIVE` | Geofence punch validation (Haversine)           |
| `Site`       | `timezone` (or inherited from project)                             | Business-date 8AM–8AM cycle                     |
| `Department` | `scopeType: SITE/PROJECT`, `status: ACTIVE`                        | Operation/team scoping                          |
| `Employee`   | `status: ACTIVE`, linked `principalId`                             | `employeeId` for punches; self-punch resolution |

## Auth & headers

Every attendance endpoint requires:

```http
Authorization: Bearer <access-token>
x-company-id: <company-uuid>
Content-Type: application/json
```

| Permission          | Grants                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ATTENDANCE_READ`   | List/view policies, sessions (incl. **other employees'** sessions & active session), summaries, TVT, muster roll       |
| `ATTENDANCE_RECORD` | Punch **self** in/out, own breaks, kiosk batch, offline sync, TVT create/attendees                                     |
| `ATTENDANCE_MANAGE` | Create/update policies, regularize sessions, **punch/break on behalf of others**, use privileged punch `source` values |

**Who can do what** (service-level scope checks — a permission granted at `COMPANY`
scope covers all sites; project/site-scoped roles cover their subtree):

- **Self actions** (`punchIn`/`punchOut`/`startBreak`/`endBreak` with no `employeeId`,
  or your own) → `ATTENDANCE_RECORD` at the session's site.
- **Supervisor actions** (passing another `employeeId`, or `source` ∈
  `SUPERVISOR_KIOSK | BIOMETRIC_DEVICE | MANUAL_CORRECTION`) → `ATTENDANCE_MANAGE`
  at the session's site.
- `employeeId` is resolved from the caller's principal when omitted — you cannot
  spoof another employee without `ATTENDANCE_MANAGE`.

Roles that ship with these keys: `HO_ADMIN`, `PROJECT_MANAGER`, `PROJECT_INCHARGE`,
`SITE_ENGINEER` (all RECORD+READ+MANAGE), `FINANCE_MANAGER` (READ+MANAGE — HR/payroll
oversight incl. regularization), `PROJECT_DIRECTOR` (READ only),
`EMPLOYEE` (RECORD+READ — self only).

## Endpoint index (all 22 routes)

| Step | Method + path                                        | Permission      | Purpose                                         |
| ---- | ---------------------------------------------------- | --------------- | ----------------------------------------------- |
| 1    | `POST /attendance/policies`                          | MANAGE          | Create policy (COMPANY/PROJECT/SITE/EMPLOYEE)   |
| 1    | `GET /attendance/policies?scope=`                    | READ            | List policies                                   |
| 1    | `GET /attendance/policies/effective?siteId&…`        | READ            | Preview resolved policy for a punch context     |
| 1    | `GET /attendance/policies/:id`                       | READ            | One policy                                      |
| 1    | `PATCH /attendance/policies/:id`                     | MANAGE          | Update (+ `expectedVersion` optimistic lock)    |
| 2    | `POST /attendance/tvt`                               | RECORD          | Safety talk session + initial attendees         |
| 2    | `GET /attendance/tvt?siteId&businessDate=`           | READ            | List TVT sessions (cursor pagination)           |
| 2    | `GET /attendance/tvt/:id`                            | READ            | One TVT session + attendee list                 |
| 2    | `POST /attendance/tvt/:id/attendees`                 | RECORD          | Add late arrivals (dupes skipped)               |
| 3    | `POST /attendance/punch-in`                          | RECORD / MANAGE | Open session (mobile self / kiosk / biometric)  |
| 3    | `POST /attendance/kiosk/batch-punch-in`              | RECORD          | Morning roll-call, ≤200 employees, one GPS      |
| 3    | `POST /attendance/kiosk/sync`                        | RECORD          | Offline replay, `clientSessionId` idempotent    |
| 4    | `POST /attendance/breaks/start`                      | RECORD / MANAGE | Open break on active session (DYNAMIC mode)     |
| 4    | `POST /attendance/breaks/end`                        | RECORD / MANAGE | Close break (by breakId / sessionId / employee) |
| 5    | `POST /attendance/punch-out`                         | RECORD / MANAGE | Close session, compute units                    |
| 5    | `POST /attendance/kiosk/batch-punch-out`             | RECORD          | Evening roll-call close, ≤200 employees         |
| 6    | `GET /attendance/sessions/active?employeeId=`        | READ            | Is this employee punched in now?                |
| 6    | `GET /attendance/sessions?…&cursor=`                 | READ            | Session list (filters + keyset pagination)      |
| 6    | `GET /attendance/sessions/:id`                       | READ            | One session + breaks                            |
| 6    | `GET /attendance/daily-summary?siteId&businessDate=` | READ            | Site dashboard for a business date              |
| 7    | `POST /attendance/sessions/:id/regularize`           | MANAGE          | Correct a session (audited, remarks required)   |
| 8    | `GET /attendance/muster-roll?siteId&from&to`         | READ            | Payroll export, ≤31-day range                   |

## Core concepts

- **Business date** — `YYYY-MM-DD`, anchored to the site timezone, 8:00 AM → 8:00 AM
  next day (configurable via `dayStartHour`/`dayStartMinute`). A punch at 4:30 AM on
  Nov 19 counts toward business date Nov 18.
- **Policy resolution tiers** — `EMPLOYEE` → `SITE` → `PROJECT` → `COMPANY`.
  The first ACTIVE match wins for every punch. If none exists, a persisted
  company default policy is auto-provisioned.
- **One active session per employee** — enforced by a partial unique index on
  `(companyId, employeeId) WHERE status='IN_PROGRESS'`. Concurrent punch-ins can't
  produce duplicates.
- **Auto-close sweep** — a BullMQ worker (`attendance-sweep`, every 60s) marks
  `IN_PROGRESS` sessions older than 24h as `AUTO_CLOSED` with an audit remark, so a
  forgotten punch-out never blocks the next day's punch-in.
- **Hazri / P-units** — `netDuration < halfDayThreshold` → 0 P;
  `< fullDayThreshold` → 0.5 P; `>= fullDayThreshold` → 1.0 P, plus overtime
  (`HOURLY` slabs or `P_MULTIPLIER` slabs). `totalPUnits = presentUnits + overtimePUnits`.
- **Geofence** — distance from `(latitude, longitude)` to site
  `geoLatitude`/`geoLongitude` via Haversine. `geofenceStrict: true` **rejects**
  out-of-radius punch-_in_; `false` accepts but flags. Punch-_out_ outside radius is
  always accepted but flagged (`isFlagged` + `flagReason`) — workers aren't trapped.
- **TVT gate** — if `requireTvtGate: true`, employees must appear on a TVT attendee
  list for that site + business date before punch-in; `tvtGateAction: "BLOCK"`
  rejects, `"FLAG"` admits and flags. Applies to kiosk batch and offline sync too.
- **Breaks** — `FIXED` mode auto-deducts `fixedBreakMins` once `minWorkForBreakMins`
  is met (no API calls needed). `DYNAMIC` mode uses the breaks endpoints below.
  Any open break is auto-closed at punch-out.

---

## Step 1 — Create attendance policies

Do this once per company, then optionally per project / site / employee.

### `POST /attendance/policies` — `ATTENDANCE_MANAGE` → `201`

```json
{
  "name": "Head Office Default",
  "description": "Company-wide default policy",
  "scope": "COMPANY",
  "dayStartHour": 8,
  "dayStartMinute": 0,
  "shiftDurationMins": 480,
  "halfDayThresholdMins": 240,
  "fullDayThresholdMins": 480,
  "breakMode": "FIXED",
  "fixedBreakMins": 60,
  "minWorkForBreakMins": 240,
  "maxDynamicBreakMins": 90,
  "overtimeMode": "HOURLY",
  "minOvertimeMins": 30,
  "otSlabMins": 30,
  "geofenceStrict": true,
  "allowMobilePunch": true,
  "allowKioskPunch": true,
  "allowBiometric": true,
  "requireTvtGate": false,
  "tvtGateAction": "FLAG"
}
```

Field notes:

- `scope`: `COMPANY | PROJECT | SITE | EMPLOYEE` (default `COMPANY`)
- `scope` pairing — `PROJECT` → `projectId` required; `SITE` → `siteId`;
  `EMPLOYEE` → `employeeId`; `COMPANY` → none
- `breakMode`: `FIXED` (auto deduct) | `DYNAMIC` (manual start/end API)
- `overtimeMode`: `HOURLY` | `P_MULTIPLIER` — for `P_MULTIPLIER` pass `pMultiplierSlabs`:

```json
"pMultiplierSlabs": [
  { "minExtraMins": 120, "pUnit": 0.5 },
  { "minExtraMins": 240, "pUnit": 1.0 },
  { "minExtraMins": 480, "pUnit": 2.0 }
]
```

Project / site / employee overrides — same body plus the scope ID:

```json
{ "name": "Site Alpha Policy", "scope": "SITE", "siteId": "<site-uuid>", "requireTvtGate": true, "tvtGateAction": "BLOCK" }
{ "name": "Night-Shift Worker Override", "scope": "EMPLOYEE", "employeeId": "<employee-uuid>", "dayStartHour": 20 }
```

### Policy queries — `ATTENDANCE_READ`

```
GET /attendance/policies?scope=SITE                         → all policies, optional scope filter
GET /attendance/policies/:id                                → one policy
GET /attendance/policies/effective?siteId=<uuid>&employeeId=<uuid>
                                                            → resolved policy for this punch context
PATCH /attendance/policies/:id                              → update (ATTENDANCE_MANAGE)
    body: any subset of create fields + { "expectedVersion": 0 }   ← optimistic lock
```

`GET /policies/effective` is what the kiosk/mobile app calls before showing the
punch UI — it returns exactly which policy will govern the punch.

---

## Step 2 — Safety Toolbox Talk (TVT) — _only if `requireTvtGate: true`_

The site incharge/supervisor runs the morning safety talk and records attendance.

### `POST /attendance/tvt` — `ATTENDANCE_RECORD` → `201`

```json
{
  "siteId": "<site-uuid>",
  "topic": "Working at heights — harness check",
  "businessDate": "2026-11-19",
  "conductedAt": "2026-11-19T08:15:00.000Z",
  "remarks": "Morning briefing, crew A",
  "attendeeEmployeeIds": ["<emp-uuid-1>", "<emp-uuid-2>"]
}
```

`businessDate`/`conductedAt` default to now; `attendeeEmployeeIds` optional (≤500).

Response `201` — the session including its attendee rows:

```json
{
  "id": "<tvt-uuid>",
  "siteId": "<site-uuid>",
  "businessDate": "2026-11-19",
  "topic": "Working at heights — harness check",
  "conductedAt": "2026-11-19T08:15:00.000Z",
  "remarks": "Morning briefing, crew A",
  "status": "ACTIVE",
  "attendees": [
    { "id": "...", "employeeId": "<emp-uuid-1>" },
    { "id": "...", "employeeId": "<emp-uuid-2>" }
  ]
}
```

Late arrivals get added to the day's TVT list:

### `POST /attendance/tvt/:id/attendees` — `ATTENDANCE_RECORD`

```json
{ "employeeIds": ["<emp-uuid-3>", "<emp-uuid-4>"] }
```

Duplicates are silently skipped (`sessionId+employeeId` is unique).

### TVT queries — `ATTENDANCE_READ`

```
GET /attendance/tvt?siteId=<uuid>&businessDate=2026-11-19&limit=50&cursor=<id>
GET /attendance/tvt/:id                    → session + attendee list
```

---

## Step 3 — Punch in

Three modes, all producing an `AttendanceSession` (`status: IN_PROGRESS`).

### 3a. Mobile self-punch — `POST /attendance/punch-in` → `201` — `ATTENDANCE_RECORD`

Employee punches themselves — `employeeId` omitted (resolved from their login).

```json
{
  "siteId": "<site-uuid>",
  "latitude": 25.5941,
  "longitude": 85.1376,
  "source": "MOBILE_SELF",
  "remarks": "Gate A entry"
}
```

| Field                  | Rule                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `siteId`               | **required** — site must exist in the company                                                                                                   |
| `employeeId`           | optional — defaults to caller's employee; any other value → `ATTENDANCE_MANAGE`                                                                 |
| `latitude`/`longitude` | **required**                                                                                                                                    |
| `source`               | `MOBILE_SELF` for self-punch. Any other value → `ATTENDANCE_MANAGE`. Omitted → auto-derived (`SUPERVISOR_KIOSK` when punching for someone else) |

Validation chain (inside one transaction):

1. Caller→employee resolution; supervisor/privileged-source → `ATTENDANCE_MANAGE`
2. Employee exists + `ACTIVE`; site exists in company
3. No existing `IN_PROGRESS` session (app check + DB unique index)
4. Effective policy resolved; `allowMobilePunch`/`allowKioskPunch`/`allowBiometric`
   enforced per source
5. Geofence check → reject (strict) or flag
6. TVT gate (if enabled) → `BLOCK` rejects, `FLAG` admits + `isFlagged`
7. Session created with `policyId` pinned + `businessDate` computed

Response `201` — the new session (full field list in Step 6):

```json
{
  "id": "<session-uuid>",
  "employeeId": "<emp-uuid>",
  "siteId": "<site-uuid>",
  "policyId": "<resolved-policy-uuid>",
  "businessDate": "2026-11-19",
  "status": "IN_PROGRESS",
  "source": "MOBILE_SELF",
  "punchInAt": "2026-11-19T08:05:12.340Z",
  "punchInLat": "25.5941000",
  "punchInLng": "85.1376000",
  "punchInDistanceM": 42,
  "punchInWithinGeofence": true,
  "punchOutAt": null,
  "isFlagged": false,
  "flagReason": null,
  "breaks": [],
  "version": 0
}
```

→ hold on to `id` (or rely on `employeeId`-based lookups) for breaks & punch-out.

### 3b. Kiosk single punch — same endpoint

```json
{
  "employeeId": "<emp-uuid>",
  "siteId": "<site-uuid>",
  "latitude": 25.5941,
  "longitude": 85.1376,
  "source": "SUPERVISOR_KIOSK"
}
```

→ requires `ATTENDANCE_MANAGE` at that site.

### 3c. Kiosk batch punch-in — `POST /attendance/kiosk/batch-punch-in` → `ATTENDANCE_RECORD`

Morning roll-call mode — up to 200 employees, one GPS point:

```json
{
  "siteId": "<site-uuid>",
  "employeeIds": ["<emp-1>", "<emp-2>", "<emp-3>"],
  "latitude": 25.5941,
  "longitude": 85.1376,
  "punchInAt": "2026-11-19T08:30:00.000Z",
  "remarks": "Morning muster"
}
```

`punchInAt` optional (defaults to now). Lookups are pre-batched (employees, active
sessions, per-employee policies, TVT attendees) — no N+1. Response is per-employee:

```json
{
  "siteId": "...",
  "totalSubmitted": 3,
  "successCount": 2,
  "failureCount": 1,
  "results": [
    {
      "employeeId": "<emp-1>",
      "sessionId": "...",
      "success": true,
      "isFlagged": false,
      "flagReason": null
    },
    {
      "employeeId": "<emp-2>",
      "sessionId": "...",
      "success": true,
      "isFlagged": true,
      "flagReason": "Safety TVT briefing missed"
    },
    { "employeeId": "<emp-3>", "success": false, "error": "ACTIVE_SESSION_EXISTS" }
  ]
}
```

Per-employee errors: `EMPLOYEE_NOT_ACTIVE`, `ACTIVE_SESSION_EXISTS`,
`GEOFENCE_BREACH`, `TVT_SAFETY_BRIEFING_REQUIRED`, or an exception message.

### 3d. Offline kiosk sync — `POST /attendance/kiosk/sync` → `ATTENDANCE_RECORD`

Device was offline at the site; replay captured punches later. Idempotent —
`clientSessionId` dedupes retries.

```json
{
  "siteId": "<site-uuid>",
  "syncBatchId": "8f14e45f-....",
  "sessions": [
    {
      "clientSessionId": "a1b2c3d4-....",
      "employeeId": "<emp-uuid>",
      "punchInAt": "2026-11-19T08:05:00.000Z",
      "punchInLat": 25.5941,
      "punchInLng": 85.1376,
      "punchOutAt": "2026-11-19T17:35:00.000Z",
      "punchOutLat": 25.5945,
      "punchOutLng": 85.138,
      "remarks": "Offline capture"
    }
  ]
}
```

`sessions`: 1–500 items. Items with `punchOutAt` arrive as `COMPLETED` with units
calculated. Per-item validation: `clientSessionId` already synced → `ALREADY_SYNCED`;
inactive employee → `FAILED`; punch-in-only item while an `IN_PROGRESS` session
already exists → `FAILED`; geofence breaches are flagged (both directions);
`TVT BLOCK` → `FAILED` (`TVT_SAFETY_BRIEFING_REQUIRED`), not downgraded.

Response:

```json
{
  "siteId": "...",
  "totalSubmitted": 1,
  "syncedCount": 1,
  "alreadySyncedCount": 0,
  "failedCount": 0,
  "results": [{ "clientSessionId": "a1b2c3d4-....", "status": "SYNCED", "sessionId": "..." }]
}
```

---

## Step 4 — Breaks (only when `breakMode: DYNAMIC`)

### `POST /attendance/breaks/start` → `201` — `ATTENDANCE_RECORD` (self) / `ATTENDANCE_MANAGE` (others)

```json
{
  "sessionId": "<session-uuid>",
  "breakType": "LUNCH",
  "remarks": "Lunch break"
}
```

`sessionId` **or** `employeeId` (uses their active session) — omit both for your own
active session. `breakType` is optional free-text ≤50 chars, defaults to `"LUNCH"`
(e.g. `LUNCH`, `TEA`, `REST`). `remarks` ≤200 chars.
Only one open break per session — a second start → `BreakAlreadyActiveError`.

Response `201` — the break row:

```json
{
  "id": "<break-uuid>",
  "sessionId": "<session-uuid>",
  "breakType": "LUNCH",
  "startedAt": "2026-11-19T13:00:04.120Z",
  "endedAt": null,
  "durationMins": null,
  "remarks": "Lunch break"
}
```

### `POST /attendance/breaks/end` → `ATTENDANCE_RECORD` (self) / `ATTENDANCE_MANAGE` (others)

Identify the break by any of: `breakId` (specific break), `sessionId` (its open
break), `employeeId` (their active session's open break), or nothing (your own):

```json
{ "breakId": "<break-uuid>", "remarks": "Back to work" }
```

An already-ended or unknown `breakId` → `NoActiveBreakError`. `durationMins` is
computed; total break minutes cap at `maxDynamicBreakMins` of the policy and reduce
`netDurationMins` at punch-out.

Response — the closed break:

```json
{
  "id": "<break-uuid>",
  "sessionId": "<session-uuid>",
  "breakType": "LUNCH",
  "startedAt": "2026-11-19T13:00:04.120Z",
  "endedAt": "2026-11-19T13:32:10.550Z",
  "durationMins": 32,
  "remarks": "Back to work"
}
```

---

## Step 5 — Punch out

### `POST /attendance/punch-out` → `ATTENDANCE_RECORD` (self) / `ATTENDANCE_MANAGE` (others)

```json
{
  "siteId": "<site-uuid>",
  "latitude": 25.5945,
  "longitude": 85.138,
  "remarks": "End of shift"
}
```

`latitude`/`longitude` are required; `siteId`, `sessionId`, `employeeId`, `source`
are all optional.

Identify the session by `sessionId`, `employeeId`, or neither (self → caller's
active session). Behavior on punch-out:

- Any open break is **auto-closed** first.
- Geofence breach is recorded: `punchOutWithinGeofence: false`, session **flagged**
  (`isFlagged` + reason appended) — never rejected.
- Server computes and stores: `grossDurationMins` → break deduction →
  `netDurationMins` → `presentUnits` / `overtimePUnits` / `overtimeHours` /
  `totalPUnits` → `status: COMPLETED`.

Response — the completed session (same shape as Step 6; `breaks[]` included):

```json
{
  "id": "<session-uuid>",
  "status": "COMPLETED",
  "punchOutAt": "2026-11-19T17:35:20.000Z",
  "punchOutDistanceM": 55,
  "punchOutWithinGeofence": true,
  "grossDurationMins": 570,
  "breakDurationMins": 60,
  "netDurationMins": 510,
  "presentUnits": "1.0",
  "overtimePUnits": "0.0",
  "totalPUnits": "1.0",
  "overtimeHours": "0.50",
  "isFlagged": false,
  "flagReason": null,
  "version": 1
}
```

### Kiosk batch punch-out — `POST /attendance/kiosk/batch-punch-out` — `ATTENDANCE_RECORD`

```json
{
  "siteId": "<site-uuid>",
  "employeeIds": ["<emp-1>", "<emp-2>"],
  "latitude": 25.5945,
  "longitude": 85.138,
  "punchOutAt": "2026-11-19T17:30:00.000Z"
}
```

Each employee's active session is found (pre-batched) and closed. A session opened
at a **different site** is not touched — that employee gets
`SESSION_SITE_MISMATCH`. Per-employee results include computed units:

```json
{
  "siteId": "...",
  "totalSubmitted": 2,
  "successCount": 1,
  "failureCount": 1,
  "results": [
    {
      "employeeId": "<emp-1>",
      "sessionId": "...",
      "success": true,
      "netDurationMins": 510,
      "presentUnits": 1.0,
      "overtimePUnits": 0.0,
      "totalPUnits": 1.0,
      "overtimeHours": 0.5
    },
    { "employeeId": "<emp-2>", "success": false, "error": "SESSION_SITE_MISMATCH" }
  ]
}
```

Other per-employee errors: `NO_ACTIVE_SESSION`, `EMPLOYEE_NOT_ACTIVE`.

---

## Step 6 — Read sessions & daily summary — `ATTENDANCE_READ`

### Active session (is this employee punched in right now?)

```
GET /attendance/sessions/active?employeeId=<uuid>
→ { "session": { ... } | null }
```

`employeeId` omitted → caller's own active session. Querying **another** employee
requires `ATTENDANCE_READ` at that session's site (a `COMPANY`-scoped role like
`FINANCE_MANAGER` covers every site).

### Session list (filters + cursor pagination)

```
GET /attendance/sessions?siteId=<uuid>&employeeId=<uuid>&businessDate=2026-11-19
    &status=COMPLETED&limit=50&cursor=<id>
```

Response is a **bare array** of session objects (no envelope). `cursor` = the `id`
of the last row of the previous page (keyset pagination, `punchInAt desc, id desc`);
`limit` defaults to 50, max 100. `status` ∈ `IN_PROGRESS | COMPLETED | AUTO_CLOSED | REJECTED`.

### Session detail

```
GET /attendance/sessions/:id        → ATTENDANCE_READ at the session's site
```

Session object (response shape):

```json
{
  "id": "...",
  "employeeId": "...",
  "siteId": "...",
  "policyId": "...",
  "businessDate": "2026-11-19",
  "status": "COMPLETED",
  "source": "SUPERVISOR_KIOSK",
  "punchInAt": "2026-11-19T08:05:00.000Z",
  "punchInLat": "25.5941000",
  "punchInLng": "85.1376000",
  "punchInDistanceM": 42,
  "punchInWithinGeofence": true,
  "punchOutAt": "2026-11-19T17:35:00.000Z",
  "punchOutDistanceM": 55,
  "punchOutWithinGeofence": true,
  "grossDurationMins": 570,
  "breakDurationMins": 60,
  "netDurationMins": 510,
  "presentUnits": "1.0",
  "overtimePUnits": "0.0",
  "totalPUnits": "1.0",
  "overtimeHours": "0.50",
  "isFlagged": false,
  "flagReason": null,
  "breaks": [
    { "id": "...", "breakType": "LUNCH", "startedAt": "...", "endedAt": "...", "durationMins": 30 }
  ],
  "version": 1
}
```

`status` ∈ `IN_PROGRESS | COMPLETED | AUTO_CLOSED | REJECTED`.

### Daily summary (site dashboard)

```
GET /attendance/daily-summary?siteId=<uuid>&businessDate=2026-11-19
        → ATTENDANCE_READ at that site
```

```json
{
  "siteId": "...",
  "businessDate": "2026-11-19",
  "totalWorkers": 87,
  "totalSessions": 88,
  "completedSessions": 80,
  "inProgressSessions": 8,
  "autoClosedSessions": 0,
  "totalApprovedLeaves": 3,
  "totalPresentUnits": 84.5,
  "totalOvertimePUnits": 6.0,
  "totalTotalPUnits": 90.5,
  "totalOvertimeHours": 12.5,
  "sessions": [ ... ], "leaves": [ ... ]
}
```

`leaves`/`totalApprovedLeaves` cover only **this site's** approved-leave workers
(sessions at the site or site-scoped role holders), not the whole company.

---

## Step 7 — Corrections — `ATTENDANCE_MANAGE` only

Supervisor/HR fixes a bad punch (missed punch-out, wrong units). `remarks` is
**mandatory** (min 3 chars) and everything is audited.

### `POST /attendance/sessions/:id/regularize`

```json
{
  "punchInAt": "2026-11-19T08:10:00.000Z",
  "punchOutAt": "2026-11-19T17:40:00.000Z",
  "presentUnits": 1.0,
  "overtimePUnits": 0.5,
  "overtimeHours": 1.5,
  "remarks": "Worker forgot punch-out; verified via gate log"
}
```

Rules:

- Effective `punchOutAt` must exist (input or existing) — otherwise `400`
- `punchOutAt` must be strictly after `punchInAt` — otherwise `400`
- Durations and units are **recomputed** from effective times + policy unless
  explicitly overridden (`presentUnits` / `overtimePUnits` / `overtimeHours`)
- Session ends `COMPLETED`, `source: MANUAL_CORRECTION`, `approvedBy`/`approvedAt`
  stamped with the correcting principal
- Response is the corrected session object (Step 6 shape)

---

## Step 8 — Muster-roll export (payroll settlement)

### `GET /attendance/muster-roll` — `ATTENDANCE_READ` at that site

```
GET /attendance/muster-roll?siteId=<uuid>&from=2026-11-01&to=2026-11-15
    &employeeId=<uuid>&status=COMPLETED
```

**Date range is capped at 31 days** (`InvalidDateRangeError` / `INVALID_DATE_RANGE`
beyond it — export per half-month for payroll cycles).

Aggregates per-worker totals for the range:

```json
{
  "siteId": "...", "from": "2026-11-01", "to": "2026-11-15",
  "totalSessions": 1150,
  "totalMandays": 980,
  "totalPresentUnits": 965.5,
  "totalOvertimePUnits": 120.0,
  "totalTotalPUnits": 1085.5,
  "totalOvertimeHours": 240.5,
  "workerSummaries": [
    {
      "employeeId": "...", "employeeCode": "EMP-042", "displayName": "Ramesh K",
      "tradeCategory": "MASON",
      "presentUnits": 14.5, "overtimePUnits": 1.5, "totalPUnits": 16.0,
      "overtimeHours": 3.0, "sessionsCount": 15, "daysPresent": 15, "leaveDays": 1
    }
  ],
  "sessions": [ ... ],
  "leaves": [ ... ]
}
```

---

## Daily site flow (typical)

```
08:00  Supervisor:  POST /attendance/tvt                     (if gate enabled)
08:10  Kiosk:       POST /attendance/kiosk/batch-punch-in    (or mobile self-punch)
13:00  Worker:      POST /attendance/breaks/start            (DYNAMIC policy only)
13:30  Worker:      POST /attendance/breaks/end              ({ "breakId": "..." } or session)
17:30  Kiosk:       POST /attendance/kiosk/batch-punch-out
18:00  Incharge/HR: GET  /attendance/daily-summary           → review flags
18:30  HR:          POST /attendance/sessions/:id/regularize → fix anomalies
EOM    Payroll:     GET  /attendance/muster-roll?from=…&to=… (≤31 days per call)
Offline device? → POST /attendance/kiosk/sync when it reconnects
Background:     >24h IN_PROGRESS sessions → AUTO_CLOSED by sweep worker (every 60s)
```

## Errors

| Code / error                                   | When                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `COMPANY_REQUIRED`                             | Missing `x-company-id`                                                                     |
| `AttendanceEntityNotFoundError`                | Site/employee/session/break not found, inactive employee, or caller has no employee record |
| `ActiveSessionExistsError`                     | Second punch-in while `IN_PROGRESS` exists (also enforced by DB unique index)              |
| `GeofenceBreachError`                          | Punch-in outside radius with `geofenceStrict: true`                                        |
| `PunchNotAllowedError`                         | `source` disabled by policy (`allowMobilePunch`/`allowKioskPunch`/`allowBiometric`)        |
| `TvtSafetyBriefingRequiredError`               | TVT required, not attended, `tvtGateAction: "BLOCK"`                                       |
| `NoActiveSessionError`                         | Punch-out/break with no open session                                                       |
| `BreakAlreadyActiveError`                      | Break start while another break is open                                                    |
| `NoActiveBreakError`                           | Break-end with no open break, or `breakId` already ended                                   |
| `AttendanceValidationError`                    | Regularize without `punchOutAt`, or out ≤ in                                               |
| `InvalidDateRangeError` (`INVALID_DATE_RANGE`) | Muster-roll `from`→`to` exceeds 31 days                                                    |
| `ConcurrencyError`                             | `expectedVersion` mismatch on policy update                                                |
| `FORBIDDEN`                                    | Missing permission — e.g. RECORD holder punching for someone else (needs MANAGE)           |

Per-item batch errors: `EMPLOYEE_NOT_ACTIVE`, `ACTIVE_SESSION_EXISTS`,
`GEOFENCE_BREACH`, `TVT_SAFETY_BRIEFING_REQUIRED`, `NO_ACTIVE_SESSION`,
`SESSION_SITE_MISMATCH`; sync items: `SYNCED | ALREADY_SYNCED | FAILED`.

## Known limitations

- **`siteId` is required on every punch** — sessions are site-anchored
  (geofence, timezone, TVT, policy tiers). `HeadOffice` has no geofence
  fields, so HO staff punch against a site record (e.g. a nominal "HO"
  project + "Head Office" site with the office coordinates). First-class
  HO-anchored punching is a schema-level follow-up.
- **Offline sync covers punches only** — a sync item carries punch in/out;
  breaks taken offline can't be replayed, and TVT sessions themselves have
  no offline/idempotent create (`POST /tvt` is online-only).
- **`clientSessionId` dedup is app-level**, not a DB unique constraint —
  concurrent syncs of the same batch can double-create `COMPLETED`
  sessions (in-only items are still blocked by the one-active-session
  index). A partial unique index is the planned hardening.
- **Single punch-in/out have no idempotency key** — retries after an
  ambiguous network failure return `ACTIVE_SESSION_EXISTS` /
  `NO_ACTIVE_SESSION` (fail-safe, not a replayed response).
- **TVT creation only requires `ATTENDANCE_RECORD`** — any RECORD holder
  at the site (including the base `EMPLOYEE` role) can record a briefing.
  Restricting it to `ATTENDANCE_MANAGE` or a dedicated safety permission
  is a pending decision.

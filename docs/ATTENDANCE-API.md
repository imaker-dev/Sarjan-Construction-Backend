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

| Permission             | Grants                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ATTENDANCE_READ`      | List/view policies, sessions (incl. **other employees'** sessions & active session), summaries, TVT, muster roll       |
| `ATTENDANCE_RECORD`    | Punch **self** in/out, own breaks, kiosk batch, offline sync, TVT create/attendees                                     |
| `ATTENDANCE_MANAGE`    | Create/update policies, regularize sessions, **punch/break on behalf of others**, use privileged punch `source` values |
| `WORK_SCHEDULE_READ`   | Read schedules, revisions, overrides, classify, effective-schedule preview                                             |
| `WORK_SCHEDULE_MANAGE` | Create/update/archive schedules, add revisions, set/cancel overrides — at the schedule's resolved scope                |

**Scope resolution (fail closed).** Every route resolves its permission target
server-side from the real entity — never a caller-supplied site/employee pair:

- `siteId` → `SITE` target; `headOfficeId` → `HEAD_OFFICE` target; a session /
  report / TVT id → its owning site or head office; an `employeeId` filter → the
  employee's covering membership → department → its site / project / head office.
- A `COMPANY`-scope grant covers every target. A `PROJECT` grant covers the
  project **and its child sites** (downward inheritance). A `SITE` grant covers
  only that site. Sibling projects and unrelated sites are unreachable — the
  request fails `403 FORBIDDEN` / `ACCESS_DENIED`, not a silent empty list.
- Unresolvable targets (archived site, employee with no active membership)
  resolve to `COMPANY` — scoped holders are denied there by construction.
- **Attendance-policy authoring stays company/Finance territory**: `POST` /
  `PATCH /attendance/policies*` assert `ATTENDANCE_MANAGE` at `COMPANY`. Scoped
  roles manage _records_, never policy definitions.
- **Schedule editing is a separate authority**: `WORK_SCHEDULE_MANAGE` at the
  schedule's scope is necessary but **not sufficient** for scoped holders — a
  PI also needs the company delegation flag `scheduleManage` (default **OFF**;
  `GET /org/company/delegations`, `PATCH` by company admin). Company-wide
  `WORK_SCHEDULE_MANAGE` (Finance/Admin/owner) bypasses the flag entirely.
  Delegation never unlocks `HEAD_OFFICE` targets — HO stays Finance/Admin.

**Who can do what** (persona matrix):

| Action                                                                  | Employee  | PI (`PROJECT`)                              | PD (`PROJECT`) | Site Engineer / PM                         | HO Admin · Finance · Owner |
| ----------------------------------------------------------------------- | --------- | ------------------------------------------- | -------------- | ------------------------------------------ | -------------------------- |
| Own punch / breaks                                                      | ✅ RECORD | ✅ RECORD                                   | ✅ RECORD      | ✅ RECORD                                  | ✅ RECORD                  |
| Kiosk / batch / offline sync at a site                                  | —         | ✅ own sites                                | —              | ✅ own site/project                        | ✅ all                     |
| Punch/correct on behalf (incl. `POST /attendance/sessions`, regularize) | —         | ✅ MANAGE at own project+sites              | ❌ READ only   | ✅ MANAGE own scope                        | ✅ MANAGE company-wide     |
| Sessions / summaries / muster / DSR reads                               | own       | ✅ in scope                                 | ✅ in scope    | ✅ in scope                                | ✅ company-wide            |
| Attendance policy create/update                                         | —         | ❌                                          | ❌             | —                                          | ✅ MANAGE @COMPANY         |
| Work-schedule create/revisions/overrides                                | —         | ⚠️ own scope **+ `scheduleManage` flag ON** | ❌ read only   | PM: ⚠️ own scope + flag · SE: ❌ read only | ✅ company-wide            |
| Effective-schedule preview (`GET /schedules/effective`)                 | —         | ✅ employees in scope                       | ✅ in scope    | ✅ in scope                                | ✅ anyone                  |

- **Self actions** (`punchIn`/`punchOut`/`startBreak`/`endBreak` with no
  `employeeId`, or your own) → `ATTENDANCE_RECORD` at the session's site.
- **Supervisor actions** (passing another `employeeId`, or `source` ∈
  `SUPERVISOR_KIOSK | BIOMETRIC_DEVICE | MANUAL_CORRECTION`) → `ATTENDANCE_MANAGE`
  at the session's site.
- `employeeId` is resolved from the caller's principal when omitted — you cannot
  spoof another employee without `ATTENDANCE_MANAGE`.

Roles that ship with these keys: `HO_ADMIN`, `PROJECT_MANAGER`, `PROJECT_INCHARGE`,
`SITE_ENGINEER` (all RECORD+READ+MANAGE; PI/PM also `WORK_SCHEDULE_MANAGE`),
`FINANCE_MANAGER` (READ+MANAGE — HR/payroll oversight incl. regularization),
`PROJECT_DIRECTOR` (READ only), `EMPLOYEE` (RECORD+READ — self only).

## Endpoint index (all 33 routes)

| Step | Method + path                                                   | Permission      | Purpose                                                      |
| ---- | --------------------------------------------------------------- | --------------- | ------------------------------------------------------------ |
| 1    | `POST /attendance/policies`                                     | MANAGE          | Create policy (COMPANY/PROJECT/SITE/EMPLOYEE)                |
| 1    | `GET /attendance/policies?scope=`                               | READ            | List policies                                                |
| 1    | `GET /attendance/policies/effective?siteId&…`                   | READ            | Preview resolved policy for a punch context                  |
| 1    | `GET /attendance/policies/:id`                                  | READ            | One policy                                                   |
| 1    | `PATCH /attendance/policies/:id`                                | MANAGE          | Update (+ `expectedVersion` optimistic lock)                 |
| 2    | `POST /attendance/tvt`                                          | RECORD          | Safety talk session + initial attendees                      |
| 2    | `GET /attendance/tvt?siteId&businessDate=`                      | READ            | List TVT sessions (cursor pagination)                        |
| 2    | `GET /attendance/tvt/:id`                                       | READ            | One TVT session + attendee list                              |
| 2    | `POST /attendance/tvt/:id/attendees`                            | RECORD          | Add late arrivals (dupes skipped)                            |
| 3    | `POST /attendance/punch-in`                                     | RECORD / MANAGE | Open session (mobile self / kiosk / biometric)               |
| 3    | `POST /attendance/kiosk/batch-punch-in`                         | RECORD          | Morning roll-call, ≤200 employees, one GPS                   |
| 3    | `POST /attendance/kiosk/sync`                                   | RECORD          | Offline replay, `clientSessionId` idempotent                 |
| 4    | `POST /attendance/breaks/start`                                 | RECORD / MANAGE | Open break on active session (DYNAMIC mode)                  |
| 4    | `POST /attendance/breaks/end`                                   | RECORD / MANAGE | Close break (by breakId / sessionId / employee)              |
| 5    | `POST /attendance/punch-out`                                    | RECORD / MANAGE | Close session, compute units                                 |
| 5    | `POST /attendance/kiosk/batch-punch-out`                        | RECORD          | Evening roll-call close, ≤200 employees                      |
| 6    | `GET /attendance/sessions/active?employeeId=`                   | READ            | Is this employee punched in now?                             |
| 6    | `GET /attendance/sessions?…&cursor=`                            | READ            | Session list (filters + keyset pagination)                   |
| 6    | `GET /attendance/sessions/:id`                                  | READ            | One session + breaks                                         |
| 6    | `POST /attendance/sessions`                                     | MANAGE          | Manual missed-session correction (server-labeled)            |
| 6    | `GET /attendance/daily-summary?siteId&businessDate=`            | READ            | Site dashboard for a business date                           |
| 7    | `POST /attendance/sessions/:id/regularize`                      | MANAGE          | Correct a session (audited, remarks required)                |
| 8    | `GET /attendance/muster-roll?siteId&from&to`                    | READ            | Payroll export, ≤31-day range                                |
| 9    | `POST /attendance/daily-reports/calculate`                      | MANAGE          | Aggregate a site day into a DSR (headcount/units/OT/flagged) |
| 9    | `GET /attendance/daily-reports?…`                               | READ            | List DSRs (site/date/status filters, pagination)             |
| 9    | `GET /attendance/daily-reports/:id`                             | READ            | One DSR + labour summaries                                   |
| 9    | `PATCH /attendance/daily-reports/:id`                           | MANAGE          | Edit weather/progress/safety fields (DRAFT, version-locked)  |
| 9    | `PATCH /attendance/daily-reports/:id/labour-summary/:summaryId` | MANAGE          | Correct a labour line — `reason` mandatory                   |
| 9    | `POST /attendance/daily-reports/:id/submit`                     | RECORD          | DRAFT→SUBMITTED (site supervisor submits)                    |
| 9    | `POST /attendance/daily-reports/:id/approve`                    | MANAGE          | SUBMITTED→APPROVED                                           |
| 9    | `POST /attendance/daily-reports/:id/reject`                     | MANAGE          | SUBMITTED→REJECTED (`reason` mandatory)                      |
| 9    | `POST /attendance/daily-reports/:id/lock`                       | MANAGE          | APPROVED→LOCKED (month-end close, terminal)                  |
| 9    | `GET /attendance/daily-reports/:id/audit-trail`                 | READ            | Append-only transition/edit history                          |

### Companion schedule routes (the _when_ half of attendance)

`WorkSchedule` + immutable `WorkScheduleRevision` carry the clock-time rules the
punch flow consumes (`intraday` block — see Step 1b). Scope targets resolve the
same way as attendance routes; `WORK_SCHEDULE_MANAGE` at SITE/PROJECT targets
additionally requires the `scheduleManage` delegation flag.

| Method + path                                        | Permission    | Purpose                                                                        |
| ---------------------------------------------------- | ------------- | ------------------------------------------------------------------------------ |
| `POST /schedules`                                    | MANAGE        | Create schedule + revision 1 (scope: COMPANY/PROJECT/SITE/DEPARTMENT/EMPLOYEE) |
| `GET /schedules?scopeType=&siteId=&projectId=`       | READ          | List schedules (scoped)                                                        |
| `GET /schedules/:id` · `PATCH` · `POST /:id/archive` | READ / MANAGE | One schedule; update (version-locked); archive                                 |
| `GET /schedules/effective?employeeId=&siteId=&asOf=` | READ          | Resolved schedule + `resolvedVia` + day classification                         |
| `POST /schedules/:id/revisions`                      | MANAGE        | Append effective-dated revision (incl. `intraday`)                             |
| `GET /schedules/:id/revisions`                       | READ          | Revision history                                                               |
| `POST /schedules/:id/revisions/:rid/cancel`          | MANAGE        | Cancel a mistaken future revision (row kept, audited)                          |
| `POST /schedules/:id/overrides` · `GET`              | MANAGE / READ | Date overrides — holiday/OFF-day/working-day exceptions                        |
| `POST /schedules/:id/overrides/:oid/cancel`          | MANAGE        | Cancel an override                                                             |
| `GET /schedules/:id/classify/:date`                  | READ          | WORKING / WEEKLY_OFF / HOLIDAY + reason for one date                           |

Schedule resolution: `EMPLOYEE → DEPARTMENT → SITE → PROJECT → COMPANY`; HO
employees reach DEPARTMENT schedules via their department's `baseHeadOfficeId`.
A revision with no `intraday` is a day-pattern only — the AttendancePolicy
governs the session exactly as before.

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
- **Work schedules drive intraday timing** — `POST /schedules` + revisions carry an
  optional `intraday` block (`scheduledStartMins`/`scheduledEndMins` in local minutes,
  `graceInMins`/`graceOutMins`, `breakWindowMode` FIXED_WINDOW | DYNAMIC + window/duration,
  `autoClockOutMode` DISABLED | AT_SCHEDULED_END | AFTER_GRACE). Schedules resolve
  EMPLOYEE → DEPARTMENT → SITE → PROJECT → COMPANY; HO employees resolve via their
  department's `baseHeadOfficeId`. A revision with no `intraday` is a day-pattern
  only — the AttendancePolicy governs exactly as before.
- **Punch-time snapshot** — at punch-in the session pins the resolved schedule
  revision id, the resolved scheduled start/end as UTC instants, and a JSON
  `policySnapshot` of the calc-relevant policy values. Later schedule/policy edits
  NEVER reclassify that session — punch-out, breaks, and worker auto-close all
  compute from the snapshot.
- **Late-in / early-out** — flagged when punching past `scheduledStart + graceInMins`
  or before `scheduledEnd − graceOutMins` (raw timestamps preserved, session flagged).
- **Scheduled auto clock-out** — the `scheduled-end-auto-close` worker job (60s tick)
  closes IN_PROGRESS sessions at their pinned `scheduledEndAt` (+`autoClockOutGraceMins`
  for AFTER_GRACE). Conditional update — repeated/concurrent runs cannot double-close.
  Sets `autoClosedBy: SCHEDULED_END`, flags `Auto-closed at scheduled shift end`, computes
  durations from the snapshot, and audits `ATTENDANCE_AUTO_CLOCK_OUT` as SYSTEM.
  A punch-out arriving afterwards is recorded as an audited
  `PUNCH_OUT_AFTER_AUTO_CLOSE` correction — it never overwrites the system close.
- **EOD settlement** — the 5-minute settlement now closes a session ONLY once its
  business day has ended or its pinned scheduled end has arrived (the 24h sweep
  remains the safety net for sessions with no schedule).
- **Scoped authorization** — route gates resolve the permission target server-side:
  session/report/TVT ids resolve to their site, employee filters anchor via
  membership, and site/headOffice ids map to SITE / HEAD_OFFICE targets. PI/PD
  manage attendance only inside their project/site scope; Finance/Admin keep
  company-wide access. Unresolvable targets fall back to COMPANY (fail closed).
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

### 1b. Worked example — different rules for HO and site

Concrete setup: **head office 10:00–19:00, lunch 1 h flexible (dynamic breaks)**;
**site 8:00–17:00, strict lunch 13:00–14:00**. Two parts: a schedule (the _when_ —
via `/schedules` revisions with `intraday`) and a policy (the _controls_ — via
`/attendance/policies`). Both spans are 540 min gross; after the 60-min unpaid
break the **net-work baseline is 480** — that is what `shiftDurationMins` means
(overtime accrues on net minutes above it), so both policies use **480**, not 540.

**1. The schedules** — `POST /schedules` (WORK_SCHEDULE_MANAGE). HO employees
resolve through their company-scope department's `baseHeadOfficeId`, so a
DEPARTMENT-scope schedule on each HO department isolates the office without
leaking to sites:

```jsonc
// HO department schedule — resolves via DEPARTMENT tier
{
  "scopeType": "DEPARTMENT",
  "departmentId": "<ho-dept-uuid>",
  "name": "HO Shift 10–19",
  "effectiveFrom": "2026-01-01",
  "revision": {
    "effectiveFrom": "2026-01-01",
    "timezone": "Asia/Kolkata",
    "workingWeekdays": [1, 2, 3, 4, 5, 6],
    "intraday": {
      "scheduledStartMins": 600,      // 10:00
      "scheduledEndMins": 1140,       // 19:00
      "graceInMins": 10,              // punch-in after 10:10 → Late punch in flag
      "graceOutMins": 10,             // out before 18:50 → Early punch out flag
      "breakWindowMode": "DYNAMIC",   // employees punch their own lunch…
      "breakWindowStartMins": 720,    // …but only inside 12:00–15:00…
      "breakWindowEndMins": 900,
      "breakDurationMins": 60,        // …capped at 60 min/day deduction
      "autoClockOutMode": "AT_SCHEDULED_END"   // worker closes at exactly 19:00
    }
  }
}

// Site schedule — resolves via SITE tier for that site's employees
{
  "scopeType": "SITE",
  "siteId": "<site-uuid>",
  "name": "Site Shift 8–17",
  "effectiveFrom": "2026-01-01",
  "revision": {
    "effectiveFrom": "2026-01-01",
    "timezone": "Asia/Kolkata",
    "workingWeekdays": [1, 2, 3, 4, 5, 6],
    "intraday": {
      "scheduledStartMins": 480,      // 08:00
      "scheduledEndMins": 1020,       // 17:00
      "graceInMins": 5,
      "graceOutMins": 5,
      "breakWindowMode": "FIXED_WINDOW",
      "breakWindowStartMins": 780,    // strict 13:00–14:00
      "breakWindowEndMins": 840,
      "breakDurationMins": 60,        // auto-deducted — no break punches needed
      "autoClockOutMode": "AT_SCHEDULED_END"   // worker closes at exactly 17:00
    }
  }
}
```

**2. The policies** — `POST /attendance/policies` (ATTENDANCE_MANAGE) supply the
calc + security controls. **Break ownership (fail-closed):** when the resolved
revision carries a `breakWindowMode`, the schedule owns the local-time window
and the deducted/capped duration, and the policy's own `breakMode` MUST agree —
`FIXED` ↔ `FIXED_WINDOW`, `DYNAMIC` ↔ `DYNAMIC`. A disagreeing pair is a
contradictory configuration: punch-in fails with `BREAK_MODE_CONFLICT` (422)
rather than silently picking a winner. When the revision has no
`breakWindowMode`, the policy's `breakMode`/`fixedBreakMins`/
`maxDynamicBreakMins` govern exactly as before.

```jsonc
// Head office — 480 net baseline, dynamic lunch punches
{
  "name": "HO Policy — 10 to 7, flexible lunch",
  "scope": "COMPANY",
  "dayStartHour": 8,
  "dayStartMinute": 0,
  "shiftDurationMins": 480, // NET-work overtime baseline (540 − 60 lunch)
  "halfDayThresholdMins": 240,
  "fullDayThresholdMins": 480,
  "breakMode": "DYNAMIC",
  "maxDynamicBreakMins": 120,
  "minWorkForBreakMins": 180,
  "overtimeMode": "HOURLY",
  "minOvertimeMins": 30,
  "otSlabMins": 30,
  "geofenceStrict": true,
  "allowMobilePunch": true,
  "requireTvtGate": false
}

// Per site — 480 net baseline, strict geofence + TVT
{
  "name": "Site Policy — 8 to 5",
  "scope": "SITE",
  "siteId": "<site-uuid>",
  "shiftDurationMins": 480,
  "halfDayThresholdMins": 240,
  "fullDayThresholdMins": 480,
  "breakMode": "FIXED",
  "fixedBreakMins": 60,
  "minWorkForBreakMins": 240,
  "overtimeMode": "HOURLY",
  "minOvertimeMins": 30,
  "otSlabMins": 30,
  "geofenceStrict": true,
  "allowKioskPunch": true,
  "allowBiometric": true,
  "requireTvtGate": true,
  "tvtGateAction": "FLAG"
}
```

What this produces: an HO employee punching 10:05→19:10 with a 45-min self-punched
lunch computes `netDuration ≈ 8h25m → 1.0 P`; punching at 10:15 (past the 10-min
grace) flags `Late punch in`; forgetting to punch out closes the session at
exactly 19:00 IST as `AUTO_CLOSED`. A site worker punching 8:00→17:00 gets the
60-min fixed window auto-deducted, geofence-checked and TVT-flagged.

| Requirement                                                | Supported? | How                                                                                                      |
| ---------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------- |
| Different hours HO vs site                                 | ✅         | `intraday.scheduledStart/EndMins` on scoped schedule revisions                                           |
| Dynamic lunch at HO with a bounded window                  | ✅         | `breakWindowMode: "DYNAMIC"` + window + `breakDurationMins` day cap                                      |
| Strict 13:00–14:00 lunch at site                           | ✅         | `breakWindowMode: "FIXED_WINDOW"` + window + duration                                                    |
| Enforced opening/clock-out times (late-in/early-out flags) | ✅         | `graceInMins`/`graceOutMins` on the revision — flags on the session                                      |
| Auto clock-out at shift end (same day)                     | ✅         | `autoClockOutMode: "AT_SCHEDULED_END"` (`AFTER_GRACE` optional) — `autoClosedBy: SCHEDULED_END`, audited |
| Forgotten punch-out safety net                             | ✅         | 24h stale sweep (`autoClosedBy: STALE_SWEEP`) — separate from scheduled close                            |
| Finance/Admin manage HO + company-wide attendance          | ✅         | `ATTENDANCE_MANAGE` at COMPANY/HEAD_OFFICE targets                                                       |
| PI manages their own site's attendance                     | ✅         | scoped `SITE`/`PROJECT` targets on every attendance route                                                |
| PI edits site schedules                                    | ⚠️ opt-in  | `WORK_SCHEDULE_MANAGE` + company delegation flag `scheduleManage` (default OFF)                          |

**Ownership mapping (no competing sources of truth):** the _AttendancePolicy_
owns calc baselines + security controls (shiftDurationMins, thresholds, geofence,
sources, TVT, OT slabs). The _WorkScheduleRevision intraday_ owns clock-time
rules (scheduled start/end, graces, break window + mode, auto clock-out). When
both set break behavior, the schedule wins — the snapshot records which revision
governed so history is stable.

### 1c. Step-by-step by persona

#### A. Finance/Admin — configure HO + a site end to end

Everything below uses company-scope grants (`ATTENDANCE_MANAGE`,
`WORK_SCHEDULE_MANAGE` at `COMPANY`) — no delegation flag needed.

```bash
# 1. (optional) check delegation flags — defaults all OFF
GET /org/company/delegations
→ 200 { "siteCreate": false, "siteUpdate": false, "deptManage": false,
        "placement": false, "employeeOnboard": false, "scheduleManage": false, "version": 3 }

# 2. HO timing — DEPARTMENT-scope schedule on the HO department
POST /schedules                                   # WORK_SCHEDULE_MANAGE @COMPANY
{ "scopeType": "DEPARTMENT", "departmentId": "<ho-dept-uuid>",
  "name": "HO Shift 10–19", "effectiveFrom": "2026-01-01",
  "revision": { "effectiveFrom": "2026-01-01", "timezone": "Asia/Kolkata",
    "workingWeekdays": [1,2,3,4,5,6],
    "intraday": { "scheduledStartMins": 600, "scheduledEndMins": 1140,
      "graceInMins": 10, "graceOutMins": 10,
      "breakWindowMode": "DYNAMIC", "breakWindowStartMins": 720,
      "breakWindowEndMins": 900, "breakDurationMins": 60,
      "autoClockOutMode": "AT_SCHEDULED_END" } } }
→ 201 { "schedule": { "id": "sch-…", "scopeType": "DEPARTMENT", "version": 0 },
        "revision": { "id": "rev-…", "revision": 1, "status": "ACTIVE", … } }

# 3. HO rules — COMPANY-scope policy (480 NET baseline, dynamic lunch)
POST /attendance/policies                       # ATTENDANCE_MANAGE @COMPANY
{ "name": "HO Policy", "scope": "COMPANY", "shiftDurationMins": 480,
  "halfDayThresholdMins": 240, "fullDayThresholdMins": 480,
  "breakMode": "DYNAMIC", "maxDynamicBreakMins": 120, "minWorkForBreakMins": 180,
  "overtimeMode": "HOURLY", "minOvertimeMins": 30, "otSlabMins": 30,
  "geofenceStrict": true, "allowMobilePunch": true, "requireTvtGate": false }
→ 201 { "id": "pol-…", "scope": "COMPANY", "version": 0, … }

# 4. Site — SITE-scope schedule + SITE-scope policy (payloads in §1b)
POST /schedules          # scopeType:"SITE", siteId — 08:00–17:00, FIXED_WINDOW 13:00–14:00
POST /attendance/policies # scope:"SITE", breakMode:"FIXED", fixedBreakMins:60, TVT gate on

# 5. Verify what an employee resolves to
GET /schedules/effective?employeeId=<ho-emp-uuid>&asOf=2026-03-02
→ 200 { "schedule": { "id": "sch-…", "name": "HO Shift 10–19" },
        "revision": { "id": "rev-…", "intraday": { … }, "timezone": "Asia/Kolkata" },
        "resolvedVia": "DEPARTMENT",                      // DEPARTMENT beat COMPANY
        "classification": { "day": "WORKING", "reason": "WORKING" } }

GET /schedules/effective?employeeId=<site-emp-uuid>&asOf=2026-03-02
→ 200 { "schedule": { "name": "Site Shift 8–17" }, "resolvedVia": "SITE",
        "classification": { "day": "WORKING", "reason": "WORKING" } }
```

`resolvedVia` tells you exactly which tier governs the employee that date —
`EMPLOYEE` (personal override) → `DEPARTMENT` (their membership's dept, incl. HO
depts) → `SITE` → `PROJECT` → `COMPANY`. `classification.day` is what the
holiday/override engine says about the date (`WEEKLY_OFF`/`HOLIDAY` mean the
intraday window is informational — punch flow still records but the day isn't a
scheduled working day).

#### B. PI — run a site day inside their project scope

All calls carry the PI's `x-company-id`; targets resolve to the PI's project /
child sites. A sibling-project site or an HO employee produces
`403 ACCESS_DENIED` — a foreign or unresolvable entity id resolves to `COMPANY`
and is denied there, so scope violations never disclose whether the id exists.

```bash
# 1. Morning — TVT + kiosk roll-call at OWN site (ATTENDANCE_RECORD @SITE)
POST /attendance/tvt            { "siteId": "<own-site>", "topic": "Heights briefing" }
POST /attendance/kiosk/batch-punch-in
{ "siteId": "<own-site>", "employeeIds": ["<e1>","<e2>"], "latitude": 25.6, "longitude": 85.1 }

# 2. Midday — dashboard (ATTENDANCE_READ @SITE)
GET /attendance/daily-summary?siteId=<own-site>&businessDate=2026-11-25
→ { "totalWorkers": 42, "inProgressSessions": 40, "totalPresentUnits": 38.5, … }

# 3. Correction at own site (ATTENDANCE_MANAGE @SITE)
POST /attendance/sessions/<id>/regularize
{ "punchOutAt": "2026-11-25T17:02:00Z", "remarks": "Missed punch-out, gate log verified" }
→ 200 { "status": "COMPLETED", "source": "MANUAL_CORRECTION", … }

# Missed whole day — manual session, also scoped MANAGE
POST /attendance/sessions
{ "employeeId": "<e1>", "siteId": "<own-site>",
  "punchInAt": "…08:02:00Z", "punchOutAt": "…17:05:00Z",
  "remarks": "Kiosk outage", "clientSessionId": "<uuid>" }
→ 201 { "source": "MANUAL_CORRECTION", "isFlagged": true, … }

# 4. Denied examples
POST /attendance/sessions/<sibling-site-session>/regularize   → 403 ACCESS_DENIED
POST /attendance/policies { "scope": "SITE", … }              → 403 — policies are company authority
GET  /attendance/muster-roll?siteId=<sibling-site>            → 403 ACCESS_DENIED

# 5. EOD — build + submit the site report
POST /attendance/daily-reports/calculate { "siteId": "<own-site>", "businessDate": "2026-11-25" }
POST /attendance/daily-reports/<dsr-id>/submit
```

#### C. Delegated schedule editing — company opts a PI in

```bash
# 1. Finance/Admin flips the flag (company scope)
PATCH /org/company/delegations
{ "scheduleManage": true, "expectedVersion": 3 }
→ 200 { "scheduleManage": true, "version": 4, … }

# 2. PI can now edit SITE/PROJECT schedules inside their project
POST /schedules                                        # PI, flag ON
{ "scopeType": "SITE", "siteId": "<own-site>", "name": "Site Shift 8–17 v2",
  "effectiveFrom": "2026-02-01",
  "revision": { "effectiveFrom": "2026-02-01", "timezone": "Asia/Kolkata",
    "workingWeekdays": [1,2,3,4,5,6],
    "intraday": { "scheduledStartMins": 480, "scheduledEndMins": 1020,
      "autoClockOutMode": "AT_SCHEDULED_END" } } }
→ 201 { "schedule": { … }, "revision": { "revision": 1 } }

# Same call with the flag OFF → 403 DELEGATION_DISABLED
# Same call scopeType:"DEPARTMENT" on an HO dept → 403 (HEAD_OFFICE stays Finance/Admin)
```

#### D. PD — oversight only

PD holds `ATTENDANCE_READ` (+`WORK_SCHEDULE_READ`) at PROJECT: sessions, daily
summary, muster roll, DSR list/detail/audit-trail, schedule + effective
previews inside the project. No punches for others, no regularize, no schedule
edits — those are PI (MANAGE) or company actions.

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

| Field                  | Rule                                                                                                                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `siteId`               | site anchor — **exactly one** of `siteId`/`headOfficeId` required                                                                                                                                                                             |
| `headOfficeId`         | head-office anchor — for Head-Office-department staff who have no site. Employee must hold an active membership in a department whose `baseHeadOfficeId` matches; geofence uses the head office's geo fields (`POST/PATCH /org/head-offices`) |
| `employeeId`           | optional — defaults to caller's employee; any other value → `ATTENDANCE_MANAGE`                                                                                                                                                               |
| `latitude`/`longitude` | **required**                                                                                                                                                                                                                                  |
| `source`               | `MOBILE_SELF` for self-punch. Any other value → `ATTENDANCE_MANAGE`. Omitted → auto-derived (`SUPERVISOR_KIOSK` when punching for someone else)                                                                                               |

Validation chain (inside one transaction):

1. Caller→employee resolution; supervisor/privileged-source → `ATTENDANCE_MANAGE`
2. Employee exists + `ACTIVE`; location anchor exists (`Site`, or `Head Office` +
   active department membership based there)
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
  "scheduleRevisionId": "rev-uuid", // pinned at punch-in — null when the employee has no schedule
  "scheduledStartAt": "2026-11-19T02:30:00.000Z", // resolved local shift window as UTC instants
  "scheduledEndAt": "2026-11-19T11:30:00.000Z",
  "autoClosedBy": null, // SCHEDULED_END | EOD_SETTLEMENT | STALE_SWEEP when system-closed
  "policySnapshot": {
    "shiftDurationMins": 480,
    "breakMode": "FIXED",
    "fixedBreakMins": 60,
    "…": "…"
  },
  "breaks": [
    { "id": "...", "breakType": "LUNCH", "startedAt": "...", "endedAt": "...", "durationMins": 30 }
  ],
  "version": 1
}
```

`status` ∈ `IN_PROGRESS | COMPLETED | AUTO_CLOSED | REJECTED`. `policySnapshot`
is the immutable copy of the calc-relevant policy values resolved at punch-in —
punch-out, regularization, and auto-close all compute from it, so a later
policy/schedule edit never rewrites this session's math.

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
- Durations and units are **recomputed** from effective times + the session's
  **pinned** policy/schedule snapshot (never the live policy) unless explicitly
  overridden (`presentUnits` / `overtimePUnits` / `overtimeHours`)
- Session ends `COMPLETED`, `source: MANUAL_CORRECTION`, `approvedBy`/`approvedAt`
  stamped with the correcting principal
- Response is the corrected session object (Step 6 shape)

### `POST /attendance/sessions` — manual missed-session correction

Creates a whole session for a fully missed day (or a missed punch-out that the
auto-close already claimed). Scope-authorized: the caller needs
`ATTENDANCE_MANAGE` at the resolved site/head-office target — PI/PD only inside
their own project/site. The server sets `source: MANUAL_CORRECTION`; **do not
send `source`**. `clientSessionId` makes replays idempotent (returns the
existing row instead of a duplicate).

```json
{
  "employeeId": "<uuid>",
  "siteId": "<uuid>", // exactly one of siteId | headOfficeId
  "punchInAt": "2026-11-19T08:02:00.000Z",
  "punchOutAt": "2026-11-19T17:05:00.000Z", // omit → leaves session IN_PROGRESS
  "remarks": "Kiosk outage; gate register verified",
  "clientSessionId": "<uuid>" // optional idempotency key
}
```

→ `201` + the session. The pinned schedule snapshot applies (late/early flags and
duration math use the schedule effective at `punchInAt`); the session is flagged
`MANUAL_CORRECTION`; audited `ATTENDANCE_MANUAL_SESSION_CREATED`.

### Auto-close → correct path

If the worker already closed the shift at scheduled end
(`status: AUTO_CLOSED`, `autoClosedBy: SCHEDULED_END`/`EOD_SETTLEMENT`/`STALE_SWEEP`):

1. A real `punch-out` afterwards is accepted and audited as
   `PUNCH_OUT_AFTER_AUTO_CLOSE` — the system punch-out instant is preserved,
   the session stays `AUTO_CLOSED` and is flagged.
2. To change the recorded times/units, use `regularize` above — it recomputes
   against the session's pinned schedule + policy snapshot.

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

## Step 9 — Daily Site Report (DSR) — sign-off workflow

Aggregates one site + business date into a materialized report that flows
`DRAFT → SUBMITTED → APPROVED|REJECTED → LOCKED` (terminal). `LOCKED` is the
month-end close — after it, regularizing a session no longer recalculates
that day's report.

```http
POST /attendance/daily-reports/calculate            # MANAGE — build/refresh the aggregate
{ "siteId": "<site-uuid>", "businessDate": "2026-11-21" }
```

```json
200 {
  "id": "dsr-uuid", "status": "DRAFT",
  "totalWorkersHeadcount": 42, "totalPresentUnits": "40.5",
  "totalOvertimeHours": "12.0", "totalFlaggedSessions": 2,
  "catAStaffCount": 8, "catAStaffUnits": "8.0",
  "catBDirectCount": 30, "catBDirectUnits": "29.5",
  "catCSubconCount": 4, "catCSubconUnits": "4.0", "version": 0
}
```

```http
PATCH /attendance/daily-reports/:id                       # MANAGE — DRAFT only, +version
{ "weather": "LIGHT_RAIN", "weatherStoppageHours": 2,
  "workProgressNotes": "Footing pour completed, bay 2",
  "siteObstaclesRemarks": "Crane breakdown 1 hr",
  "safetyIncidentReported": false, "safetyNotes": null, "version": 0 }

PATCH /attendance/daily-reports/:id/labour-summary/:summaryId   # MANAGE — correct a line
{ "headcount": 30, "presentUnits": 29.5, "overtimeHours": 6.0,
  "remarks": "Recounted", "reason": "Late punches added after regularize" }

POST /attendance/daily-reports/:id/submit          # RECORD — site supervisor sends it up
POST /attendance/daily-reports/:id/approve         # MANAGE
POST /attendance/daily-reports/:id/reject          # MANAGE — { "reason": "Headcount mismatch" }
POST /attendance/daily-reports/:id/lock            # MANAGE — optional { "reason": "Nov close" }

GET  /attendance/daily-reports?siteId=…&fromDate=…&toDate=…&status=SUBMITTED   # READ
GET  /attendance/daily-reports/:id                   # READ
GET  /attendance/daily-reports/:id/audit-trail       # READ — every transition + edit
```

Sign-off metadata (`submittedBy/At`, `approvedBy/At`, `rejectionReason`,
`lockedBy/At`) lands on the report row; the audit trail is append-only.
Edits on `DRAFT`/`SUBMITTED` reports and every session regularization trigger
an internal recalculate so aggregates stay honest until `LOCKED`.

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
Background (60s tick):
   • pinned scheduledEndAt reached (+AFTER_GRACE grace) → AUTO_CLOSED / SCHEDULED_END
   • EOD settlement (5 min) closes sessions whose business day ended —
     an overnight session still inside its pinned window is left alone
   • >24h IN_PROGRESS with no schedule → AUTO_CLOSED / STALE_SWEEP (safety net)
```

## Errors

| Code / error                                     | When                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `COMPANY_REQUIRED`                               | Missing `x-company-id`                                                                     |
| `AttendanceEntityNotFoundError`                  | Site/employee/session/break not found, inactive employee, or caller has no employee record |
| `ActiveSessionExistsError`                       | Second punch-in while `IN_PROGRESS` exists (also enforced by DB unique index)              |
| `GeofenceBreachError`                            | Punch-in outside radius with `geofenceStrict: true`                                        |
| `PunchNotAllowedError`                           | `source` disabled by policy (`allowMobilePunch`/`allowKioskPunch`/`allowBiometric`)        |
| `TvtSafetyBriefingRequiredError`                 | TVT required, not attended, `tvtGateAction: "BLOCK"`                                       |
| `NoActiveSessionError`                           | Punch-out/break with no open session                                                       |
| `BreakAlreadyActiveError`                        | Break start while another break is open                                                    |
| `NoActiveBreakError`                             | Break-end with no open break, or `breakId` already ended                                   |
| `AttendanceValidationError`                      | Regularize without `punchOutAt`, or out ≤ in                                               |
| `BreakModeConflictError` (`BREAK_MODE_CONFLICT`) | Policy `breakMode` and schedule `breakWindowMode` disagree — fix the contradictory config  |
| `InvalidDateRangeError` (`INVALID_DATE_RANGE`)   | Muster-roll `from`→`to` exceeds 31 days                                                    |
| `ConcurrencyError`                               | `expectedVersion` mismatch on policy update                                                |
| `FORBIDDEN`                                      | Missing permission — e.g. RECORD holder punching for someone else (needs MANAGE)           |

Per-item batch errors: `EMPLOYEE_NOT_ACTIVE`, `ACTIVE_SESSION_EXISTS`,
`GEOFENCE_BREACH`, `TVT_SAFETY_BRIEFING_REQUIRED`, `NO_ACTIVE_SESSION`,
`SESSION_SITE_MISMATCH`; sync items: `SYNCED | ALREADY_SYNCED | FAILED`.

## Known limitations

- **Policy authoring is company-only by design** — scoped roles (PI/PD/PM)
  manage records and (delegated) schedules, never `AttendancePolicy` rows.
- **Day-off enforcement is advisory** — a punch on a `WEEKLY_OFF`/`HOLIDAY`
  date still creates a session (recorded + auditable); the intraday window
  is informational on non-working days. Blocking punches on off-days is a
  policy decision, not yet a gate.
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

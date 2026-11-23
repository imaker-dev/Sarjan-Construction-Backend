# Project & Site Setup — API Guide

Step-by-step reference for the complete project lifecycle: prerequisites →
project creation (profile + land parcels + documents + approvals + optional
initial budget) → status transitions → updates → sites → site/project document
registers.

Base URL: `/api/v1`

```http
Authorization: Bearer <access-token>
x-company-id: <company-uuid>          # every tenant route — required
Content-Type: application/json        # multipart/form-data for /documents/upload
```

> **Two gate layers, always separate:**
>
> - **API permissions** (`ORG_*`, `DOCUMENT_*`) come from role assignments and
>   are checked against the scope target (company / project / site).
> - **Business operations** (`PROJECT_BUDGET_CREATE`, …) are enabled on
>   departments then granted to employees — required in addition for
>   `initialBudget` and all Finance APIs.
>
> **Document routes** resolve at PROJECT/SITE scope, so company-scope holders
> (owner, finance) **and** project-scoped PD/PI of *that* project can work the
> register. See the permission matrix in §10.

Conventions used everywhere:

- **Money/areas/quantities** are decimal *strings*: `"142500000.00"`.
- **Dates** are `YYYY-MM-DD`; timestamps in responses are ISO-8601.
- **PATCH semantics**: omitted keys are untouched; explicit `null` clears a
  nullable field.
- **Optimistic concurrency**: `expectedVersion` on PATCH/status calls —
  stale value → `409 VERSION_CONFLICT`.
- **`idempotencyKey`** accepted on state-changing endpoints that support it.

---

## Step 0 — Prerequisites (must exist before a project can be created)

Project creation **fails** until the company has:

1. An **ACTIVE primary Head Office** — `headOfficeId` is derived server-side
   from it; the client **never** sends it.
2. Both company-wide departments: `FINANCE` + `ADMINISTRATION` (created by
   onboarding bootstrap).

```
Company → primary Head Office (ACTIVE) → FINANCE + ADMINISTRATION depts → Project → Sites
```

If you created the company via `POST /platform/companies` + claim/onboard,
these exist already.

---

## Step 1 — Create a project

```http
POST /api/v1/org/projects
Permission: ORG_PROJECT_CREATE @ COMPANY
```

### Minimal payload

```json
{
  "code": "PRJ-007",
  "name": "Skyline Residency",
  "timezone": "Asia/Kolkata"
}
```

### Full payload (every group optional)

```json
{
  "code": "PRJ-007",
  "name": "Skyline Residency",
  "description": "2 towers, G+14, ~180 units",
  "projectType": "RESIDENTIAL",
  "projectSubtype": "High-rise apartments",
  "contractType": "LUMPSUM",

  "clientName": "ABC Realty Pvt Ltd",
  "clientContactName": "A. Sharma",
  "clientContactPhone": "+91-90000-00000",
  "clientContactEmail": "client@example.test",

  "contractRef": "WO-2026-114",
  "workOrderRef": "WO/ABC/114",
  "tenderRef": "TN-55/2026",
  "contractValue": "142500000.00",
  "contractCurrency": "INR",
  "contractDate": "2026-10-15",
  "workOrderDate": "2026-10-20",

  "locationAddressLine": "Plot 42, NH-30",
  "locationLocality": "Bihta",
  "locationCity": "Patna",
  "locationDistrict": "Patna",
  "locationState": "Bihar",
  "locationPin": "801103",
  "locationCountry": "India",
  "geoLatitude": 25.5612,
  "geoLongitude": 84.869,

  "scopeSummary": "2 towers + clubhouse",
  "landArea": "12500.00",
  "landAreaUnit": "SQM",
  "builtUpArea": "48000.00",
  "numBuildings": 2,
  "numFloorsMax": 14,
  "numUnits": 180,
  "linearLengthKm": null,
  "carriagewayWidthM": null,

  "startDate": "2026-12-01",
  "endDate": "2029-06-30",
  "ntpDate": "2026-11-15",
  "revisedEndDate": null,
  "actualStartDate": null,
  "actualEndDate": null,

  "timezone": "Asia/Kolkata",

  "landParcels": [
    {
      "surveyNo": "KH-112/45",
      "plotNo": "42",
      "area": "8500.00",
      "areaUnit": "SQM",
      "boundaryDescription": "NH-30 north, canal east",
      "possessionDate": "2026-11-01",
      "documentId": null
    }
  ],

  "documents": [
    {
      "documentId": "8f3c…-uuid",
      "documentType": "DRAWING",
      "title": "Tower-A GA Plan",
      "discipline": "ARCHITECTURAL",
      "documentNumber": "SKL-AR-101",
      "revision": "R2",
      "issueDate": "2026-09-20",
      "linkStatus": "FOR_CONSTRUCTION"
    }
  ],

  "approvals": [
    {
      "approvalType": "RERA",
      "issuingAuthority": "Bihar RERA",
      "jurisdiction": "Patna",
      "referenceNo": "BRERAP00891-1/452",
      "status": "APPLIED",
      "appliedDate": "2026-10-01",
      "documentId": null
    }
  ],

  "initialBudget": {
    "code": "BASE",
    "name": "Sanctioned Estimate",
    "currency": "INR",
    "notes": "Per tender TN-55/2026",
    "lines": [
      { "category": "MATERIAL", "description": "Civil materials", "amount": "80000000.00" },
      { "category": "LABOUR", "description": "Labour", "amount": "30000000.00" },
      { "category": "CONTINGENCY", "description": "Contingency", "amount": "10000000.00" }
    ]
  }
}
```

### Field reference — project profile

| Group | Fields | Notes |
|---|---|---|
| Identity | `code`* (≤40, unique/company), `name`* (≤200), `description`, `timezone`* (IANA) | `code`/`name` normalized |
| Classification | `projectType`, `projectSubtype`, `contractType` | enums below |
| Client | `clientName`, `clientContactName/Phone/Email` | |
| Contract | `contractRef`, `workOrderRef`, `tenderRef`, `contractValue`, `contractCurrency`, `contractDate`, `workOrderDate` | `contractValue`+`contractCurrency` must come **as a pair** |
| Location | `locationAddressLine`, `locationLocality`, `locationCity/District/State/Pin/Country`, `geoLatitude`/`geoLongitude` | coords must be **paired** |
| Scope | `scopeSummary`, `landArea`+`landAreaUnit`, `builtUpArea`, `numBuildings`, `numFloorsMax`, `numUnits`, `linearLengthKm`, `carriagewayWidthM` | `landArea`+`landAreaUnit` as a pair; type-specific fields are optional data, not hard-rejected |
| Programme | `startDate`, `endDate`, `ntpDate`, `revisedEndDate`, `actualStartDate`, `actualEndDate` | `endDate ≥ startDate`; actual dates are **not** constrained to planned range |
| Registers | `landParcels[]`, `documents[]`, `approvals[]` | max 50 each, created in the same transaction |
| Estimate | `initialBudget` | see §5 |

### Enums

- `projectType`: `RESIDENTIAL | COMMERCIAL | INDUSTRIAL | INFRASTRUCTURE | OTHER`
- `contractType`: `LUMPSUM | ITEM_RATE | EPC | DESIGN_BUILD | COST_PLUS | LABOUR_ONLY | OTHER`
- `areaUnit` / `landAreaUnit`: `SQM | SQFT | ACRE | HECTARE | BIGHA | KATHA`
- `documentType`: `MASTER_PLAN | LAYOUT_PLAN | DRAWING | BOQ | CONTRACT | WORK_ORDER | LAND_RECORD | SURVEY | GEOTECH_REPORT | APPROVAL_LETTER | HANDOVER_RECORD | SITE_PHOTO | SAFETY_PLAN | OTHER`
- `discipline`: `ARCHITECTURAL | STRUCTURAL | CIVIL | MEP | ELECTRICAL | PLUMBING | HVAC | FIRE_SAFETY | SURVEY | GEOTECHNICAL | OTHER`
- `linkStatus`: `DRAFT | ISSUED | FOR_CONSTRUCTION | SUPERSEDED | VOID`
- `approvalType`: `RERA | ENVIRONMENT_CLEARANCE | FIRE_NOC | LAND_CONVERSION | HEIGHT_CLEARANCE | HERITAGE | LOCAL_BODY | RAILWAY_NOC | HIGHWAY_NOC | FOREST_CLEARANCE | OTHER` (`OTHER` requires `customType`)
- `status` (approval): `APPLIED | UNDER_REVIEW | GRANTED | REJECTED | EXPIRED | REVOKED`
- `lines[].category`: `MATERIAL | LABOUR | EQUIPMENT | SUBCONTRACT | OVERHEAD | CONTINGENCY | OTHER`

### Response `201`

```json
{
  "id": "proj-uuid",
  "companyId": "company-uuid",
  "code": "PRJ-007",
  "name": "Skyline Residency",
  "status": "PLANNED",
  "headOfficeId": "ho-uuid",
  "projectType": "RESIDENTIAL",
  "version": 0,
  "createdAt": "…", "updatedAt": "…",
  "…": "all profile fields echoed",
  "initialBudget": {
    "budgetId": "budget-uuid",
    "revisionId": "revision-uuid",
    "totalAmount": "120000000.00"
  }
}
```

`initialBudget` appears only when supplied. The budget is **DRAFT** — the
total is computed server-side from `lines` (a client-supplied total is never
trusted).

---

## Step 2 — Project lifecycle transitions

```http
POST /api/v1/org/projects/:id/status
Permission: ORG_PROJECT_STATUS @ COMPANY
```

```json
{ "to": "ACTIVE", "expectedVersion": 0 }
```

Allowed transitions only:

```
PLANNED  → ACTIVE | ARCHIVED
ACTIVE   → ON_HOLD | COMPLETED | ARCHIVED
ON_HOLD  → ACTIVE | ARCHIVED
COMPLETED→ ARCHIVED
ARCHIVED → (terminal)
```

Response: updated project row. Invalid jump → `400` / `422` validation error.

> Assign `PROJECT_DIRECTOR`/`PROJECT_INCHARGE` **after** the project is ACTIVE —
> leadership grants reject non-ACTIVE projects. See
> `POST /employees/:id/assignments` (`roleKey`, `scopeType: "PROJECT"`,
> `scopeId: projectId`); one active holder per project per role.

---

## Step 3 — Update / read project

```http
PATCH /api/v1/org/projects/:id          ORG_PROJECT_UPDATE @ COMPANY
GET   /api/v1/org/projects/:id          ORG_PROJECT_READ   @ PROJECT :id
GET   /api/v1/org/projects?status=&headOfficeId=  ORG_PROJECT_READ @ COMPANY
```

```json
// PATCH — name set, contractValue cleared, optimistic check
{ "name": "Skyline Residency Ph-1", "contractValue": null, "contractCurrency": null, "expectedVersion": 3 }
```

`GET /:id` response = project row + registers:

```json
{
  "id": "proj-uuid", "code": "PRJ-007", "status": "ACTIVE", "version": 4,
  "landParcels": [ { "id": "…", "surveyNo": "KH-112/45", "area": "8500.00", "areaUnit": "SQM" } ],
  "documents":   [ { "id": "link-uuid", "documentId": "…", "documentType": "DRAWING",
                     "title": "Tower-A GA Plan", "discipline": "ARCHITECTURAL",
                     "revision": "R2", "linkStatus": "FOR_CONSTRUCTION" } ],
  "approvals":   [ { "id": "…", "approvalType": "RERA", "status": "APPLIED", "referenceNo": "…" } ]
}
```

---

## Step 4 — Land parcels (project-level land)

```http
POST /api/v1/org/projects/:id/parcels   ORG_PROJECT_UPDATE @ COMPANY
GET  /api/v1/org/projects/:id/parcels   ORG_PROJECT_READ   @ PROJECT :id
```

```json
// POST
{ "surveyNo": "KH-112/46", "plotNo": "43", "area": "4000.00",
  "areaUnit": "SQM", "possessionDate": "2026-11-05",
  "boundaryDescription": "west of tower A", "documentId": null }
```

```json
201
{ "id": "parcel-uuid", "projectId": "proj-uuid", "surveyNo": "KH-112/46",
  "area": "4000.00", "areaUnit": "SQM", "version": 0, "createdAt": "…" }
```

`area` (decimal string) and `areaUnit` are both required. Land parcels are
**project-level** — a site can point at one via `landParcelId` instead of
duplicating land data.

---

## Step 5 — Project documents (register + upload)

Two ways to put a document on the register — **link an existing Document**
(file already uploaded to the correct scope) or **upload a file** (multipart,
auto-scoped). File bytes never appear in JSON — no base64, no local paths.

### 5a. Link an existing document

```http
POST /api/v1/org/projects/:id/documents   DOCUMENT_LINK @ PROJECT :id
```

```json
{ "documentId": "doc-uuid",
  "documentType": "DRAWING",
  "title": "Tower-A GA Plan",
  "discipline": "ARCHITECTURAL",
  "documentNumber": "SKL-AR-101",
  "revision": "R2",
  "issueDate": "2026-09-20",
  "linkStatus": "FOR_CONSTRUCTION" }
```

The Document must be `AVAILABLE`, same company, and its upload scope must
*contain* the project (`COMPANY`-scope or this project's scope). Otherwise
`404`/`422`. Same document can't be linked twice (`409`).

### 5b. Upload a file (multipart)

```http
POST /api/v1/org/projects/:id/documents/upload   DOCUMENT_UPLOAD @ PROJECT :id
Content-Type: multipart/form-data
```

Fields: `file` (required) + optional `documentType`, `title`,
`documentNumber`, `discipline`, `revision`, `issueDate`, `linkStatus`.
The `Document` is stored at `PROJECT` scope and registered in one call.

```bash
curl -X POST …/documents/upload \
  -H "Authorization: Bearer $T" -H "x-company-id: $C" \
  -F "file=@tower-a-ga.pdf" -F "documentType=DRAWING" \
  -F "title=Tower-A GA Plan" -F "discipline=ARCHITECTURAL" -F "revision=R2"
```

### 5c. List & update register entries

```http
GET   /api/v1/org/projects/:id/documents              DOCUMENT_READ @ PROJECT :id
PATCH /api/v1/org/projects/:id/documents/:linkId      DOCUMENT_LINK @ PROJECT :id
```

```json
// PATCH — mark a drawing superseded
{ "linkStatus": "SUPERSEDED", "revision": "R3", "expectedVersion": 1 }
```

---

## Step 6 — External approvals / registrations

```http
POST  /api/v1/org/projects/:id/approvals                  ORG_PROJECT_UPDATE @ COMPANY
GET   /api/v1/org/projects/:id/approvals                  ORG_PROJECT_READ   @ PROJECT :id
PATCH /api/v1/org/projects/:id/approvals/:approvalId      ORG_PROJECT_UPDATE @ COMPANY
```

```json
// POST
{ "approvalType": "FIRE_NOC",
  "issuingAuthority": "Fire & Emergency Services",
  "jurisdiction": "Patna",
  "referenceNo": "FES/PAT/2026/334",
  "status": "APPLIED",
  "appliedDate": "2026-10-05",
  "validUntil": null,
  "documentId": null,
  "notes": "Submitted with layout plan" }
```

These are **external authority records** (RERA, fire NOC, environmental…) —
not the internal workflow approvals. `approvalType: "OTHER"` requires
`customType`. No approval type is universally mandatory — applicability
depends on jurisdiction/project type.

---

## Step 7 — `initialBudget` (optional estimate at creation)

Nested `initialBudget` creates `ProjectBudget` + first `BudgetRevision`
(DRAFT) + lines **in the same transaction** as the project. Totals are
computed server-side; the estimate is never stored on the Project row.

**Extra authority required** — `ORG_PROJECT_CREATE` alone is not enough:
`FINANCE_BUDGET_MANAGE` permission **plus** `PROJECT_BUDGET_CREATE` and
`PROJECT_BUDGET_REVISE` operations (or `COMPANY_OWNER`). Missing → `403`,
and the whole project creation rolls back.

After creation, the budget continues through the normal Finance API
(`/finance/budgets/:id/revisions`, submit → approve). The project-creation
response reports `{ budgetId, revisionId, totalAmount }`.

---

## Step 8 — Create a site

```http
POST /api/v1/org/sites
Permission: ORG_SITE_CREATE @ COMPANY
```

### Minimal payload

```json
{ "projectId": "proj-uuid", "code": "S-01", "name": "Main Tower Site" }
```

### Full payload

```json
{
  "projectId": "proj-uuid",
  "code": "S-01",
  "name": "Main Tower Site",
  "description": "Towers A+B works",
  "siteType": "MAIN_CONSTRUCTION",

  "addressLine1": "Plot 42, NH-30",
  "addressLine2": null,
  "locality": "Bihta",
  "city": "Patna",
  "district": "Patna",
  "state": "Bihar",
  "pinCode": "801103",
  "country": "India",
  "address": "free-text fallback",

  "geoLatitude": 25.5612,
  "geoLongitude": 84.869,
  "geoFenceRadiusM": 300,
  "timezone": null,

  "landParcelId": "parcel-uuid",
  "plotArea": "8500.00",
  "areaUnit": "SQM",
  "surveyNo": "KH-112/45",
  "possessionDate": "2026-11-01",
  "handoverDate": "2026-11-10",

  "scopeSummary": "Tower A + B works",
  "mobilizationDate": "2026-12-05",
  "accessArrangements": "Single gate on NH-30, security post",
  "facilities": { "power": true, "water": true, "labourCamp": false, "batchingPlant": true },

  "siteContactName": "R. Singh",
  "siteContactPhone": "+91-90000-11111",
  "siteContactEmail": "site@example.test",

  "accessInstructions": "Gate code on register; PPE mandatory",
  "emergencyDetails": "Assembly point: gate 2; first-aid at store",

  "documents": [
    { "documentId": "doc-uuid", "documentType": "SURVEY",
      "title": "Topo survey", "discipline": "SURVEY", "revision": "R0" }
  ]
}
```

### Field rules

| Rule | Detail |
|---|---|
| `projectId` | required; must exist in this company (cross-company → 404) |
| `timezone` | omitted/`null` → **inherits parent project timezone** |
| coordinates | `geoLatitude`/`geoLongitude` must be **paired**; ranges −90..90 / −180..180 |
| `geoFenceRadiusM` | requires coordinates; feeds attendance punch geofence |
| `landParcelId` | must reference a **land parcel of the same project** |
| `plotArea` + `areaUnit` | pair rule — one without the other → `422` |
| `siteType` | `MAIN_CONSTRUCTION \| BATCHING_PLANT \| LAYDOWN_YARD \| LABOUR_CAMP \| OFFICE \| STORE \| WORKSHOP \| OTHER` |
| `facilities` | free-form JSON object — validated shape TBD; keep to small boolean flags |
| **`accessInstructions`, `emergencyDetails`** | **sensitive** — accepted on write, but **omitted from all responses** unless the caller holds `ORG_SITE_SENSITIVE_READ`. Never returned in list payloads. |

Response `201`: site row (`status: PLANNED`, `version: 0`), sensitive fields
stripped per the rule above.

---

## Step 9 — Site lifecycle, update, read

```http
POST  /api/v1/org/sites/:id/status    ORG_SITE_STATUS  @ COMPANY
PATCH /api/v1/org/sites/:id           ORG_SITE_UPDATE  @ COMPANY
GET   /api/v1/org/sites/:id           ORG_SITE_READ    @ SITE :id
GET   /api/v1/org/sites?projectId=&status=  ORG_SITE_READ @ COMPANY
```

```json
// status body — same lifecycle enum as projects (OrgNodeStatus)
{ "to": "ACTIVE", "expectedVersion": 0 }
```

`GET /:id` returns the site + its `documents[]` register. Site leadership
comes from **existing assignments** — `SITE_ENGINEER` (`SITE` scope) or
project-scoped PD/PI — never an employee column on the site.

---

## Step 10 — Site documents

Identical shape to §5, at SITE scope:

```http
POST  /api/v1/org/sites/:id/documents           DOCUMENT_LINK   @ SITE :id
POST  /api/v1/org/sites/:id/documents/upload    DOCUMENT_UPLOAD @ SITE :id
GET   /api/v1/org/sites/:id/documents           DOCUMENT_READ   @ SITE :id
PATCH /api/v1/org/sites/:id/documents/:linkId   DOCUMENT_LINK   @ SITE :id
```

Link containment is wider here: the Document may be scoped to `COMPANY`,
the **parent project**, or the site itself.

### Who can do what

| Actor | Grant | Project docs | Site docs |
|---|---|---|---|
| Company owner / admin | `DOCUMENT_*` @ company | ✅ all projects | ✅ all sites |
| `FINANCE_MANAGER` / `FINANCE_STAFF` | `DOCUMENT_*` @ company | ✅ | ✅ |
| `PROJECT_DIRECTOR` / `PROJECT_INCHARGE` | `DOCUMENT_*` @ their project | ✅ own project only | ✅ own project's sites (ancestor chain) |
| Anyone else | — | ❌ 403 | ❌ 403 |

`POST .../documents/upload` additionally re-asserts `DOCUMENT_UPLOAD` inside
`DocumentService` — the check runs twice.

---

## Errors you will hit

| Code | Cause |
|---|---|
| `400` | schema violation — bad enum, missing required field, unpaired coords, bad decimal/date/uuid |
| `403` / `ACCESS_DENIED` | permission or operation gate failed (e.g. `initialBudget` without finance authority) |
| `404` | entity not found **or cross-company id** (tenant isolation is fail-closed) |
| `409 VERSION_CONFLICT` | stale `expectedVersion` |
| `409 ASSIGNMENT_EXISTS` / duplicate link | same document already on the register |
| `422` (validation) | business rule — e.g. `endDate < startDate`, `contractValue` without currency, parcel of a different project, `OTHER` approval without `customType` |

## Quick checklist for a new project

1. `POST /org/projects` (profile + optional parcels/documents/approvals/`initialBudget`) → `201`
2. `POST /org/projects/:id/status` → `ACTIVE`
3. Assign `PROJECT_DIRECTOR`/`PROJECT_INCHARGE` via `POST /employees/:id/assignments`
4. `POST /org/sites` per physical site
5. Upload/link drawings & records to project or site registers
6. Record external approvals as they arrive; PATCH status → `GRANTED`
7. Budget: submit/approve the DRAFT revision through `/finance/budgets/:id/revisions/…`

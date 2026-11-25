# Site Wallet & Finance Funding API — Step-by-Step Developer Guide

Complete, sequential walkthrough of the site wallet journey on **both sides**:

- **PI side** — request funds, confirm receipt, spend, voucher, reverse.
- **PD side** — read-only oversight of everything in their project scope.
- **Finance side** — create the wallet, decide requests, record transfers,
  resolve disputes, close short, execute reversals, manage account heads.

Every step shows the **exact request** and a **representative real response**.
Run them top to bottom — later steps use IDs created by earlier ones.

```
Base URL : http://localhost:3000/api/v1
Auth     : Authorization: Bearer <accessToken>
Tenant   : x-company-id: <company-uuid>     ← required on EVERY tenant call
Money    : decimal strings, INR ONLY — "45000.00". Any other currency is rejected.
```

> **Verification status:** all routes, schemas, and guards are implemented and
> covered by unit/API tests (998 passing). Real-PostgreSQL integration tests
> exist (44, guarded `erp_test` suite) but are blocked until the disposable
> database is reachable — see _Testing_ at the end.

---

## 0. The golden rule — when does the balance change?

The wallet balance moves **exactly twice** in this journey, and nowhere else:

| Step                                    | Action                                    | Balance effect                               |
| --------------------------------------- | ----------------------------------------- | -------------------------------------------- |
| A. Finance creates wallet               | `POST /finance/sites/:siteId/wallet`      | `0.00`                                       |
| B. PI submits funding request           | `POST …/funding-requests/:id/submit`      | none                                         |
| C. Finance **approves** ₹45,000         | `POST /approval-tasks/:taskId/decisions`  | **none** — approval is a decision, not money |
| D. Finance **records transfer** ₹45,000 | `POST …/transfers`                        | **none** — a bank record, not a credit       |
| E. **PI confirms receipt** ₹43,000      | `POST …/transfers/:id/confirm`            | **+43,000** ✅ ledger `CREDIT_FUNDING`       |
| F. PI posts expense ₹1,250              | `POST …/expenses`                         | **−1,250** ✅ ledger `DEBIT_EXPENSE`         |
| G. Finance executes reversal of F       | `POST /finance/wallet/ledger/:id/reverse` | **+1,250** ✅ ledger `REVERSAL_CREDIT`       |

Two hard boundaries:

1. **Only the PI's receipt confirmation credits the wallet.** Approval and
   Finance's transfer record never touch the balance — the credited amount is
   what the PI says physically arrived, not what Finance sent.
2. **The ledger is append-only.** `UPDATE`/`DELETE` on `WalletLedgerEntry`
   raise trigger errors; `SiteWallet.balance` cannot be changed by a direct
   update (a trigger only allows the ledger-sync to write it). Corrections are
   new `REVERSAL_*` rows, full amount only.

```mermaid
flowchart LR
    PI --1. request--> REQ[FundingRequest DRAFT]
    REQ --submit--> ATT[Attempt N + WorkflowInstance + Task]
    ATT --> TASK[/approval-tasks PENDING/]
    TASK --APPROVE amt--> APPR[APPROVED]
    TASK --REJECT reason--> REJ[REJECTED terminal]
    TASK --RETURN reason--> RET[RETURNED → edit → new attempt]
    APPR --Finance records transfer--> TR[Transfer RECORDED]
    TR --PI confirms full--> CONF[CONFIRMED + CREDIT_FUNDING]
    TR --PI confirms partial/zero--> DISP[DISPUTED + credit only received]
    DISP --resolve / supplementary / close-short--> DONE[FUNDED | CLOSED_SHORT]
    W[SiteWallet] <-.ledger only.- CONF
    W <-.debit.- EXP[Expense + DEBIT_EXPENSE]
    EXP -.Finance reversal.-> REV[REVERSAL_CREDIT]
```

---

## 0.1 Notifications — who sees what, when

Every committed mutation writes an `AuditLog` row **and** an `OutboxEvent` in
the same transaction → the relay delivers a `Notification` to the listed
recipients and pushes a WebSocket refresh hint on
`GET /notifications/stream`.

**The WS frame is a hint only** — it carries ids/status/voucherNo/siteId.
**Never** amounts, UTRs, reasons, narration, payee, discrepancy notes,
document URLs, or signatures. Clients refetch through the authorized API.

| Event (title)                                        | Trigger | Recipients                                                                                 |
| ---------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `Site wallet created`                                | A1      | FM + PD covering site                                                                      |
| `Funding request submitted (attempt N)`              | B3      | FM + PD + requesting PI                                                                    |
| `Funding request approved/rejected/returned`         | C2      | FM + PD covering site _(PI gets the generic `Approval task decided` event — no duplicate)_ |
| `Funding request cancelled`                          | B6      | FM + PD + PI                                                                               |
| `Wallet transfer recorded`                           | C3      | FM + PD + PI                                                                               |
| `Wallet receipt confirmed` / `discrepancy`           | D1      | FM + PD + PI                                                                               |
| `Wallet dispute resolved`                            | D3      | FM + PD + PI                                                                               |
| `Funding request closed short`                       | D4      | FM + PD + PI                                                                               |
| `Wallet expense posted`                              | E1      | FM + PD + PI                                                                               |
| `Cash voucher generated` / `Signed voucher attached` | E2/E4   | FM + PD + PI                                                                               |
| `Wallet evidence linked`                             | E5      | FM + PD                                                                                    |
| `Reversal requested` / `Ledger entry reversed`       | F1/F2   | FM + PD (+PI on request)                                                                   |

Delivery is at-least-once with dedupe on `eventKey`; a worker retry never
creates a second notification. After a WS reconnect, clients resync via
`GET /notifications`.

---

## PHASE A — Finance setup (once per site)

Actor: `FINANCE_MANAGER` (or Finance Staff where noted) — `FINANCE_WALLET_*`
permissions are company-scoped.

### A1 — Create the site wallet

```bash
POST /api/v1/finance/sites/$SITE/wallet
Authorization: Bearer $FM        x-company-id: $CO
Content-Type: application/json

{}
```

```json
→ 201
{ "wallet": { "id": "w-…", "companyId": "…", "siteId": "a4f2d8b1-…",
              "currency": "INR", "balance": "0", "status": "ACTIVE",
              "version": 0, "createdAt": "…", "updatedAt": "…" },
  "replayed": false }
```

Idempotent — repeat call returns `200` with the same wallet (`replayed: true`).
Currency is **always INR**; it is never derived from `Project.contractCurrency`.
One wallet per site (`23505` on a second insert).

### A2 — Create account heads (voucher line catalogue)

Company-managed — never seeded, never hardcoded. Finance maintains it.

```bash
POST /api/v1/finance/wallet/account-heads

{ "code": "5010", "name": "Materials" }
```

```json
→ 201 { "id": "ah-…", "companyId": "…", "code": "5010",
        "name": "Materials", "status": "ACTIVE", "version": 0 }
```

```bash
POST /api/v1/finance/wallet/account-heads
{ "code": "5020", "name": "Fuel & Diesel" }
POST /api/v1/finance/wallet/account-heads
{ "code": "5030", "name": "Labour Payments" }
```

`GET /finance/wallet/account-heads?status=ACTIVE&cursor=&limit=` lists them.
`PATCH /finance/wallet/account-heads/:id` updates `name`/`status` with
`expectedVersion` — deactivate (`"status": "INACTIVE"`), never delete; old
vouchers keep their code/name snapshots.

### A3 — Finance wallet views

```bash
GET /api/v1/finance/wallets?limit=50            # FINANCE_WALLET_READ
GET /api/v1/finance/wallets/$WALLET             # detail + site
GET /api/v1/finance/wallets/$WALLET/ledger?type=CREDIT_FUNDING&from=&to=&cursor=&limit=
```

---

## PHASE B — PI: funding request lifecycle

Actor: `PROJECT_INCHARGE` with an **active assignment covering the site**
(`SITE_WALLET_MANAGE` + `PETTY_CASH_REQUEST_SUBMIT` op). PD gets `403` on
every write below — PD holds `SITE_WALLET_VIEW` reads only.

### B1 — Create a draft request

```bash
POST /api/v1/sites/$SITE/wallet/funding-requests
Authorization: Bearer $PI        x-company-id: $CO

{ "amount": "50000.00",
  "purpose": "Site consumables and petty purchases — November",
  "neededByDate": "2026-11-30",
  "idempotencyKey": "pi-s01-fr-0001" }
```

```json
→ 201
{ "request": { "id": "fr-…", "siteId": "a4f2d8b1-…", "walletId": "w-…",
               "status": "DRAFT",
               "draftAmount": "50000.00",
               "draftPurpose": "Site consumables and petty purchases — November",
               "draftNeededByDate": "2026-11-30",
               "approvedAmount": null, "confirmedAmount": "0",
               "currentAttemptId": null,
               "requestedByPrincipalId": "…", "requestedByEmployeeId": "…",
               "idempotencyKey": "pi-s01-fr-0001", "version": 1 },
  "replayed": false }
```

Fields: `amount` **required** decimal INR string (>0, ≤2dp) · `purpose`
required 1–500 chars · `neededByDate` optional `YYYY-MM-DD` ·
`idempotencyKey` required ≤80 chars — same key + different amount/purpose →
`409 IDEMPOTENCY_CONFLICT`; same payload → `200` replay.

### B2 — Edit the draft (also the RETURNED flow)

```bash
PATCH /api/v1/sites/$SITE/wallet/funding-requests/fr-…

{ "amount": "48000.00", "expectedVersion": 1 }
```

```json
→ 200 { "id": "fr-…", "status": "DRAFT", "draftAmount": "48000.00", "version": 2 }
```

Only `DRAFT`/`RETURNED` requests edit; only the requesting PI; stale
`expectedVersion` → `409 VERSION_CONFLICT`. `neededByDate: null` clears it.

### B3 — Submit → immutable attempt + approval workflow

```bash
POST /api/v1/sites/$SITE/wallet/funding-requests/fr-…/submit

{ "idempotencyKey": "pi-s01-fr-0001-sub-1" }
```

```json
→ 201
{ "request": { "id": "fr-…", "status": "SUBMITTED",
               "currentAttemptId": "att-1-…", "version": 3 },
  "attempt": { "id": "att-1-…", "attemptNo": 1,
               "amount": "48000.00", "currency": "INR",
               "purpose": "Site consumables and petty purchases — November",
               "neededByDate": "2026-11-30", "status": "SUBMITTED",
               "workflowInstanceId": "wi-…", "approvalTaskId": "task-…",
               "submittedByPrincipalId": "…", "idempotencyKey": "pi-s01-fr-0001-sub-1" },
  "replayed": false }
```

Each submit creates a **new numbered attempt** and a **new workflow instance**
(`SITE_WALLET_FUNDING_APPROVAL` → FM approval task). Attempts are immutable
snapshots — after a `RETURN`, editing drafts and resubmitting produces
`attemptNo: 2` with attempt 1 and its decision fully preserved.

📨 `Funding request submitted (attempt 1)` → FM + PD + PI.

### B4 — PI tracks it

```bash
GET /api/v1/sites/$SITE/wallet/funding-requests?status=SUBMITTED&limit=50
→ 200 { "items": [ { "id","status","draftAmount","currentAttemptId",… } ],
        "nextCursor": null }

GET /api/v1/sites/$SITE/wallet/funding-requests/fr-…
→ 200 { "request": {…}, "attempts": [ {…full history…} ],
        "transfers": […], "documentLinks": […] }

GET /api/v1/sites/$SITE/wallet/funding-requests/fr-…/attempts
→ 200 [ { "attemptNo": 1, "status": "SUBMITTED", "amount": "48000.00",
          "workflowInstanceId": "wi-…", "approvedAmount": null,
          "decisionReason": null, "decidedAt": null }, … ]
```

### B5 — Cancel (only while DRAFT/RETURNED)

```bash
POST /api/v1/sites/$SITE/wallet/funding-requests/fr-…/cancel
{ "idempotencyKey": "pi-s01-fr-0001-cancel" }
→ 200 { "id": "fr-…", "status": "CANCELLED", "version": 4 }
```

Once `SUBMITTED` it cannot be cancelled — Finance must decide.

---

## PHASE C — Finance: queue, decision, transfer

### C1 — The queue

```bash
GET /api/v1/finance/wallet-funding-requests?status=SUBMITTED&projectId=&siteId=&limit=50
→ 200 { "items": [ { "id","status","draftAmount",
                     "site": { "id","code","name","projectId" }, … } ] }

GET /api/v1/finance/wallet-funding-requests/fr-…
→ 200 { "request": {…}, "attempts": [ {…,"approvalTaskId":"task-…"} ],
        "transfers": [] }
```

### C2 — Decide via the approval task (APPROVE / REJECT / RETURN)

Finance sees the task in their normal inbox:

```bash
GET /api/v1/approval-tasks?status=PENDING
→ 200 { "items": [ { "id": "task-…", "stageKey": "FINANCE_APPROVE",
                     "workflowInstanceId": "wi-…" } ] }
```

**Approve a specific amount** (required `decisionPayload.approvedAmount`,
positive, ≤ the submitted attempt amount):

```bash
POST /api/v1/approval-tasks/task-…/decisions

{ "action": "APPROVE",
  "idempotencyKey": "fm-dec-fr1-a1",
  "decisionPayload": { "approvedAmount": "45000.00" } }
```

```json
→ 201 { "decision": { "id": "dec-…", "action": "APPROVE",
                      "decisionPayload": { "approvedAmount": "45000.00" } },
        "task": { "id": "task-…", "status": "DECIDED" },
        "instance": { "id": "wi-…", "state": "APPROVED" },
        "transition": {…}, "replayed": false }
```

Atomically: decision + task close + workflow transition + attempt
`APPROVED/approvedAmount` + request `APPROVED/approvedAmount:45000.00` +
audit + outbox — all commit or roll back together. **Balance still `0`.**

```bash
# REJECT — reason required, terminal:
{ "action": "REJECT", "idempotencyKey": "fm-dec-…", "reason": "Budget exhausted" }

# RETURN — reason required; request goes RETURNED → PI edits → resubmits as attempt 2:
{ "action": "RETURN", "idempotencyKey": "fm-dec-…", "reason": "Split into two months" }
```

`decisionPayload` on REJECT/RETURN → `422`. Approver must not be the requester
(self-approval → `403`). Same `idempotencyKey` + different payload →
`409 IDEMPOTENCY_CONFLICT`; identical replay → `200` with the original
decision, **no domain re-run, no second event**.

### C3 — Record the actual bank transfer

```bash
POST /api/v1/finance/wallet-funding-requests/fr-…/transfers

{ "amount": "45000.00",
  "reference": "UTR-NEFT-88214",
  "transferredAt": "2026-11-24T10:30:00+05:30",
  "idempotencyKey": "fm-tr-88214" }
```

```json
→ 201
{ "transfer": { "id": "tr-…", "requestId": "fr-…", "attemptId": "att-1-…",
                "walletId": "w-…", "siteId": "a4f2d8b1-…",
                "amount": "45000.00", "currency": "INR",
                "reference": "UTR-NEFT-88214",
                "transferredAt": "2026-11-24T05:00:00.000Z",
                "status": "RECORDED", "confirmedAmount": "0",
                "recordedByPrincipalId": "…", "idempotencyKey": "fm-tr-88214" },
  "replayed": false }
```

Allowed only on `APPROVED`/`PARTIALLY_FUNDED` requests; Σ transfers ≤
approved amount; `reference` unique per request. **Still no credit** — this
is Finance's record of what was _sent_.

`GET …/transfers` lists them for Finance; `GET /sites/:siteId/wallet/transfers/:transferId` for the PI.

---

## PHASE D — PI confirms receipt → the ONLY credit

### D1 — Full or partial confirmation (PI only)

```bash
POST /api/v1/sites/$SITE/wallet/transfers/tr-…/confirm
Authorization: Bearer $PI        # requesting PI on a covering assignment

{ "receivedAmount": "45000.00", "idempotencyKey": "pi-cf-88214" }
```

```json
→ 201
{ "transfer": { "id": "tr-…", "status": "CONFIRMED",
                "confirmedAmount": "45000.00",
                "confirmedByPrincipalId": "…", "confirmedAt": "…" },
  "ledgerEntry": { "id": "le-…", "type": "CREDIT_FUNDING",
                   "amount": "45000.00", "currency": "INR",
                   "balanceAfter": "45000.00",
                   "fundingRequestId": "fr-…", "transferId": "tr-…" },
  "replayed": false }
```

**Balance: 0 → ₹45,000.** Request → `FUNDED`.

**Partial / zero receipt → dispute.** Only the received amount credits:

```bash
{ "receivedAmount": "43000.00",
  "discrepancyNote": "₹2,000 short — bank memo attached",
  "idempotencyKey": "pi-cf-88215" }
```

```json
→ 201 { "transfer": { "status": "DISPUTED",
                      "confirmedAmount": "43000.00",
                      "discrepancyAmount": "2000.00" },
        "ledgerEntry": { "type": "CREDIT_FUNDING", "amount": "43000.00",
                         "balanceAfter": "43000.00" } }
```

Request → `PARTIALLY_FUNDED` (`confirmedAmount 43000 / approved 45000`).
`discrepancyNote` is audit-only — never in notifications.

Only the **requesting PI** may confirm — PD, another PI, Finance → `403`.
`receivedAmount > transfer amount` → `422`; confirming more than the
remaining approved amount → `409`-class limit error. Replays are safe: the
ledger `(walletId, idempotencyKey)` unique key dedupes; same key + different
amount → `IDEMPOTENCY_CONFLICT`.

### D2 — Supplementary transfer (Finance sends the ₹2,000)

```bash
POST /api/v1/finance/wallet-funding-requests/fr-…/transfers
{ "amount": "2000.00", "reference": "UTR-NEFT-88299",
  "idempotencyKey": "fm-tr-88299" }
# PI then confirms it the same way → +2,000 → request FUNDED
```

### D3 — Resolve a dispute (Finance)

```bash
POST /api/v1/finance/wallet-transfers/tr-…/resolve-dispute

{ "resolution": "ACKNOWLEDGED",               # or SUPPLEMENTARY_PENDING
  "note": "Bank confirms ₹2,000 fee deduction — no further transfer",
  "idempotencyKey": "fm-disp-88215" }
→ 201 { "transfer": { "id": "tr-…", "status": "CLOSED",
                      "disputeResolution": "ACKNOWLEDGED: …" }, "replayed": false }
```

### D4 — Close short (Finance writes off the remainder)

```bash
POST /api/v1/finance/wallet-funding-requests/fr-…/close-short

{ "reason": "Remaining ₹2,000 will not be transferred",
  "idempotencyKey": "fm-close-fr1" }
→ 200 { "id": "fr-…", "status": "CLOSED_SHORT",
        "approvedAmount": "45000.00", "confirmedAmount": "43000.00",
        "closedShortReason": "…", "version": 6 }
```

Requires no open `RECORDED`/`DISPUTED` transfers; terminal — later transfers
and confirmations are rejected.

---

## PHASE E — PI: expenses, vouchers, evidence

### E1 — Post an expense (immediate debit)

```bash
POST /api/v1/sites/$SITE/wallet/expenses

{ "amount": "1250.00",
  "expenseDate": "2026-11-24",
  "description": "Cement for footing work",
  "payee": "Ramesh Kumar",
  "reference": "INV-881",
  "accountLines": [
    { "accountHeadId": "<Materials ah-id>", "amount": "1000.00" },
    { "accountHeadId": "<Fuel ah-id>",      "amount": "250.00" } ],
  "documentIds": [ "<optional-doc-uuid>" ],
  "idempotencyKey": "pi-s01-exp-0007",
  "voucher": { "paidTo": "Ramesh Kumar",
               "narration": "Cement for footing work" } }
```

```json
→ 201
{ "expense": { "id": "ex-…", "walletId": "w-…",
               "amount": "1250.00", "currency": "INR",
               "expenseDate": "2026-11-24", "category": "SPLIT",
               "description": "Cement for footing work",
               "payee": "Ramesh Kumar", "reference": "INV-881",
               "status": "POSTED", "evidenceState": "ATTACHED",
               "ledgerEntryId": "le-e7-…", "createdByPrincipalId": "…" },
  "ledgerEntry": { "id": "le-e7-…", "type": "DEBIT_EXPENSE",
                   "amount": "1250.00", "balanceAfter": "43750.00",
                   "expenseId": "ex-…" },
  "voucher": { "id": "cv-…", "voucherNo": 1,
               "lines": [ { "lineNo": 1, "accountCode": "5010",
                            "accountHeadName": "Materials", "amount": "1000.00" },
                          { "lineNo": 2, "accountCode": "5020",
                            "accountHeadName": "Fuel & Diesel", "amount": "250.00" } ] },
  "replayed": false }
```

**Balance: 45,000 → ₹43,750** — immediate, under the wallet row lock;
concurrent debits serialize and can never overdraw.

Rules: Σ `accountLines` **must equal** `amount` (else `422`); heads must be
company-owned `ACTIVE` heads; omit `voucher` → expense still posts
(`voucher: null`); omit `documentIds` → `evidenceState: "NONE"`. Client
never sends voucher number, total, currency, or company/site labels.

### E2 — Read / list expenses and the voucher

```bash
GET /api/v1/sites/$SITE/wallet/expenses?from=2026-11-01&to=2026-11-30&accountHeadId=&limit=
GET /api/v1/sites/$SITE/wallet/expenses/ex-…    # + voucher lines + doc links

GET /api/v1/sites/$SITE/wallet/vouchers/cv-…
→ 200 { "voucher": { "voucherNo": 1, "date": "2026-11-24",
                     "paidTo": "Ramesh Kumar",
                     "narration": "Cement for footing work",
                     "preparedByPrincipalId": "…",
                     "checkedByPrincipalId": null,
                     "signedDocumentId": null,
                     "lines": [ … ] },
        "total": "1250.00",
        "amountInWords": "One Thousand Two Hundred Fifty Rupees Only" }
```

### E3 — Print the Sarjan cash voucher

```bash
GET /api/v1/sites/$SITE/wallet/vouchers/cv-…/print
→ 200  text/html; charset=utf-8
```

Server-rendered A5-landscape document — company legal name + registered
address from the company profile, `CV-000001` number, date, site name/code,
account code/head rows with INR amounts, total, _amount in words (Indian
system — lakh/crore)_, narration, **Prepared By** (authenticated PI's name),
**Checked By** (blank until a real authorized check exists), **Receiver
Sign** box. Browser print / Save-as-PDF — no PDF dependency.

### E4 — Upload & attach the signed voucher

Two calls — upload first (existing document route), then link:

```bash
# 1) Upload the scan — multipart/form-data at site scope
POST /api/v1/org/sites/$SITE/documents/upload        # DOCUMENT_UPLOAD@SITE
Content-Type: multipart/form-data

file=<signed-voucher.pdf>          # binary part — the file itself
documentType=OTHER                 # optional metadata fields…
title=CV-000001 signed copy
→ 201 { "id": "lnk-…", "documentId": "doc-…", … }      # keep documentId

# 2) Attach it to the voucher
POST /api/v1/sites/$SITE/wallet/vouchers/cv-…/signed-document

{ "documentId": "doc-…" }
→ 200 { "id": "cv-…", "signedDocumentId": "doc-…", "signedAt": "…", "version": 1 }
```

Document must be `AVAILABLE`, same company, scope-covering the site; second
attach on the same voucher → `409`-class state error. A typed name is never
accepted as a signature — only the uploaded document.

### E5 — Evidence on ANY ledger transaction

```bash
POST /api/v1/sites/$SITE/wallet/ledger/le-…/documents
{ "documentId": "doc-…" }
→ 201 { "id": "lnk-…", "entityType": "WALLET_LEDGER_ENTRY",
        "walletLedgerEntryId": "le-…" }
```

Duplicate active link → `409`. Evidence **never** changes the ledger or
balance.

---

## PHASE F — Reversals (PI asks, Finance executes)

```bash
# F1 — PI requests a full reversal of a posted entry
POST /api/v1/sites/$SITE/wallet/ledger/le-e7-…/reversal-requests

{ "reason": "Expense was entered twice — duplicate of ex-…",
  "idempotencyKey": "pi-rev-0001" }
→ 201 { "reversalRequest": { "id": "rr-…", "ledgerEntryId": "le-e7-…",
                             "status": "REQUESTED" }, "replayed": false }

# F2 — Finance queue + execute
GET /api/v1/finance/wallet-reversal-requests?status=REQUESTED

POST /api/v1/finance/wallet/ledger/le-e7-…/reverse
{ "reason": "Duplicate confirmed",
  "reversalRequestId": "rr-…",
  "idempotencyKey": "fm-rev-0001" }
→ 201 { "entry": { "id": "le-r1-…", "type": "REVERSAL_CREDIT",
                   "amount": "1250.00", "balanceAfter": "45000.00",
                   "reversalOfEntryId": "le-e7-…" }, "replayed": false }
```

**Balance: 43,750 → ₹45,000.** Full amount only, exactly once per entry
(`reversalOfEntryId` unique); reversing a credit needs sufficient balance;
the source expense → `REVERSED` (voucher stays as evidence), the reversal
request → `EXECUTED`. Reversal entries cannot themselves be reversed.

---

## PHASE G — Ledger & reports (both sides)

```bash
# PI view — append-only, newest first, cursor = last seen seq
GET /api/v1/sites/$SITE/wallet/ledger?type=CREDIT_FUNDING&from=2026-11-01&limit=50
→ 200 { "items": [
    { "seq": "3", "type": "REVERSAL_CREDIT", "amount": "1250.00",
      "balanceAfter": "45000.00", "reversalOfEntryId": "le-e7-…",
      "postedByPrincipalId": "…", "postedAt": "…" },
    { "seq": "2", "type": "DEBIT_EXPENSE",  "amount": "1250.00",
      "balanceAfter": "43750.00", "expenseId": "ex-…", … },
    { "seq": "1", "type": "CREDIT_FUNDING", "amount": "45000.00",
      "balanceAfter": "45000.00", "transferId": "tr-…", … } ],
  "nextCursor": null }

GET /api/v1/finance/wallets/$WALLET/ledger        # same, Finance side

GET /api/v1/sites/$SITE/wallet
→ 200 { "wallet": { "balance": "45000.00", "status": "ACTIVE", "currency": "INR" },
        "pendingRequests": 0, "approvedAmount": "0", "confirmedAmount": "0" }

GET /api/v1/sites/$SITE/wallet/reports?from=&to=
→ 200 { "walletId": "w-…", "siteId": "…", "balance": "45000.00",
        "currency": "INR",
        "byType": [ { "type": "CREDIT_FUNDING", "count": 1, "total": "45000.00" },
                    { "type": "DEBIT_EXPENSE",  "count": 1, "total": "1250.00" },
                    { "type": "REVERSAL_CREDIT","count": 1, "total": "1250.00" } ],
        "postedExpenses": 1 }
```

`wallet.balance` always equals the latest entry's `balanceAfter` — the DB
sync trigger guarantees it; direct balance updates are rejected.

---

## Who can do what (PI vs PD vs Finance)

| Capability                                                  | PI                           | PD                 | Finance                  |
| ----------------------------------------------------------- | ---------------------------- | ------------------ | ------------------------ |
| Read wallet/ledger/requests/expenses/vouchers/reports @site | ✓                            | ✓ (oversight only) | ✓ company-wide           |
| Create/edit/submit/cancel funding requests                  | ✓ own site                   | ✗                  | —                        |
| Approve / reject / return                                   | ✗                            | ✗                  | ✓ FM (never own request) |
| Record transfers / resolve disputes / close-short           | ✗                            | ✗                  | ✓                        |
| **Confirm receipt**                                         | **✓ only the requesting PI** | **✗ by default**   | ✗                        |
| Post expenses / vouchers / attach evidence                  | ✓                            | ✗                  | ✗                        |
| Request reversals                                           | ✓                            | ✗                  | —                        |
| Execute reversals                                           | ✗                            | ✗                  | ✓ FM                     |
| Manage account heads                                        | read active list             | read               | ✓ FM                     |

Two gates on every write: API permission (`SITE_WALLET_*` site-scoped /
`FINANCE_WALLET_*` company-scoped) **and** the employee operation key
(`PETTY_CASH_*` / `PROJECT_WALLET_*`), plus the PI-covering-assignment
check for site writes.

## Errors you'll meet

| Code                        | When                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `403 NOT_SITE_PI`           | Write attempted without a covering PROJECT_INCHARGE grant                                             |
| `403 NOT_RECEIPT_CONFIRMER` | Anyone but the requesting PI confirms                                                                 |
| `409 IDEMPOTENCY_CONFLICT`  | Same key, different payload fingerprint                                                               |
| `409 VERSION_CONFLICT`      | Stale `expectedVersion`                                                                               |
| `422`                       | Bad decimal, Σ lines ≠ amount, `receivedAmount > amount`, non-object `decisionPayload`, unknown field |
| `409`-class state           | Wrong status for the transition (edit SUBMITTED, confirm DISPUTED, transfer on DRAFT…)                |
| `409`/limit                 | Transfers or confirmations exceeding the approved amount                                              |
| `403 ACCESS_DENIED`         | Cross-company/cross-site ids — composite bindings make mismatch impossible                            |

## Testing

- `npm test` — 998 unit/API tests including OpenAPI route↔doc reconciliation.
- `TEST_DATABASE_URL=postgresql://…@localhost:55432/erp_test npx vitest run --config vitest.integration.config.ts` — 44 guarded real-PG checks (append-only ledger, balance chain, overdraft, composite FKs, reversal uniqueness, document links, INR CHECKs, direct-update guard, voucher totals, numbering). Currently blocked — port 55432 is inside a Hyper-V exclusion on the dev host; the suite skips silently rather than passing.

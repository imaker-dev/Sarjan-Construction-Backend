# Realtime Notifications — WebSocket Guide

Step-by-step guide to the live notification channel: how to authenticate,
connect, receive events, mark read, and recover after reconnect. Every claim
below matches the running implementation — no Socket.IO, no client-chosen
rooms; the transport is `@fastify/websocket` + Redis pub/sub.

---

## 0. The big picture

```
leave mutation + audit + OutboxEvent        ── one DB transaction
        │
        ▼  (after commit only)
relay worker (BullMQ, every 500 ms)
   ├─ Notification row per recipient        ── durable inbox (source of truth)
   ├─ Redis publish  notif:<company>:<pid>  ── realtime push
   └─ NotificationEmailDelivery + SMTP      ── email (retryable, verified only)
        │
        ▼
WebSocket gateway  →  your connected app
```

A notification exists **before** it is pushed — the inbox API is the record,
the socket is a push hint. A socket being offline never loses a notification;
it just reads the inbox on the next connect.

---

## 1. Endpoints

| Purpose               | Method          | URL                                  |
| --------------------- | --------------- | ------------------------------------ |
| Inbox (cursor-paged)  | `GET`           | `/api/v1/notifications`              |
| Unread badge          | `GET`           | `/api/v1/notifications/unread-count` |
| Mark read             | `POST`          | `/api/v1/notifications/:id/read`     |
| Browser socket ticket | `POST`          | `/api/v1/notifications/ticket`       |
| **Realtime stream**   | `GET` (upgrade) | `/api/v1/notifications/stream`       |

All REST calls need `Authorization: Bearer <access token>` **and**
`x-company-id: <company uuid>`.

---

## 2. Connect — pick ONE auth path

### 2a. Browser / SPA (recommended: ticket)

Browsers cannot set custom headers on `new WebSocket()`. The server issues a
**30-second, single-use ticket** carried in the WebSocket subprotocol.

**Step 1 — mint the ticket:**

```http
POST /api/v1/notifications/ticket
Authorization: Bearer <accessToken>
x-company-id: <companyId>
Content-Type: application/json

{ "companyId": "<companyId>" }
```

```json
{ "ticket": "eyJhbGciOi…", "expiresInSeconds": 30 }
```

**Step 2 — connect with the ticket as the subprotocol** (prefix required):

```ts
const socket = new WebSocket(
  'wss://your-host/api/v1/notifications/stream',
  `sarjan-ticket.${ticket}`,
);
```

Rules:

- Use it **once**, within 30 seconds — the ticket is consumed atomically at
  the upgrade; a second connection attempt with the same ticket is rejected.
- The ticket already carries `sub`, `sid`, `companyId`, `jti` — no headers
  needed on the socket itself.
- Ticket JWT type is `NOTIF_TICKET`; an access token here is rejected.

### 2b. Native app / CLI / server-to-server (Bearer)

Custom headers are allowed, so no ticket is needed:

```http
GET /api/v1/notifications/stream
Authorization: Bearer <accessToken>
x-company-id: <companyId>
Sec-WebSocket-Protocol: (none required)
```

```ts
import WebSocket from 'ws';

const socket = new WebSocket('wss://your-host/api/v1/notifications/stream', {
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'x-company-id': companyId,
  },
});
```

The server re-validates the session (`sub` + `sid`) and company membership at
upgrade time — an expired session or non-member cannot open the stream.

### Auth failures

| Close code | Reason            | Meaning                              |
| ---------- | ----------------- | ------------------------------------ |
| `4401`     | `unauthorized`    | no/invalid credentials at upgrade    |
| `4403`     | `session revoked` | session died mid-connection (see §6) |

Reconnect with a fresh ticket/token when you get either.

---

## 3. What the server sends you

Each frame is a JSON string — exactly these fields:

```json
{
  "notificationId": "9f2c…uuid",
  "eventType": "LEAVE_REQUEST_APPROVED",
  "title": "Your CASUAL leave request was approved (2026-11-20 to 2026-11-25)",
  "resourceType": "LEAVE_REQUEST",
  "resourceId": "7b1d…uuid",
  "createdAt": "2026-11-18T09:12:33.000Z"
}
```

- `notificationId` — stable id; dedupe on the client if you already have it.
- `resourceType` + `resourceId` — deep-link key, e.g.
  `router.push(`/leave/requests/${resourceId}`)` for `LEAVE_REQUEST`.
- **No** free-text reasons, decision remarks, medical details, document ids,
  recipient ids, or emails — ever. Sensitive content stays in the API.

`eventType` values emitted today:

| eventType                                                  | resourceType           | Who gets it                     |
| ---------------------------------------------------------- | ---------------------- | ------------------------------- |
| `LEAVE_REQUEST_SUBMITTED`                                  | `LEAVE_REQUEST`        | requester (confirm) + approvers |
| `LEAVE_REQUEST_RESUBMITTED`                                | `LEAVE_REQUEST`        | requester + approvers           |
| `LEAVE_REQUEST_APPROVED` / `_REJECTED` / `_RETURNED`       | `LEAVE_REQUEST`        | requester                       |
| `LEAVE_REQUEST_CANCELLED`                                  | `LEAVE_REQUEST`        | approvers                       |
| `WORKFLOW_TRANSITIONED`, `APPROVAL_TASK_OPENED`/`_DECIDED` | workflow/approval rows | task actors                     |
| `DOCUMENT_APPROVED` / `DOCUMENT_REJECTED`                  | `DOCUMENT`             | owner                           |
| `SITE_WALLET_*`, `WALLET_FUNDING_*`, …                     | wallet aggregates      | finance/scoped roles            |

Treat unknown `eventType` values as forward-compatible — render title +
deep-link, don't crash.

---

## 4. Client skeleton (browser)

```ts
async function connectNotifications(accessToken: string, companyId: string) {
  // 1. catch up on anything missed while offline
  const inbox = await fetch('/api/v1/notifications?limit=50&unreadOnly=true', {
    headers: { Authorization: `Bearer ${accessToken}`, 'x-company-id': companyId },
  }).then((r) => r.json());
  inbox.notifications.forEach(renderNotification);

  // 2. open the stream for live pushes
  const { ticket } = await fetch('/api/v1/notifications/ticket', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-company-id': companyId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ companyId }),
  }).then((r) => r.json());

  const ws = new WebSocket(
    `${location.origin.replace('http', 'ws')}/api/v1/notifications/stream`,
    `sarjan-ticket.${ticket}`,
  );
  ws.onmessage = (e) => renderNotification(JSON.parse(e.data as string));
  ws.onclose = (e) => {
    // 4401/4403 → re-auth; otherwise back off and repeat step 1+2
    setTimeout(() => void connectNotifications(accessToken, companyId), 5_000);
  };
}
```

---

## 5. Read state + badge

```bash
GET  /api/v1/notifications?unreadOnly=true&limit=50   # unread inbox
GET  /api/v1/notifications/unread-count               # → { "unreadCount": 3 }
POST /api/v1/notifications/:id/read                   # → { "id": "…", "readAt": "…" }
```

- Mark read from the **inbox id** (`notificationId` on the frame = the row id).
- A user can only ever read/mark their own rows — recipient is bound from the
  token; there is no way to supply another principal.

---

## 6. Connection lifecycle (server-side)

| Behavior                 | Detail                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Binding                  | `{principalId, companyId, sessionId}` — derived from verified auth only; clients never supply ids or rooms |
| Channel                  | `notif:<companyId>:<principalId>` — one Redis subscription per user per instance, shared across their tabs |
| Keepalive                | server `ping()` every 30 s; a socket that stops ponging is terminated                                      |
| Session revalidation     | every 60 s the session+principal is re-checked; revoked → `close(4403, 'session revoked')`                 |
| Multi-tab / multi-device | unlimited sockets per user — every one receives the frame                                                  |
| Offline                  | frames with zero live subscribers are fine — `publishedAt` still set; the row stays in the inbox           |
| Crash recovery           | durable rows with `publishedAt: null` are republished by the 60 s sweep                                    |

Scaling note: any app instance holding your socket receives it — Redis
pub/sub fans the message out to whichever instance you are connected to, so
horizontal replicas are transparent.

---

## 7. Reconnect + catch-up (required pattern)

1. On `close` (any code): wait with backoff (e.g. 2 s → 30 s cap + jitter).
2. Re-fetch `GET /api/v1/notifications` with your last `cursor` **or** simply
   `unreadOnly=true` — the durable inbox is the source of truth.
3. Mint a **fresh** ticket (tickets are single-use) and reconnect.
4. Dedupe frames by `notificationId` against rows you already rendered.

Never treat the socket as the only delivery — a reconnect must always assume
frames were missed.

---

## 8. Security contract (what you can rely on)

- Tenant + principal come **only** from verified claims — a frame can never
  cross companies or users; `x-company-id` is validated against membership.
- Single-use tickets: `typ: NOTIF_TICKET`, 30 s TTL, `jti` consumed in Redis
  atomically — replay is rejected.
- Sessions are killed mid-stream within ~60 s of revocation (4403).
- Payloads are privacy-safe by construction (§3) — reason/remarks/documents
  never leave the API.
- TLS: use `wss://` in production; the channel rides the same CORS/auth
  boundary as the REST API.

---

## 9. Config knobs

| Env                         | Default                 | Effect                                                                                         |
| --------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| `NOTIFICATIONS_WORKER`      | `auto`                  | `on`/`auto`(+prod) starts the BullMQ relay+email worker inside the app; `off` disables (tests) |
| `APP_BASE_URL`              | `http://localhost:3000` | trusted origin for email deep links — never the request `Host`                                 |
| `SMTP_*`                    | —                       | email delivery; absent/unconfigured mail service simply leaves deliveries durable              |
| `REDIS_HOST` / `REDIS_PORT` | —                       | pub/sub + worker queue                                                                         |

---

## 10. Quick troubleshooting

| Symptom                     | Cause                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `4401` immediately          | missing Bearer/`x-company-id`, or expired/again-used ticket — mint a new one                     |
| `4403` after ~1 min         | session revoked server-side — re-login                                                           |
| Connected but silent        | only events for _your_ `(company, principal)` push — check the inbox API to confirm a row exists |
| Event in inbox but no frame | Redis blip — 60 s sweep republishes; the row was never lost                                      |
| Duplicate frames            | rare on reconnect overlap — dedupe by `notificationId`                                           |

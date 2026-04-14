# Week-2 Collab UX — Manual Smoke Verification Checklist

**Theme:** 协作体验补完 (Collaboration UX Completion)  
**Date:** 2026-04-13  
**Scope:** Mention candidate API, batch mark-as-read, presence + viewer identity, full flow

---

## Prerequisites

- [ ] Backend server running (`pnpm dev` or `docker-compose up`)
- [ ] At least 3 test users seeded: `user_a`, `user_b`, `user_c` (or use dev-token flow)
- [ ] At least one spreadsheet with 2+ records exists
- [ ] Browser DevTools open to inspect network requests

---

## Section 1 — Mention Candidate API

### Endpoint: `GET /api/comments/mention-candidates?spreadsheetId=<id>&q=<query>`

- [ ] **1.1** Query `?q=al` returns users whose name or email contains "al"
- [ ] **1.2** Result items have shape `{ id, label, subtitle? }` — no extra fields required
- [ ] **1.3** `subtitle` is present and equals the user's email when display name differs from email
- [ ] **1.4** `subtitle` is absent/undefined when display name equals email
- [ ] **1.5** Query `?q=` (empty) returns all active users (up to default limit)
- [ ] **1.6** `?limit=3` returns at most 3 candidates
- [ ] **1.7** Result `total` field reflects full match count (not capped to `limit`)
- [ ] **1.8** Missing `spreadsheetId` returns HTTP 400

---

## Section 2 — Batch Mark-as-Read

### Endpoint: `POST /api/comments/mention-summary/mark-read`  
Body: `{ "spreadsheetId": "<id>" }`

- [ ] **2.1** As `user_b` (who has unread mentions): POST returns HTTP 204
- [ ] **2.2** After marking read, `GET /api/comments/unread-count` returns `mentionUnreadCount: 0`
- [ ] **2.3** Second POST to same endpoint returns 204 (idempotent)
- [ ] **2.4** After second POST, `unreadCount` remains 0 (no error, no double-decrement)
- [ ] **2.5** As `user_c` (who did NOT call mark-read): their `mentionUnreadCount` is unchanged
- [ ] **2.6** Author's own `getInbox` is empty — marking read has no visible effect for them
- [ ] **2.7** POST with empty spreadsheetId returns HTTP 400

---

## Section 3 — Presence with Viewer Identity

### Endpoint: `GET /api/comments/summary?spreadsheetId=<id>`  
(With optional `rowIds=<row1>,<row2>`)

- [ ] **3.1** Response without filtering returns all rows with unresolved comments
- [ ] **3.2** `unresolvedCount` matches the number of unresolved comments on that record
- [ ] **3.3** `mentionedCount` reflects comments where the authenticated user is @-mentioned
- [ ] **3.4** Record with no comments is NOT included in the response
- [ ] **3.5** Filtering by `rowIds=row_5` returns only `row_5`'s presence data
- [ ] **3.6** Response includes `fieldCounts` map for cell-level comment breakdown

---

## Section 4 — Full UX Flow

### End-to-end scenario:

- [ ] **4.1** `user_a` creates a comment on `record_1` with `@user_b`
  - POST `/api/comments` with `{ mentions: ["user_b"] }` → 201
- [ ] **4.2** `user_b` checks inbox
  - GET `/api/comments/inbox` → comment appears with `mentioned: true, unread: true`
- [ ] **4.3** `user_b` deep-links to `record_1`
  - GET `/api/comments/summary?spreadsheetId=<id>&rowIds=record_1` → `unresolvedCount >= 1`
- [ ] **4.4** `user_b` marks all mentions read
  - POST `/api/comments/mention-summary/mark-read` → 204
  - GET `/api/comments/unread-count` → `mentionUnreadCount: 0`
- [ ] **4.5** `user_a` edits comment to add `@user_c`
  - PATCH `/api/comments/<id>` with new content including `@[UserC](user_c)`
  - `user_c` should receive a `comment:mention` socket event
  - `user_b` should NOT receive a new notification (was already mentioned)
- [ ] **4.6** `user_b` replies to the comment (thread)
  - POST `/api/comments` with `parentId` set → 201 with `parentId` in response
  - GET `/api/comments?spreadsheetId=<id>&rowId=record_1` → lists parent AND reply
- [ ] **4.7** `user_a` leaves the record view
  - WebSocket disconnect event fires
  - Presence socket room for that record updates
- [ ] **4.8** Verify `comment:activity` events appear in realtime on other open tabs

---

## Section 5 — Backward Compatibility

- [ ] **5.1** `GET /api/comments/unread-count` response includes `count` field
  - `count === unreadCount` (legacy alias maintained)
- [ ] **5.2** Creating a comment with `content: "Hello @[Jamie](user_jamie)"` (no explicit mentions)
  - Response `mentions` array contains `"user_jamie"`
- [ ] **5.3** `GET /api/comments?spreadsheetId=<id>` returns same shape as before
  - Each comment has `spreadsheetId`, `rowId`, `content`, `mentions`, `resolved`
- [ ] **5.4** Old client using `containerId` / `targetId` aliases still works for POST
  - POST with `containerId` instead of `spreadsheetId` → 201 success
- [ ] **5.5** `GET /api/comments/unread-count` returns both `unreadCount` AND `mentionUnreadCount`
  - Both fields present as numbers in the response

---

## Sign-Off

| Tester | Date | Result | Notes |
|--------|------|--------|-------|
|        |      |        |       |

**Overall status:** ☐ PASS  ☐ FAIL  ☐ PARTIAL

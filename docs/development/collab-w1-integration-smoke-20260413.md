# Week-1 Collab Semantics — Manual Smoke Verification Checklist

**Date:** 2026-04-13  
**Scope:** Week 1 of the Feishu gap roadmap — comment unread/mention split  
**Related PRs:** #856 (contracts lane), #857 (runtime lane), #858 (integration lane)

This document describes manual verification steps for a running MetaSheet environment.  
Use it to confirm the comment flow works end-to-end after the three Week-1 PRs land.

---

## Prerequisites

- A running MetaSheet backend (`pnpm dev` or Docker)
- A running MetaSheet frontend
- At least two test user accounts (referred to as **User A** and **User B** below)
- A base with at least one sheet and one record

---

## 1. Full Comment Lifecycle

### 1.1 Create a comment

1. Log in as **User A**.
2. Open any record in a sheet.
3. Click the comment icon or open the comment panel.
4. Type a comment (e.g., `"Hello from User A"`) and submit.
5. **Expected:** Comment appears in the comment panel with User A's avatar and timestamp.
6. **Expected:** The comment body is stored correctly (no corruption).

### 1.2 Edit a comment

1. Hover the comment just created as **User A**.
2. Click **Edit** (pencil icon).
3. Change the text to `"Edited by User A"` and save.
4. **Expected:** Comment content updates immediately.
5. **Expected:** An `(edited)` label or updated timestamp is shown.

### 1.3 Delete a leaf comment

1. As **User A**, delete the comment created above (it has no replies).
2. **Expected:** Comment disappears from the thread.
3. **Expected:** No error toast appears.

### 1.4 Delete a comment with replies (should be blocked)

1. As **User A**, create a root comment.
2. As **User B**, reply to it.
3. As **User A**, attempt to delete the root comment.
4. **Expected:** Delete is rejected (error message or button disabled).

---

## 2. Unread Semantics

### 2.1 Non-author sees new comment as unread

1. Log in as **User A** and post a comment on record R1.
2. Log in as **User B** (who did not write the comment).
3. **Expected:** The unread badge on the "Comments" notification icon shows ≥ 1.
4. **Expected:** GET `/api/comments/unread-count` returns `{ data: { unreadCount: N, count: N, mentionUnreadCount: M } }` with `N ≥ 1`.

### 2.2 Author does NOT see their own comment as unread

1. Stay logged in as **User A** after posting.
2. **Expected:** User A's unread badge count does NOT increase for their own comment.
3. **Expected:** GET `/api/comments/unread-count` for User A returns `unreadCount = 0` for the comment they just posted.

### 2.3 Mark a comment as read

1. As **User B**, open the comment panel for record R1.
2. Click the "Mark as read" action (or simply view the comment if auto-read is implemented).
3. **Expected:** The unread badge decrements by 1.
4. **Expected:** GET `/api/comments/unread-count` for User B returns the decremented count.

---

## 3. Mention Contract

### 3.1 @[Name](userId) mention parsing

1. As **User A**, write a comment containing `@` and select **User B** from the mention autocomplete.
2. The resulting comment body should contain `@[User B Display Name](user_b_id)`.
3. **Expected:** After saving, the comment's `mentions` array includes `user_b_id`.
4. **Expected:** User B's `mentionUnreadCount` in GET `/api/comments/unread-count` increases.

### 3.2 mentionUnreadCount vs unreadCount split

1. Using the API (or UI), verify the response of GET `/api/comments/unread-count` for **User B** after:
   - User A posts a **plain comment** (no @mention): `unreadCount++`, `mentionUnreadCount` unchanged.
   - User A posts a **@User B mention comment**: both `unreadCount++` AND `mentionUnreadCount++`.
2. **Expected shape:**
   ```json
   {
     "ok": true,
     "data": {
       "unreadCount": 3,
       "mentionUnreadCount": 1,
       "count": 3
     }
   }
   ```

### 3.3 Backward compat: `count` field present

1. Call GET `/api/comments/unread-count` with User B's auth token.
2. **Expected:** Response body includes `data.count` (integer, same value as `data.unreadCount`).
3. **Expected:** Any older client relying on `data.count` continues to work correctly.

---

## 4. Inbox Verification

### 4.1 Inbox shows only comments where user was @-mentioned OR there is unread activity

1. As **User A**, post three comments on different records:
   - Comment 1: plain, no mentions
   - Comment 2: `@User B`
   - Comment 3: plain reply to Comment 2's thread
2. As **User B**, open GET `/api/comments/inbox`.
3. **Expected:** All three comments appear (unread activity for user B).
4. **Expected:** Comment 2's `mentioned = true`, Comments 1 and 3 have `mentioned = false`.

### 4.2 Author's own comments excluded from inbox

1. As **User A**, check GET `/api/comments/inbox`.
2. **Expected:** User A's own comments are NOT listed (inbox only shows comments written by others).

### 4.3 Inbox item metadata

1. As **User B**, view the inbox items.
2. **Expected:** Each item includes `baseId`, `sheetId`, `viewId`, `recordId` so the UI can deep-link to the record.

---

## 5. Real-time / WebSocket Events

### 5.1 comment:created broadcast

1. Open two browser sessions: **User A** and **User B** both viewing the same record.
2. **User A** posts a comment.
3. **Expected:** **User B**'s panel updates without page refresh (real-time push via `comment:created`).

### 5.2 comment:updated broadcast

1. **User A** edits a comment while **User B** is viewing the same record.
2. **Expected:** **User B** sees the edit applied without refresh.

### 5.3 comment:deleted broadcast

1. **User A** deletes a comment while **User B** is viewing.
2. **Expected:** Comment disappears from **User B**'s panel without refresh.

---

## 6. API Contract Quick Reference

| Endpoint | Method | Key fields in response |
|---|---|---|
| `/api/comments` | POST | `data.comment.{id, spreadsheetId, rowId, content, authorId, mentions}` |
| `/api/comments?spreadsheetId=X` | GET | `data.items[].{id, containerId, targetId, mentions}` |
| `/api/comments/:id` | PATCH | `data.comment.{content, mentions, updatedAt}` |
| `/api/comments/:id` | DELETE | 204 No Content |
| `/api/comments/unread-count` | GET | `data.{unreadCount, mentionUnreadCount, count}` |
| `/api/comments/inbox` | GET | `data.{items[].{unread, mentioned, baseId, sheetId, viewId, recordId}, total}` |
| `/api/comments/:id/read` | POST | 204 No Content |
| `/api/comments/:id/resolve` | POST | 204 No Content |

---

## Signoff

- [ ] All lifecycle steps pass
- [ ] Unread count increments / decrements correctly
- [ ] mentionUnreadCount split is correct (subset of unreadCount)
- [ ] `count` backward-compat field present in unread-count response
- [ ] Inbox shows correct items with correct `mentioned` flag
- [ ] Author excluded from own inbox items
- [ ] Real-time events received without page refresh

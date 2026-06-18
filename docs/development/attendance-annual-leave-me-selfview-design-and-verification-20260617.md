# Annual-leave employee `/me` self-service balance — design & verification

**Status:** the endpoint slice is built + verified on this branch. This is the **deferred-future** piece the L5 admin-UI
design-lock named ("Employee `/me` self-service balance view — a separate future endpoint, subject locked to the token,
never mixed into the admin read"). v1 here is the **secure self-read endpoint**; the employee-facing overview card is
the documented thin follow-up (§5).

## 1. Why a separate endpoint (not the admin L5a read)

The admin read (`GET /api/attendance/leave-balances`, `attendance:admin`) queries an **arbitrary `userId`** — correct
for an administrator, wrong for self-service. An employee surface must guarantee a caller can read **only their own**
balance. Mixing a self-mode into the admin route (a flag, an optional userId) is exactly the conflation the design-lock
forbade. So `/me` is its own route with a different gate and a **subject that is not a parameter**.

## 2. Contract (as built)

`GET /api/attendance/leave-balances/me` — `withPermission('attendance:read')` (any authenticated employee, **not**
admin). Optional query: `leaveTypeCode` (default `annual`), `eventLimit` (1–200, default 50). **No `userId` parameter.**
Returns the same explainable shape as the admin read: `{ ok, data: { userId, summary, activeLots, recentEvents, eventLimit } }`.

The query is the shared `readAnnualLeaveBalanceForUser(orgId, userId, leaveTypeCode, eventLimit)` helper — the admin L5a
route was refactored to call it too, so there is **one** balance-read implementation, not two.

## 3. The security property (the whole point)

**The subject is always the authenticated requester; it cannot be set to anyone else.**

- The subject is `getUserId(req)` — resolved from the authenticated token. Once `withPermission('attendance:read')`
  passes, `req.user.id` is set, so `getUserId`'s last-resort `x-user-id` header fallback **never** overrides it.
- There is **no `userId` query parameter** on the route, so the schema cannot carry another user's id.
- If no authenticated subject resolves → `401 UNAUTHORIZED`.

So neither a `?userId=<other>` param nor an `x-user-id: <other>` header can make `/me` return another user's balance.

## 4. Verification

- `node --check` on the plugin: clean.
- Integration test (`attendance-plugin.test.ts`, real in-process server + Postgres): a caller with a `2400`-minute
  balance and **another** user holding `9999` —
  1. `/me` returns the caller's own balance (`userId` = the token, `granted/remaining = 2400`);
  2. `/me?userId=<other>` still returns the caller's `2400`, never the other's `9999` (the param cannot override the subject);
  3. `/me` with an `x-user-id: <other>` header still returns the caller's `2400` (the header cannot override the subject).
- The admin **L5a** read still passes via the shared helper (no regression from the refactor). **9/9** annual tests green.

## 5. Out of scope here / follow-up

- **Employee overview card** — a thin self-balance card in the `overview` surface that fetches `/me` on mount and shows
  the summary (+ a detail expansion). It reuses this endpoint with no new security surface; it's the natural next thin
  slice once the direction is confirmed. (It touches the overview section registry / nav, so it's its own small PR.)
- **Self-service for other leave types** — the endpoint already accepts `leaveTypeCode`; v1 surfaces `annual`.
- This endpoint is **read-only**; no employee-facing mutation (employees never adjust their own balances).

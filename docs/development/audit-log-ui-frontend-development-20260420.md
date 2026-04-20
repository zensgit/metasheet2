# Audit Log UI · Frontend Rewire to `/api/audit-logs` — Development Notes (20260420)

## Background

`AdminAuditView.vue` was previously wired to three admin endpoints that never
shipped:

- `GET /api/admin/audit-activity`
- `GET /api/admin/audit-activity/export.csv`
- `GET /api/admin/session-revocations`

The only backend audit endpoint that actually exists is
`GET /api/audit-logs` (mounted from `packages/core-backend/src/routes/audit-logs.ts`,
RBAC guarded by `rbacGuard('audit', 'read')`). That endpoint reads the
`operation_audit_logs` table directly and also supports `?format=csv` for
export. No backend changes were in scope — this slice is pure frontend.

## Scope

1. Rewire the admin audit page to `GET /api/audit-logs` (JSON + CSV).
2. Preserve the existing filter/pagination/export UX, redesigning around the
   fields the backend actually returns.
3. Replace the broken session-revocations panel with a documented placeholder.
4. Add vitest coverage for list / filter / pagination / export / empty state.

## Backend response shape (verified)

`GET /api/audit-logs`

Query params accepted (validated with `zod`):

| Param          | Notes                                                           |
|----------------|-----------------------------------------------------------------|
| `actorId`      | exact match on `actor_id`                                       |
| `resourceType` | exact match on `resource_type`                                  |
| `resourceId`   | exact match on `resource_id`                                    |
| `action`       | exact match on `action`                                         |
| `from` / `to`  | ISO-8601 datetime (strict). Must include time component.        |
| `page`         | stringified positive int, default `1`                           |
| `pageSize`     | stringified positive int, default `50`, max `500`               |
| `format`       | `csv` or `ndjson` (switches the endpoint into streaming mode)   |
| `limit`        | export row cap, default `10000`, max `100000`                   |

JSON response (non-export) — row columns:

```
{ id, occurred_at, actor_id, actor_type, action,
  resource_type, resource_id, request_id, ip, user_agent, meta }
```

The migration `20250926_create_operation_audit_logs.ts` defines `id` as `uuid`
(string), so the frontend type uses `string`.

## Param translation decisions

The previous view had 5 filter inputs: a free-text `q`, a resource type, an
action, a `from` date and a `to` date.

| Old UI                                   | New UI                                                                                  |
|------------------------------------------|------------------------------------------------------------------------------------------|
| Free-text `q`                            | Removed. Replaced with two exact-match search boxes: `resource_id` and `actor_id`.      |
| `resourceType` select                    | Unchanged (same param name on backend).                                                 |
| `action` select                          | Unchanged, plus added `delete` option to match typical CRUD audit rows.                 |
| `from=YYYY-MM-DD`                        | Converted to `${value}T00:00:00.000Z` before sending (backend expects strict ISO).      |
| `to=YYYY-MM-DD`                          | Converted to `${value}T23:59:59.999Z` (inclusive end-of-day, matches backend `<=`).      |
| `page`/`pageSize`                        | Unchanged (page size fixed at 20).                                                      |

Rationale for dropping `q`: the backend has no full-text column and would 400
with a stray param. The task suggested "map to actorId when it looks like an
id", but a brittle regex would frequently misroute. Two clear exact-match
inputs are easier for admins to reason about.

## UI changes

### Table columns

Old table (IAM activity panel) had 5 columns driven by the legacy
`action_details` JSON shape. New table has 7 columns driven by the actual
`operation_audit_logs` columns:

| Column         | Source                                                 | Fallback |
|----------------|--------------------------------------------------------|----------|
| 时间            | `occurred_at`                                          | —        |
| 操作人          | `actor_id` + `actor_type` (subline)                    | —        |
| 资源            | `resource_type`                                        | —        |
| 动作            | `action`                                               | —        |
| 对象            | `resource_id`                                          | —        |
| 请求信息        | `ip` + `route`/`status_code` subline                   | —        |
| Meta 摘要       | `meta` JSON pruned via `summarizeMeta()`               | —        |

The `summarizeMeta()` helper still prefers human-readable keys
(`email/name/role/preset/permissions/reason/before→after`) but now falls back
to a truncated JSON string so new `meta` keys are visible without code changes.

### Session revocations panel

Rendered as a placeholder panel titled
*"会话撤销记录 — 暂未提供后端数据源，将在后续版本接入"* with a hint pointing
admins to the `user-session` filter on the primary audit table. No network
call is made.

### Layout

Changed from the old `1.3fr : 1fr` two-column layout to a single responsive
column (`admin-audit__layout--single`), since the second column is now just
an informational placeholder.

### CSV export

Retained the existing `apiFetch → Blob → object URL → anchor download`
pattern. A raw `<a href>` / `window.open` would drop the `Authorization`
header injected by `apiFetch`, breaking bearer-token authentication.

The export URL is:
`/api/audit-logs?format=csv&limit=100000&<filter params>`

## Type mapping

New frontend type (co-located in the view, not extracted):

```ts
type AdminAuditLogItem = {
  id: string
  occurred_at: string
  actor_id: string | null
  actor_type: string | null
  action: string
  resource_type: string | null
  resource_id: string | null
  request_id: string | null
  ip: string | null
  user_agent: string | null
  meta: Record<string, unknown> | null
  route: string | null
  status_code: number | null
  latency_ms: number | null
}
```

`route`, `status_code`, `latency_ms` are declared on the type because the
migration schema includes them and the frontend renders `route` + `status_code`;
they may arrive `null` from the backend query (the current SELECT doesn't
return them, but the shape allows it).

## Tests

New spec: `apps/web/tests/adminAuditView.spec.ts` — 5 focused cases.

1. Initial mount → single `GET /api/audit-logs?page=1&pageSize=20` call; rows render; placeholder panel visible.
2. Empty state renders "暂无审计日志" when `items: []`.
3. Changing `resourceType` + `action` + both dates + `actorId` input, then clicking 刷新, issues a new fetch with ISO-bounded `from`/`to`, correct resource/action/actor params, and `page=1`.
4. Clicking 下一页 issues a new fetch with `page=2` and the pager text updates to "第 2 / 3 页".
5. Clicking 导出 CSV issues a `GET /api/audit-logs?...&format=csv&limit=100000&...` request (preserving filters), URL.createObjectURL is invoked, and a success status is shown.

## Files touched

- `apps/web/src/views/AdminAuditView.vue` — rewritten
- `apps/web/tests/adminAuditView.spec.ts` — new

## Non-goals / follow-ups

- A dedicated session-revocations endpoint is still required for the
  placeholder panel to come back online.
- A future iteration could add server-side `q` search if the backend gains
  a `pg_trgm` index on `meta::text`.
- The existing RBAC guard is `audit:read` only; admins who can't pass that
  guard will see the usual 403 redirect path provided by `apiFetch`.

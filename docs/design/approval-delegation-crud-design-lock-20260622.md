# Design-lock (short): Approval delegation (委托) config CRUD + admin UI

**Status:** ACCEPTED (owner-specified 2026-06-22). The 委托设置 slice that turns the
delegation **runtime** (#3036) into a **user-usable** capability. Builds on the merged
`approval_delegations` table + the read-only resolve seam; adds the write CRUD + an admin
management page. Brand-neutral: benchmarked against external OA / mainstream approval
platforms, no vendor names in code/docs.

## 1. Who + scope (owner decisions)
- **Who can set delegations:** gated behind **`approval-templates:manage`** (an admin
  capability), not self-service. The **delegator is a chosen field**, so an admin
  configures delegations for any user — the management list shows 委托人 + 被委托人.
- **Scope:** `all` | `template` (reuse the table shape; `template` carries a
  `scope_template_id`).
- **Time window:** `start_at` / `end_at` + an `active` flag.
- **Conflict semantics (v1, unchanged):** at most **one active row per (delegator, scope
  target)** — enforced by the unique partial index; **no multi-window scheduling**. A
  conflicting create returns **409**.

## 2. Backend API (`/api/approval-delegations`, all `approval-templates:manage`)
- `GET` — list active delegations (admin view: delegator, delegatee, scope, window,
  status); optional `?delegatorUserId=` filter.
- `POST` — create `{ delegatorUserId, delegateeUserId, scope, scopeTemplateId?, startAt,
  endAt }`.
- `PATCH /:id` — edit (delegatee / window / scope / `active`).
- `DELETE /:id` (or `PATCH active=false`) — disable (soft).
- **Validation:** no self-delegation; valid window (`end > start`); scope/template
  constraint (`scope='template'` ⇔ a target); unique-active conflict → **409**. The table
  CHECKs are the second line of defense.

## 3. Frontend (admin management page)
- A simple list: 委托人 / 被委托人 / 范围 / 时间 / 状态.
- A create/edit dialog; **user selection reuses the existing approval user picker**.
- **Does NOT** enter the complex graph/template author editor — scope stays narrow.

## 4. Tests
- **API real-DB:** create / conflict (409) / disable / `template` scope / self-delegation
  reject.
- **Runtime seam (extends the #3036 db seam):** "create a delegation **via the API** →
  start an approval → the assignment resolves to the **delegatee**" — end-to-end.
- **Frontend:** form validation + the saved payload shape.

## 5. Boundaries / non-goals
- Config CRUD + admin UI only; the resolve seam (#3036) is unchanged. **W7 stays locked.**
- No multi-window scheduling, no role-delegatee, no multi-hop, no template-editor coupling
  (all reopen-only).

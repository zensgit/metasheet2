# Approval PR3 admin-jump-node Development 2026-05-15

PR: `admin-jump-node` · Branch: `flow/admin-jump-node-20260515` · Base: `origin/main` @ `0eb8c9639`
Gating scope gate: `docs/development/approval-pr3-scope-gate-response-20260515.md` (revised; verdict GO-after-prerequisites)
Worksplit spec: `docs/development/approval-phase1-codex-claude-worksplit-todo-20260515.md` §5 PR3

This document records the prerequisite decisions and test commitment. Implementation may begin once this is complete.

## Prerequisite Decisions

### PD1 — `approval_records.action` gains `'jump'` via new migration (option a)

New migration `zzzz<ts>_add_jump_action_to_approval_records.ts`:

- `up()`:
  - `ALTER TABLE approval_records DROP CONSTRAINT IF EXISTS approval_records_action_check`
  - `ADD CONSTRAINT approval_records_action_check CHECK (action IN ('created','approve','reject','return','revoke','transfer','sign','comment','cc','remind','jump'))`
- `down()` (exact, no interpretation):
  - `ALTER TABLE approval_records DROP CONSTRAINT IF EXISTS approval_records_action_check`
  - `ADD CONSTRAINT approval_records_action_check CHECK (action IN ('created','approve','reject','return','revoke','transfer','sign','comment','cc','remind')) NOT VALID`
  - `NOT VALID` is mandatory so pre-existing `'jump'` rows do not block the rollback while still rejecting new `'jump'` inserts.

Rationale: admin-jump is a strong-permission, audit-critical recovery action; reusing `'transfer'` would obscure timeline semantics (worksplit §8). Accepting (a) makes PR3 a migration PR — T11 rollback verification is mandatory.

### PD2 — `approvals:admin` permission, concrete registration

Same new migration (or a sibling migration) also:

- `up()`: inserts `permissions(code='approvals:admin', ...)`, then inserts `role_permissions` linking `approvals:admin` to the admin role.
- `down()` (FK-safe order, mandatory): DELETE the `role_permissions` rows for `approvals:admin` FIRST, THEN DELETE the `permissions` row. Reversing the order violates the `role_permissions → permissions` FK.

Route gated: `r.post('/api/approvals/:id/jump', authenticate, rbacGuard('approvals:admin'), handler)`.

`approvals` is in `NON_NAMESPACED_PERMISSION_RESOURCES` (`rbac/namespace-admission.ts`) → no namespace-admission entry/switch needed. Exact permission code: `approvals:admin`. Migration location: recorded here once the migration filename is created.

### PD3 — Parallel-region jump boundary (MVP)

- Forward-reachability base: when `metadata.parallelBranchStates` is present, compute reachability from the parallel **JOIN node**, NOT from `current_node_key` (which is the fork; from the fork every branch node is reachable, which would wrongly admit sibling-branch targets).
- A jump target located inside ANY parallel branch → `400`.
- Only post-join downstream targets are valid. On a valid post-join jump: deactivate ALL active branch assignments, clear `metadata.parallelBranchStates`, re-resolve the target node.
- Jump-into-a-specific-branch is OUT OF SCOPE for PR3 → tracked as a separate future ADR.

### Target node-type rule (general)

`targetNodeKey` MUST resolve to an `approval`-type node in the bound runtime graph. Only `approval` nodes create human assignments; jumping to `start`/`end`/`condition`/`cc`/parallel-fork/join nodes is semantically invalid → `400`. Enforced independently of forward-reachability and covered by T5(b).

## B3 — Constraint Definition Sync Plan

`approval_records_action_check` is defined in 4 files (full-repo sweep). Sync surface:

- EDIT (must carry `'jump'`):
  - the NEW PR3 migration (PD1)
  - `packages/core-backend/tests/helpers/approval-schema-bootstrap.ts:180` — add `'jump'` to its rebuilt CHECK
- DO NOT EDIT (applied/immutable history; superseded at runtime by the new migration):
  - `packages/core-backend/src/db/migrations/zzzz20260411123000_add_created_action_to_approval_records.ts`
  - `packages/core-backend/src/db/migrations/zzzz20260411120100_approval_templates_and_instance_extensions.ts`
  - `packages/core-backend/src/db/migrations/zzzz20260423120000_add_remind_action_to_approval_records.ts`

Acceptance: `grep -rn "approval_records_action_check"` shows only the new migration and schema-bootstrap carry `'jump'`; the 3 historical migrations are unchanged by this PR.

## Expected Files

- `packages/core-backend/src/services/ApprovalProductService.ts` — new `adminJump(...)` + graph-local downstream-validation helper.
- `packages/core-backend/src/routes/approvals.ts` — one new `POST /api/approvals/:id/jump`.
- `packages/core-backend/src/db/migrations/zzzz<ts>_add_jump_action_to_approval_records.ts` — action constraint + `approvals:admin` permission/role_permission rows.
- `packages/core-backend/tests/helpers/approval-schema-bootstrap.ts` — CHECK sync (add `'jump'`).
- `packages/core-backend/tests/unit/**/*approval*`, `packages/core-backend/tests/integration/**/*approval*` — test matrix below.
- This dev doc + `approval-pr3-admin-jump-node-verification-20260515.md`.

## Test Matrix Commitment

All tests below are committed. For each, the verification doc must record that the test FAILS without the corresponding guard/change (effectiveness evidence), per [[feedback_metasheet2_pr_hardening_checklist]].

| ID | Assertion | Fails-without |
|---|---|---|
| T1 | non-admin → 403; AND user with `approvals:act`/`approval-templates:manage` but NOT `approvals:admin` → still 403 | permission gate / privilege separation |
| T2 | terminal instance (APPROVAL_TERMINAL_STATUSES) → rejected | terminal guard |
| T3 | stale `version` → 409 | optimistic version |
| T4 | mock-pool: published-def query keys on `instance.published_definition_id`; zero `approval_templates`/`active_version_id` read | version-freeze invariant |
| T5 | invalid target → 400, covering BOTH: (a) nonexistent nodeKey, AND (b) existing node whose type is not `approval` (start/end/condition/cc/parallel-fork/join) | target existence + type check |
| T6 | backward / lateral non-downstream target → 400 | forward-only check |
| T7 | valid forward jump: old assignments deactivated, target assignments created, advances from target | core jump |
| T8 | old assignee cannot act post-jump → rejected | assignment deactivation |
| T9 | parallel: in-branch target → 400; valid post-join → all branch assignments deactivated + parallelBranchStates cleared + coherent advance; reachability base = join node | PD3 boundary |
| T10 | audit payload complete; actor_id = admin user (not system:*) | audit |
| T11 | up → insert jump row → down (succeeds w/ jump row) → fresh jump insert rejected → up → jump insert accepted | PD1 migration rollback (data-bearing) |
| T12 | FOR UPDATE + optimistic version; 2nd concurrent jump → 409 | concurrency |
| T13 | jump does NOT mutate `template_version_id` / `published_definition_id` | version binding |
| T-bootstrap | `approval-schema-bootstrap.ts` rebuilt CHECK includes `'jump'` | B3 sync (PR2-B1-class regression guard) |

## Verification Plan

```bash
pnpm --filter @metasheet/core-backend test:unit
pnpm --filter @metasheet/core-backend test:integration   # DB-gated; compare against baseline, T11/T-bootstrap require DB
pnpm --filter @metasheet/core-backend build
pnpm type-check
```

Migration rollback (T11) requires a scratch DB. If the local integration env remains DB-gated, the verification doc must explicitly state T11/T-bootstrap as DB-required and not silently skip (avoid [[feedback_metasheet2_skip_when_unreachable_blind_spot]]).

## Out Of Scope

Jump-into-specific-branch (separate ADR); backward jump (separate ADR, worksplit §8); add-sign (PR4); any PR2 auto-approval region; historical migration edits; UI.

## Status

Prerequisites recorded. Ready for implementation on explicit opt-in ([[feedback_staged_optin_lineage]]).

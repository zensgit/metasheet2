# Approval PR1 Version Freeze Development 2026-05-15

## Scope Gate Decisions

### P1: Delete/Archive Guard Scope

Decision: choose option (a).

PR1 will add an internal service helper for version deletion/archive safety, for example `assertVersionDeletable(templateVersionId)`. It will not add an HTTP endpoint, UI, route, or product surface.

Reason:

- Claude verified there is no existing delete/archive template-version code path.
- Adding a public endpoint would be a new product surface and would violate the Phase 1 hardening boundary.
- An internal helper lets PR1 pin the safety invariant for future route work without exposing new behavior.

If implementation discovers that a public endpoint is required, Codex must stop and ask the user before writing that endpoint.

### P2: Test Commitment

PR1 commits to covering T1-T11 from the Claude scope gate response. T12 is optional and will be implemented only if the `loadTemplateBundle` mitigation is done through call-site splitting rather than a doc comment.

| ID | Test | Required |
|---|---|---|
| T1 | Old instance advances with original `published_definition_id` after a new template version is published. | Yes |
| T2 | Old instance keeps original form snapshot semantics after the template form schema changes. | Yes |
| T3 | New instance uses the latest active published definition after publish. | Yes |
| T4 | Destructive delete/archive of a referenced version is blocked when unfinished instances exist. | Yes, via internal helper |
| T5 | Stale published definition remains readable even after another version is active. | Yes |
| T6 | Publish failure rolls back active definition changes and leaves no orphaned `approval_published_definitions` row. | Yes |
| T7 | `dispatchAction` reads `approval_published_definitions` by `instance.published_definition_id` and does not read `approval_templates.active_version_id` during advance. | Yes |
| T8 | Concurrent publish leaves exactly one active published definition. | Yes |
| T9 | Form snapshot independence after schema update and republish. | Yes |
| T10 | Runtime graph independence after graph update and republish. | Yes |
| T11 | Guard error includes unfinished instance count and sample approval instance id. | Yes |
| T12 | Static/AST call-site guard for `preferredVersion: 'active'`. | Optional |

For every required test, the verification document must state whether the test was shown to fail before the corresponding hardening or whether it pins an already-correct baseline invariant.

## Implementation Notes

PR1 should harden the existing version-freeze model. It should not rebuild it.

Known baseline invariants:

- `createApproval()` persists `template_version_id`, `published_definition_id`, and `form_snapshot`.
- `dispatchAction()` loads `runtime_graph` from `approval_published_definitions` using `instance.published_definition_id`.
- `publishTemplate()` runs inside a transaction and locks the template row with `FOR UPDATE`.

Expected code changes:

- [x] Add an internal version delete/archive guard helper.
- [x] Add a clear doc comment or small naming guard around `loadTemplateBundle` usage so it is not reused for existing-instance advancement.
- [x] Add regression tests for version freeze, snapshot independence, rollback, and concurrent publish.

Out of scope:

- HTTP delete/archive version endpoint.
- Approval template UI changes.
- `ApprovalGraphExecutor` changes.
- `routes/approvals.ts` changes.
- Automation/SLA/add-sign/admin-jump work.

## Implementation Result

Code changes:

- `packages/core-backend/src/services/ApprovalProductService.ts`
  - Added `assertTemplateVersionDeletable(templateVersionId)`.
  - The guard checks unfinished instances by both direct `approval_instances.template_version_id` and indirect `approval_instances.published_definition_id -> approval_published_definitions.template_version_id`.
  - Terminal statuses treated as safe: `approved`, `rejected`, `revoked`, `cancelled`.
  - The 409 error includes `unfinishedCount` and `sampleInstanceId`.
  - Added a `loadTemplateBundleWithClient()` comment that explicitly forbids reuse for existing-instance advancement.
- `packages/core-backend/tests/unit/approval-product-service.test.ts`
  - Added regression coverage for active-version create, stale published-definition advance, form snapshot routing, delete/archive guard, publish row-lock ordering, and publish rollback.

No migration was added. `down()` rollback verification is not applicable for this PR.

## Test Mapping

| ID | Coverage | Evidence |
|---|---|---|
| T1 | Old instance advances with original `published_definition_id` after a new template version is published. | `advances existing approvals from the instance-bound stale published definition and form snapshot` uses `pub-old` / `ver-old` and asserts result stays bound to them. |
| T2 | Old instance keeps original form snapshot semantics after schema change. | Same test routes by stored `form_snapshot.legacyAmount`, not a live template schema lookup. |
| T3 | New instance uses latest active published definition after publish. | `creates new approvals from the currently active published definition` asserts inserted instance uses `ver-2` / `pub-2`. |
| T4 | Delete/archive of referenced version blocked. | `blocks template version delete/archive checks with unfinished count and sample id`. |
| T5 | Stale published definition remains readable after another version is active. | Stale `pub-old` row is returned with `is_active: false` and still advances. |
| T6 | Publish failure rollback leaves no orphaned active definition row. | `rolls back publish when the active definition insert fails` asserts `ROLLBACK`, no `COMMIT`, and no template status update. |
| T7 | `dispatchAction` reads by `instance.published_definition_id`, not `active_version_id`. | Stale advance test asserts the published definition query param is `pub-old` and no SQL mentions `approval_templates` or `active_version_id`. |
| T8 | Concurrent publish leaves one active definition. | `serializes publish with a template row lock and template-scoped active definition swap` pins `FOR UPDATE` plus deactivate-before-insert order; `keeps only one active published definition across concurrent publish calls` simulates two concurrent publishes over a virtual lock-backed DB state. |
| T9 | Form snapshot independence after schema update and republish. | Same snapshot routing test; no existing old-instance form resubmit path was found. |
| T10 | Runtime graph independence after graph update and republish. | Same stale advance test uses frozen runtime graph to route to `approval_old_high`. |
| T11 | Guard error includes unfinished instance count and sample ID. | Guard rejection test asserts `unfinishedCount: 2` and `sampleInstanceId: apr-pending-1`. |
| T12 | Static/AST call-site guard for `preferredVersion: 'active'`. | Not implemented; PR1 used a code comment guard instead of call-site splitting, per P2 optional scope. |

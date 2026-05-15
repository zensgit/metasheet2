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

- Add an internal version delete/archive guard helper.
- Add a clear doc comment or small naming guard around `loadTemplateBundle` usage so it is not reused for existing-instance advancement.
- Add regression tests for version freeze, snapshot independence, rollback, and concurrent publish.

Out of scope:

- HTTP delete/archive version endpoint.
- Approval template UI changes.
- `ApprovalGraphExecutor` changes.
- `routes/approvals.ts` changes.
- Automation/SLA/add-sign/admin-jump work.


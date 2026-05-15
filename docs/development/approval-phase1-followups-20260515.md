# Approval Phase 1 Follow-ups 2026-05-15

Source:

- `docs/development/approval-pr1-review-response-20260515.md`
- Merged PR1 commit: `c44fb72e8 feat(approval): harden template version freeze`

These items do not block PR1 merge. They are retained here so PR2 and later
Phase 1 work can absorb them deliberately instead of rediscovering them during
review.

## PR2 Candidates

### A. Extract Terminal Statuses Constant

Status: open, recommended for PR2.

Current duplicate literals:

- `packages/core-backend/src/services/ApprovalProductService.ts`
- `packages/core-backend/tests/unit/approval-product-service.test.ts`

Action:

- Add `APPROVAL_TERMINAL_STATUSES` in `packages/core-backend/src/types/approval-product.ts`.
- Reuse it in service code and approval product tests.

Reason:

PR2 auto-approval merge will likely need terminal-state checks. Centralizing the
list avoids future drift if a terminal status such as `expired` or `withdrawn`
is added.

### B. Explain Delete Guard OR Clause

Status: open, recommended for PR2.

Location:

- `ApprovalProductService.assertTemplateVersionDeletable()`

Action:

- Add a short comment above the `template_version_id = $1 OR published_definition_id IN (...)` predicate.

Suggested wording:

> Defend against historical instances where only one of `template_version_id`
> or `published_definition_id` may have been backfilled.

Reason:

The query intentionally protects both direct and indirect references. Without
the comment, a future refactor may simplify the predicate and break historical
data safety.

## Independent Follow-ups

### C. Strengthen Guard Helper JSDoc

Status: open, independent.

Location:

- `ApprovalProductService.assertTemplateVersionDeletable()`

Action:

- Add JSDoc stating that any future delete/archive path must call this guard
  before mutating `approval_template_versions`, `approval_templates`, or
  `approval_published_definitions`.
- State explicitly that direct SQL bypasses this protection.

Reason:

PR1 intentionally added an internal helper only. Future product endpoints need
a visible warning at the helper definition.

### D. Add Real PostgreSQL Concurrent Publish Test

Status: blocked by integration DB environment.

Action:

- After integration DB baseline is repaired, add an integration test that runs
  two concurrent real PostgreSQL `publishTemplate()` calls for one template.
- Assert exactly one `approval_published_definitions.is_active = TRUE` row
  remains for that template.

Reason:

PR1 has unit-level lock-order and virtual two-publisher coverage. A real DB
test would prove the unique partial index and `FOR UPDATE` path together.

### E. Add Explicit T9 Form Schema Violation Test

Status: deferred until an existing-instance form revalidation path exists.

Action:

- When a future PR adds resubmit/edit/revalidate behavior for existing approval
  instances, add a test where the current template schema differs from the
  stored `form_snapshot`.
- Assert existing-instance handling uses the frozen snapshot semantics, not the
  latest template schema.

Reason:

PR1 pins snapshot usage through frozen conditional routing. There is no current
service path that revalidates submitted form data on an existing instance.

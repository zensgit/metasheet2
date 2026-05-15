# Approval PR1 Scope Gate Request 2026-05-15

## Request

Claude should review this request before Codex starts PR1 code changes.

Claude scope:

- Produce a scope gate checklist.
- Identify semantic risks.
- List required tests.
- Mark do-not-cross lines.
- Provide review focus for the eventual PR1 diff.

Claude should not propose Phase 2/3/4 product work for PR1.

## PR Scope

PR:

- `version-freeze-hardening`

Branch:

- `flow/version-freeze-hardening-20260515`

Worktree:

- `/Users/chouhua/Downloads/Github/metasheet2-flow-version-freeze-hardening-20260515`

Base commit:

- `be699941f docs: record approval phase1 baseline`

Primary references:

- `docs/development/approval-phase1-codex-claude-worksplit-todo-20260515.md`
- `docs/development/approval-phase1-baseline-20260515.md`
- `docs/research/yida-workflow-vs-metasheet2-comparison-20260514.md`
- `docs/research/yida-workflow-automation-benchmark-improvement-plan-20260515.md`

## Expected Files

Expected implementation files:

- `packages/core-backend/src/services/ApprovalProductService.ts`
- `packages/core-backend/src/types/approval-product.ts` only if DTO or API response shape must expose version governance metadata.
- `packages/core-backend/src/db/migrations/*approval*` only if a new archive/delete guard requires schema support.
- `packages/core-backend/tests/unit/**/*approval*`
- `packages/core-backend/tests/integration/**/*approval*`

Expected documentation files:

- `docs/development/approval-pr1-version-freeze-development-20260515.md`
- `docs/development/approval-pr1-version-freeze-verification-20260515.md`

## Current Code Baseline

Known existing implementation:

- `ApprovalProductService.publishTemplate()` already creates an immutable `approval_published_definitions.runtime_graph` row and marks previous active definitions inactive.
- `ApprovalProductService.createApproval()` already stores `template_version_id`, `published_definition_id`, and `form_snapshot` on `approval_instances`.
- `ApprovalProductService.dispatchAction()` already reloads runtime graph from the instance-bound `published_definition_id`.
- Migration `zzzz20260411120100_approval_templates_and_instance_extensions.ts` already creates `approval_templates`, `approval_template_versions`, `approval_published_definitions`, and instance binding columns.

Therefore PR1 should harden and verify version-freeze semantics. It should not rebuild the version model from scratch.

## Explicit Non-Goals

- No generic `approval_trigger_bindings`.
- No public-form submitted-to-approval product UI.
- No multitable submitted-to-approval product UI.
- No `start_approval` automation action.
- No persistent `automation_jobs` queue.
- No automation retry.
- No business calendar or SLA timeout action work.
- No auto-approval three-merge implementation.
- No admin jump implementation.
- No add-sign implementation.
- No graph runtime insertion or `runtimeInsertedNodes`.
- No unrelated frontend product surface.

## Boundary Checklist For Claude

Claude should explicitly answer yes/no for each item:

- Does PR1 stay limited to version-freeze hardening?
- Does PR1 avoid adding new product surfaces?
- Does PR1 avoid scheduler, automation, SLA, add-sign, and admin-jump work?
- Does PR1 use instance-bound `published_definition_id` as the runtime source of truth?
- Does PR1 prevent or guard destructive version operations when unfinished instances reference the version?
- Does PR1 prove stale published definitions remain readable for running instances?
- Does PR1 avoid reading template `active_version_id` when advancing an existing instance?
- Does PR1 keep migration rollback behavior documented and tested if migrations change?

## Tests Planned

Codex should add or verify tests for:

- Old instance advances with the original `published_definition_id` after a new template version is published.
- Old instance keeps original form snapshot semantics after the template form schema changes.
- New instance uses the latest active published definition after publish.
- Destructive delete/archive of a referenced version is blocked when unfinished instances exist.
- Stale published definition remains readable even after another version is active.
- Publish failure rolls back active definition changes.
- Any path that accidentally reads template `active_version_id` for an existing instance is covered or removed.

Suggested targeted commands:

```bash
pnpm --filter @metasheet/core-backend test:unit
pnpm --filter @metasheet/core-backend test:integration -- tests/integration/approval-pack1a-lifecycle.api.test.ts
pnpm --filter @metasheet/core-backend build
pnpm type-check
```

Baseline note:

- Full unit suite passed before PR1 code changes: 165 files, 2136 tests.
- Full integration suite is not green in this local environment before PR1 code changes; see `docs/development/approval-phase1-baseline-20260515.md`.

## Review Focus Requested

Claude should focus review on:

1. Version source of truth: instance-bound runtime must win over active template state.
2. Transactionality: publish should not leave multiple active definitions or half-written version state.
3. Deletion/archive safety: no referenced active/running version can be destructively removed.
4. Test effectiveness: regression tests should fail if instance advancement accidentally uses the current active template.
5. Scope creep: no Phase 2+ behavior should be included.

## Expected Claude Output

Please return:

```text
Scope gate:
Semantic risks:
Required tests:
Do-not-cross lines:
Review focus:
Go / no-go for Codex implementation:
```


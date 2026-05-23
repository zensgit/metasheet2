# Approval Phase 2 AssigneeResolver Hardening Verification 2026-05-23

Branch: `codex/approval-assignee-resolver-hardening-20260523`
Base: `origin/main@2d50cc51d`
Commit under verification: local working tree before final commit
Worktree: `/private/tmp/ms2-resolver-hardening-20260523` (created via `git worktree add` to avoid colliding with parallel sessions in the main checkout, per the worktree-hazard discipline)

## Verification Summary

PASS for the three required observations:

| Observation | Result |
|---|---|
| O1 — adminJump dynamic end-to-end | PASS — 2 new unit tests (`O1a` + `O1b`) added and green |
| O2 — formSchema runtime comments | PASS — 2 comment blocks added, no behavior change, build green |
| O3 — dynamic-collision-guard helper + comments | PASS — `isDynamicallyResolvedAssignment` extracted; logically equivalent to prior inline check (De Morgan), existing tests still green |

Phase 2 후续项 unchanged: trigger bindings / start_approval / backwrite / event bridge / public-form & multitable trigger sources remain frozen behind the #1794 / #1797 forward gate.

## Commands Run

### Focused Unit Tests

```bash
cd /private/tmp/ms2-resolver-hardening-20260523
pnpm --filter @metasheet/core-backend exec vitest run --watch=false \
  tests/unit/approval-admin-jump-service.test.ts \
  tests/unit/approval-product-service.test.ts \
  tests/unit/approval-assignee-resolver.test.ts
```

Result:

```text
Test Files  3 passed (3)
Tests       49 passed (49)
Duration    471ms
```

Breakdown (relevant new entries):

- `approval-admin-jump-service.test.ts` — 9 tests PASS, including the two new ones:
  - `O1a admin jump into a dynamic assigneeSources target resolves via the resolver and persists metadata`
  - `O1b admin jump into a dynamic assigneeSources target composes with PR2 mergeWithRequester cascade past the dynamic node`
- All 36 existing tests in `approval-product-service.test.ts` PASS unchanged (validates O3 helper extraction is behavior-preserving).
- All 6 existing tests in `approval-assignee-resolver.test.ts` PASS unchanged (O2 is comment-only).

### Build

```bash
cd /private/tmp/ms2-resolver-hardening-20260523
pnpm --filter @metasheet/core-backend build
```

Result:

```text
> @metasheet/core-backend@2.5.0 build
> tsc

(no output, exit code 0)
```

`tsc` PASS — the O3 helper extraction + O2 comments compile cleanly under the existing typecheck config.

### Diff Hygiene

```bash
cd /private/tmp/ms2-resolver-hardening-20260523
git diff --check                           # working tree
git diff --check origin/main..HEAD         # committed delta (re-run post-commit)
git diff --check origin/main...HEAD        # merge-base symmetric (re-run post-commit)
```

Working tree result: PASS (no whitespace/conflict markers).

`origin/main..HEAD` and `origin/main...HEAD` are run again after `git commit` and recorded in the review request; pre-commit they have no diff to check because there is no local commit yet.

## Test Coverage Map

| Observation | Test | Evidence |
|---|---|---|
| O1 — resolver fires at adminJump (no cascade) | `O1a admin jump into a dynamic assigneeSources target resolves via the resolver and persists metadata` | Asserts dynamic assignment row carries `metadata.resolvedFrom = { kind: 'requester', sourceIndex: 0 }`; old assignee deactivated; no active-template SQL reads; no PR2 audit emitted for cascade-free graph. |
| O1 — resolver + PR2 cascade composition at adminJump | `O1b admin jump into a dynamic assigneeSources target composes with PR2 mergeWithRequester cascade past the dynamic node` | Asserts cascade `system:auto-approval` audit with `reason: 'auto-merge-requester'` and `originalApprover.id = 'requester-1'`; only post-cascade `director-1` static assignment inserted; instance advances to `director_review`. |
| O2 — formSchema runtime documentation | Comments in `ApprovalAssigneeResolver.ts` and `ApprovalProductService.ts`; verified by passing existing 49-test focused suite and PASS `tsc` build. | No behavior change — same code paths, additional documentation only. |
| O3 — `isDynamicallyResolvedAssignment` helper | All 36 product-service unit tests still PASS, including: `creates requester-source assignments from the frozen published runtime graph with metadata`, `rejects duplicate dynamic assignees across parallel branches at creation time`, `rejects duplicate dynamic assignees across parallel branches at advance time`, `dispatches dynamic assignees from the instance-bound runtime graph without active template reads`. | Logical equivalence verified by De Morgan: `every(a => !A(a) \|\| !B(a))` ≡ `!some(a => A(a) && B(a))` where `A = isRecord(metadata)`, `B = isRecord(metadata.resolvedFrom)`. The helper bundles those two checks under one explicit name. |

## Not Run

| Item | Reason |
|---|---|
| Full backend unit suite (`pnpm --filter @metasheet/core-backend test:unit`) | Not run in this slice. The focused 3-file run covers all touched code paths and the helper extraction is behavior-preserving; PR #1797 verified the broader 2290-test suite against the same approval surface 1 day before this hardening. **Could be re-run on request.** |
| Scratch PostgreSQL integration | Not run. No migration / no SQL surface changed by this hardening (`assertNoActiveAssignmentConflicts` issues the same SELECT as before; only the JS predicate was renamed). DB-required behavior is unchanged from #1797. **DB-required tests are explicitly NOT marked PASS for this slice.** |
| Frontend / web unit | Out of scope — no `apps/web` files changed. |
| Lint / typecheck full repo | Not run beyond the core-backend `tsc` invoked by `pnpm build`. **Could be re-run on request.** |

## Diff Scope

Modified source/test files (3):

- `packages/core-backend/src/services/ApprovalAssigneeResolver.ts` — comment-only above `assertFormUserSource`
- `packages/core-backend/src/services/ApprovalProductService.ts` — comment above `buildApprovalAssignmentResolver` + `isDynamicallyResolvedAssignment` helper + comment block + early-return refactor in `assertNoActiveAssignmentConflicts`
- `packages/core-backend/tests/unit/approval-admin-jump-service.test.ts` — `buildDynamicTargetGraph` + `buildDynamicRequesterMergeGraph` builders, mock branch for conflict-guard SELECT, 2 new tests (O1a, O1b)

Added documentation (2):

- `docs/development/approval-phase2-assignee-resolver-hardening-development-20260523.md`
- `docs/development/approval-phase2-assignee-resolver-hardening-verification-20260523.md`

Untouched (confirmed via `git status`):

- migrations
- routes
- UI
- automation
- SLA / breach
- Workflow Designer / BPMN
- `approval_trigger_bindings` (does not exist; gate still frozen)
- `start_approval` (still frozen)
- approval result backwrite (still frozen)
- approval event bridge (still frozen)
- add-sign / countersign (still frozen)

## Hygiene Notes

- The worktree at `/private/tmp/ms2-resolver-hardening-20260523` carries two transient symlinks (`node_modules` and `packages/core-backend/node_modules`) pointing at the main checkout to reuse pnpm install state. These are **removed before commit** so the worktree status is clean and the commit contains only the intended diff.
- No `pnpm install` was run in the worktree; the symlinked install from `/Users/chouhua/Downloads/Github/metasheet2` was reused.
- Branch is set up to track `origin/main` (verified via `git status --short --branch`).
- No push performed; the next action is a Codex independent verification round before merge.

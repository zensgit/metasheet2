# Approval PR3 Review Response 2026-05-15

§7.2 independent review of PR3 `admin-jump-node`, commit `f262b95de feat(approval): add admin jump node`, against revised scope gate `approval-pr3-scope-gate-response-20260515.md` + dev doc.

Reviewer: Claude
Worktree: `/Users/chouhua/Downloads/Github/metasheet2-flow-admin-jump-node-20260515`
Branch state: ahead 2 / behind 0 (anchor `3d0262b86` + impl `f262b95de`); worktree clean.

## Verdict

APPROVE. No blocking findings. The implementation faithfully realizes PD1/PD2/PD3 + Fix1/Fix2 + B3 and preserves the PR1 version-freeze invariant. One acknowledged residual (T11 data-bearing rollback requires scratch PG) is explicitly documented, not hidden, and the migration is verified correct by inspection. Three non-blocking follow-ups recommended.

## Code-Grounded Verification

R1 — Version-freeze (HIGH): `adminJump` loads runtime ONLY via `SELECT * FROM approval_published_definitions WHERE id = $1` keyed on `instance.published_definition_id` (svc diff L175-185); all target/forward validation runs on that frozen `runtimeGraph`. Zero read of `approval_templates`/`active_version_id`. T4 negative-asserts exactly this (`.some(includes('approval_templates'))===false`, same for `approval_template_versions`, `active_version_id`). Invariant preserved. ✅

R5 — Concurrency: `... FOR UPDATE` on the instance row (L139) + optimistic `version` mismatch → 409 `APPROVAL_VERSION_CONFLICT` (L146-153); BEGIN/COMMIT + `rollbackQuietly` on error. T6/T12 cover stale double-jump → 409. ✅

Guards: terminal status → 409 (L154-160, uses `APPROVAL_TERMINAL_STATUSES`); non-`pending` → 409 (L161-167); no `published_definition_id` → 409; no `current_node_key` → 409; `COALESCE(source_system,'platform')='platform'` correctly scopes to platform approvals only (excludes after-sales/legacy bridges). ✅

Fix2 — Target node-type: target not found → 400; `targetNode.type !== 'approval'` → 400 `APPROVAL_JUMP_TARGET_INVALID` (L186-192). T5 covers both (a) nonexistent and (b) non-approval node. ✅

PD3 — Parallel base = JOIN: when `parallelState` present, in-branch target → 400 `APPROVAL_JUMP_PARALLEL_BRANCH_TARGET_UNSUPPORTED` (L199-205); `reachabilityBaseNodeKey = parallelState.joinNodeKey` (L206) — base is the JOIN node, NOT the fork. T9 verifies both (branch target → 400; post-join target succeeds + parallel state cleared). ✅

R3 — Parallel cleanup: `deactivateAllActiveAssignments` + `metadata = COALESCE(metadata,'{}'::jsonb) - 'parallelBranchStates'` (L238-246). T9 asserts the JSONB key removal in the UPDATE. ✅

Forward-only: `isReachableDownstream(runtimeGraph, reachabilityBaseNodeKey, targetNodeKey)` on the frozen graph; backward/lateral → 400 `APPROVAL_JUMP_TARGET_NOT_FORWARD` (L209-215). T6 covers backward rejection. ✅

R4 — Audit/event: `insertApprovalRecord` action `'jump'`, `actorId = actor.userId` (REAL admin, not `system:*`), full metadata (fromNodeKey/toNodeKey/nextNodeKey/oldAssignees/newAssignees/reason/actorId/parallelStateCleared); `eventBus.emit('approval.admin_jumped', …)` emitted AFTER `COMMIT` (L283/L309-311) so no event on rollback. T4/T10 assert audit + event payload incl. `actorId:'admin-1'`. ✅

PD1 migration `zzzz20260515130000`: `up()` DROP+ADD CHECK incl. `'jump'`; `down()` DROP+ADD old set `NOT VALID` (pre-existing jump rows don't block rollback; new jump inserts rejected post-down). DDL shape matches PD1 exactly. ✅

PD2 migration: `up()` inserts `permissions(code,name,description)` + `role_permissions(role_id,permission_code)` (column names verified against `20250924190000_create_rbac_tables.ts` — exact match), both `ON CONFLICT DO NOTHING`; `down()` deletes `role_permissions` FIRST then `permissions` (FK-safe order = Fix1). ✅

B3 sync: `approval-schema-bootstrap.ts:180` CHECK now includes `'jump'` AND `APPROVAL_SCHEMA_BOOTSTRAP_VERSION` bumped to `20260515-pr3-admin-jump-action` (forces re-bootstrap so the new constraint takes effect). 3 historical migrations untouched. ✅

T1 strengthened: `describe('PR3: Admin jump boundary')` — `approvals:act` w/o `approvals:admin` → 403; `approval-templates:manage` w/o `approvals:admin` → 403; `approvals:admin` → reaches handler; no-auth → 401. Privilege separation fully covered. ✅

## Findings (§7.2 order)

1. Blocking correctness: NONE.
2. Security/permission: NONE. RBAC gate + privilege separation tested; non-repudiable admin actor; platform-only scoping.
3. Missing tests: NONE required missing (T1-T13 + T-bootstrap present; spot-checked T4/T9/T1 effective). Two emergent-interaction notes below.
4. Scope creep: NONE. 10 files all in expected list. `ApprovalProductService.ts +283` adds `adminJump` and CALLS PR2 `applyAutoApprovalCascade` (permitted — do-not-cross was EDITING PR2 regions, not calling). No automation/SLA/UI/historical-migration edits.
5. Naming/maintainability: 3 minor (M1-M3 below).

## Non-Blocking Follow-ups

NB1 (document emergent interaction): `adminJump` composes with PR2 auto-approval — if the jumped-to node's assignee triggers an enabled policy, `applyAutoApprovalCascade` runs (svc L225-234). This is correct and consistent (uniform node-entry behavior) but was not anticipated by the scope gate. Add: (a) an inline comment at L225 noting the intentional composition + link to PR2; (b) a test "jump to node whose assignee = requester with mergeWithRequester → auto-approves at target". Track for this PR if cheap, else a Phase-1 follow-up.

NB2 (M1): `currentStep: resolution.currentStep ?? instance.total_steps` (L254) — falling back `currentStep` to `total_steps` is semantically odd. Add a one-line comment justifying, or revisit the fallback. Non-blocking.

NB3 (doc accuracy): review-request/verification "Base: origin/main@e0721ed25" does not match the actual rebased base (branch is behind 0 vs current origin/main). Update the recorded Base SHA in the verification doc to the actual tip to avoid future confusion.

## Acknowledged Residual (acceptable, not blocking)

T11 data-bearing migration rollback (up → insert jump row → down → reject fresh jump → up → accept) NOT executed: local integration DB unavailable (`DATABASE_URL`/`database "chouhua"`). Per [[feedback_metasheet2_skip_when_unreachable_blind_spot]] discipline it is explicitly marked DB-required and NOT silently skipped. Migration correctness is established by inspection: DDL shape, `NOT VALID` semantics, FK-safe down order, and RBAC column names all verified against actual schema; T-bootstrap + migration unit tests cover the source-level shape. Same class of integration-gated residual as PR1/PR2. Requirement: run the scratch-PG T11 data cycle before/at deploy as a tracked item; record the result in the verification doc when executed.

## Merge Gate (§7.3)

- Worktree clean: PASS
- Boundary checklist (PD1/PD2/PD3/Fix1/Fix2/B3): PASS
- Claude review blocking findings: 0
- Targeted unit (7+5+24) + full unit (168 files / 2193): PASS
- Build + workspace type-check: PASS
- Integration: DB-gated residual (T11 data-cycle pending scratch PG), documented, consistent with PR1/PR2 precedent — not a new failure vs baseline
- Migration rollback: code correct by inspection; data-cycle tracked residual
- Verification doc committed: PASS

Ready to merge. Recommend addressing NB1 (at least the inline comment + verification-doc note) in this PR since it is cheap and clarifies a composed semantic; NB2/NB3 may ride along or be follow-ups. The T11 scratch-PG cycle must be a tracked pre-deploy item.

## Codex Post-Review Disposition

Addressed locally after review:

- NB1: added an inline service comment and a unit test for admin jump into a requester-merge target node. The test verifies the `auto-merge-requester` audit record and the next active assignment after cascade.
- NB2: added an inline comment for the `currentStep ?? instance.total_steps` fallback used when a cascade reaches a terminal-like no-step result.
- NB3: rechecked the branch against `origin/main`; `git rev-list --count HEAD..origin/main` returned `0`, and the recorded base `origin/main@e0721ed25` remains current.

---

End of PR3 §7.2 review.

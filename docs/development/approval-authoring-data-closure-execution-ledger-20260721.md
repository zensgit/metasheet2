# Approval Authoring and Data Closure Execution Ledger (2026-07-21)

**Status:** LIVING - implementation and verification in progress
**Program:** Approval Canvas V2 plus approval-data closure (FWB and attachments)
**Authority:** `ApprovalGraph` and backend `normalizeApprovalGraph` remain the only flow semantics
**Merge/enablement:** no entry in this ledger authorizes merge, UAT, or a runtime flag change

This ledger records exact local evidence for the two development lines. A passing test row means only
the named scope passed on the named head. It is not evidence that the branch is merged, deployed, or
enabled.

## 1. Dependency order

1. Keep Canvas and approval-data closure independently gated.
2. Land or re-review D2-a graph commands and D2-c backend guards before building the V2 renderer.
3. Ratify D0 before D3 or D6-f2 implementation starts.
4. Correct the attachment scanner, request chain, bounded reconciliation, rolling-deploy contract, and
   required-CI collection before accepting the attachment candidate.
5. Compose only reviewed slices on a champion branch; rerun exact-head unit, real-DB, type, required-web,
   visual, accessibility, and eight-scenario gates.
6. Owner UAT and staged flag enablement remain last.

## 2. Model and ownership ledger

| Role | Assigned work | Authority boundary |
|---|---|---|
| Codex | dependency graph, semantic split, sensitive integration, independent review, champion composition | final engineering recommendation; never self-ratifies owner gates |
| Kimi K3 | D0 interaction/visual lock and later screenshot critique | design input only; code and runtime evidence require independent verification |
| Grok Build | bounded implementation slices with named files/tests | one isolated worktree; Codex reviews diff and reruns tests |
| Codex subagents | disjoint pure modules, focused repairs, read-only adversarial audits | no shared hot files; findings are head-scoped |
| Claude Goal (external) | Fable for inventories/docs, Sonnet for medium frontend leaves, Opus for transaction/security adversarial gates | separate session and isolated branch; results must return with exact SHA |

Hot files have one writer at a time: `TemplateAuthoringView.vue`, `ApprovalProductService.ts`,
`ApprovalGraphExecutor.ts`, `index.ts`, and required-CI manifests.

## 3. Canvas V2 ledger

| Item | Exact local head | State | Evidence | Remaining gate |
|---|---|---|---|---|
| Program plan | `c0e6724bb` | committed locally | dependency graph, file ownership, G0-G6 acceptance doctrine | owner review/ratify |
| D0 interaction lock | `ba1d4763a` | PROPOSED, committed locally | 574-line contract; Codex contradiction review corrected accessibility fallback staging | G0 owner ratify |
| D1 ordinary-user hygiene | `4f638cf1f` | implementation complete locally | mounted authoring spec 59/59; web `vue-tsc` clean; JSON/raw-ID/formula-sample regressions checked | compose after D2 decisions |
| D2-a graph command layer | `97cdaa440` | isolated review slice | 4 specs / 106 tests; web `vue-tsc` clean; renderer and hot view excluded | review/merge |
| D2-c backend graph guards | `94b7884b2` | isolated review slice | 2 backend files / 143 tests; backend `tsc --noEmit` clean | adversarial review/merge |
| Legacy graph rehearsal | `c236e349f` | source/rehearsal only | range-diff mechanically equal after latest-main rebase; backend 143/143 and web 175/175 | do not merge as Canvas V2 |
| D6-f1 immutable form commands | `a4d551854` | implementation complete locally | 31 tests and web `vue-tsc`; allocated and retired identities fail closed | review/merge |
| D3/D6-f2 and later Canvas UI | n/a | blocked by design | D0 and predecessor requirements preserved | G0 ratify |

## 4. Approval-data closure ledger

| Item | Exact local head | State | Evidence | Remaining gate |
|---|---|---|---|---|
| FWB activation clean slice | `36c1ab90a` | implementation complete locally, flag OFF | diff-identical clean rebuild; real-DB 8/8, migration unit 3/3, backend typecheck; flag-off zero writes and same-transaction record/revision/claim/outbox | adversarial review/merge/UAT |
| Attachment base stack | `7e80e2083` | source stack only | unit 39, web 25, real-DB 22, both typechecks passed | superseded by hardening review |
| Attachment hardened candidate snapshot | `9d4415826` | preserved WIP snapshot | 43 paths captured without push | must be split and corrected |
| Scanner fail-closed | in progress | Grok isolated lane | missing real scanner must never produce `clean`; flag-on startup refusal required | Codex diff/test review |
| `/refs` request chain | in progress | Codex subagent isolated lane | effective 64KB bound plus 201-500 client chunking and fail-closed merge | Codex diff/test review |
| S3/reconciler/rollout | in progress | Codex subagent isolated lane | cursor-bounded passes plus old/new worker migration compatibility | Codex diff/test review |

### 4.1 Attachment blockers found after the earlier green suite

1. Scan enabled without an injected real scanner could mark unscanned data clean (P1).
2. Storage availability was checked after Multer had already buffered up to 20 MB.
3. The route-local 64 KB parser ran after the global 10 MB parser and therefore did not enforce its limit.
4. The server capped references at 200 while the client sent an unbounded single request.
5. S3 reconciliation loaded the full bucket and DB key set into memory.
6. The scan spec was absent from the required real-DB canary.
7. The new `storage_key` conflict target needs a rolling-deploy compatibility proof against the old worker.

These findings make the previous attachment green suite insufficient for acceptance.

## 5. Verification doctrine

- Construct the failure, not just the happy path.
- A mutation must fail because the intended guard was removed, not because the mutant does not compile.
- Real-DB tests must prove collection in the required run-list; self-skip green is not evidence.
- Concurrency claims require two real actors and both orderings.
- Flag-off byte compatibility and flag-on fail-closed behavior require separate positive controls.
- Rebase invalidates verdict scope until the named tests rerun on the new head.
- Kimi/Grok/subagent summaries are inputs; Codex reruns and inspects before acceptance.

## 6. Process incidents and containment

- During initial replay, a worktree-add failure was followed by a command that acted in the canonical
  checkout. The tracked canonical state was clean and was restored to
  `545813fe2c5cd8d566b92787413f25ec0c55ab98`; unrelated untracked files were left untouched. Subsequent
  operations use explicit `git -C` or an explicit tool working directory and never rely on chained `cd`.
- The attachment hardening candidate existed only as uncommitted files. It was preserved on the local
  branch `codex/approval-attachments-hardened-candidate-20260721` at `9d4415826` before parallel repair.

## 7. Completion conditions

This program is not complete until all of the following are proven:

1. D0 is ratified and Canvas D3-D11-C are merged or explicitly owner-deferred.
2. FWB and attachment production paths are merged with flags still default OFF.
3. The composed eight-scenario approval-data matrix passes through real production entrypoints.
4. Canvas Playwright evidence passes at 1440x900, 1024x768, and 390x844, including keyboard, touch
   alternatives, long labels, diff/restore, route preview, and assistive-technology fallback.
5. Required CI demonstrably collects every load-bearing unit/web/real-DB spec.
6. The final closeout verification MD reconciles exact merged SHAs, migrations, flags, UAT, and residuals.
7. Owner performs UAT and separately decides each production flag transition.

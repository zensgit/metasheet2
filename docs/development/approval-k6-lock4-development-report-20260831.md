# Approval K6 and Lock-4 Candidate Development Report

**Status:** Draft/HOLD evidence record. This report does not authorize Ready, merge, feature flags, dispatch, deployment, staging, or production use.

## Scope

This record covers two already-coded approval candidates that require replay on a then-current `main` before they can be considered for merge:

| Candidate | Exact candidate | Original base | Current documented base |
| --- | --- | --- | --- |
| K6 sequential handover | PR #5392, `f1f8b49c492efe9b8f08c75cdd2f584e8397f1dd` | `25635e67db5145a5998499c4adc8f030e156daf7` | `08d2451734efe2ad0dc1e9e20aa19380a49b5d47` |
| Lock-4 F4-E post-commit isolation | `da359234979e3df63bc7268c9290d451fb84ea44` | `17a548b823c91940b83d6641aadcf6dda196fb1c` | `08d2451734efe2ad0dc1e9e20aa19380a49b5d47` |

Both original bases are stale. The candidates are content-verified only; neither is merged-main evidence.

## K6 Sequential Handover

The K6 delta changes only these production and dedicated test files:

| File | Responsibility |
| --- | --- |
| `packages/core-backend/src/services/approval-sequential-mode.ts` | Parse and inherit one active sequential queue source, rejecting ambiguous or malformed source metadata. |
| `packages/core-backend/src/services/ApprovalProductService.ts` | Apply the inherited queue metadata to manual transfer, admin reassignment, departure transfer, and SLA timeout transfer paths. |
| `packages/core-backend/tests/unit/approval-sequential-mode.test.ts` | Cover ordinary, active, duplicate, mixed, queued, and malformed metadata inputs. |
| `packages/core-backend/tests/integration/approval-sequential-mode.db.test.ts` | Prove real assignment state and queue advancement across the four handover paths. |

### Contract

1. A sequential handover may inherit metadata only from exactly one source assignment and exactly one active sequential queue source.
2. Ambiguous, queued, or malformed sources are rejected rather than minting an invalid active seat.
3. Non-sequential/all-mode sources preserve their existing ordinary metadata behavior.
4. A rejected handover is an explicit conflict, not a silent fallback.

## Lock-4 F4-E Post-Commit Isolation

The P2 delta is limited to these five files:

| File | Responsibility |
| --- | --- |
| `packages/core-backend/src/directory/directory-sync.ts` | Mark directory apply committed, dispatch F4-E immediately afterward, isolate invitation-ledger failures, and retain the committed run state on later errors. |
| `packages/core-backend/src/services/ApprovalProductService.ts` | Update the F4-E runtime boundary documentation. |
| `packages/core-backend/tests/integration/directory-sync-orchestration.db.test.ts` | Inject a real PostgreSQL invitation-ledger failure after commit. |
| `packages/core-backend/tests/integration/approval-departure-transfer.db.test.ts` | Keep the departure writer contract isolated from sync orchestration. |
| `packages/core-backend/tests/unit/approval-departure-transfer-dispatch.test.ts` | Pin the exact run/integration/effect query boundary. |

### Contract

1. The directory transaction first persists `directory_sync_runs.status = 'completed'` and its durable `user_changed` effects.
2. F4-E dispatch consumes those effects immediately after commit, before invitation and later post-commit siblings.
3. A failing invitation ledger produces a values-free warning, does not suppress F4-E, and cannot mark the committed run failed.
4. The dispatcher isolates per-user approval failures and leaves durable signals available for manual recovery.

## Explicit Boundaries

- No automatic retry worker or outbox is added by either candidate.
- No new feature flag, migration, workflow, branch-protection change, provider action, staging action, or production action is included.
- F4-E's manual-recovery signal is not an automatic retry guarantee.
- This report supersedes only the stale K6 statements in Draft #5390; it does not rewrite that historical candidate or claim that #5390 merged.

## Required Landing Sequence

1. Obtain a coordinator-issued then-current-main replay window for each candidate.
2. Replay mechanically, preserve all current-main test unions, and review the range/tree delta.
3. Re-run the listed targeted, real-DB, mutation, type, lint, and exact-head CI gates on the replay head.
4. Keep the resulting PRs Draft/HOLD until an owner separately authorizes Ready and merge.

# Attendance recovery sweep age ordering - #4770 follow-up

Date: 2026-10-24
Status: owner-authorized implementation, independent Draft/HOLD PR.
Base: fdb30a671686db8dbdbdf606f3a6f1b98add9969.

The owner explicitly included the continuous-new-arrival starvation repair in this round. This authorizes isolated synthetic PostgreSQL validation and a Draft/HOLD PR. Merge, deployment, rollout enablement, real UAT and changes to published R71 remain excluded. Stream/lifecycle remain OFF; business error 50004 is excluded.

## Contract

The existing durable rotation gives every never-attempted row absolute priority over previously attempted rows. A full scan window of new rows on every tick can indefinitely prevent an old ready row from being revisited.

Order running, claimable rows by COALESCE(last_attempt_at, created_at) ASC, created_at ASC. A row enters the queue at creation and moves to its latest attempt time after being selected. New arrivals no longer automatically outrank an older attempt. Returned UPDATE order remains unspecified and is not used by recovery.

Preserve the same single-statement atomic last_attempt_at = now() write-back, FOR UPDATE SKIP LOCKED, global running predicate, limit, transaction ownership, per-candidate containment, recovery authority and values-free eight-counter/logger shape. Do not use OFFSET or add priority configuration.

The guarantee is age-based selection among claimable rows, not a fixed wall-clock or tick SLA. Locks, ties, database-clock changes and creation-timestamp provenance remain constraints; a permanently locked row is deliberately skipped. No production state transition or calculation policy changes.

## Verification gates

| Gate | Required evidence | Local evidence before publication |
| --- | --- | --- |
| Continuous arrivals | Original scan: one uniquely identified failed case, 12 filtered exclusions, exit1. Candidate: one passed case, 12 filtered exclusions, exit0; actual later recovery callback and scheduled-run completion asserted | Proven locally |
| Arrival control | Each of four fresh batches has 25 PostgreSQL timestamps newer than the victim's age; no sleep/fake clock establishes order | Proven by the passed regression |
| Existing fairness | Full fairness file: 13 actual passed, zero skip/pending | Proven locally |
| Concurrency | Existing held-row and concurrent-worker legs included unchanged in the full fairness file | Proven locally |
| Mutations | Old NULLS-FIRST and fixed-prefix ordering each cause one matching assertion failure; removed SKIP LOCKED causes one lock-timeout runtime failure, not a named assertion capture. Each has 12 filtered exclusions and exit1; candidate restored byte-exactly | Observed locally |
| Neighbor | Real host/scheduler/HTTP call-through: 8 actual passed; scheduled-run transactions: 31 actual passed; both zero skip/pending | Proven locally |
| Quality | W7/W6R5 preservation unit guard: 13 actual passed; pnpm validate:all exit0 | Proven locally |
| Independent review | No P1/P2 in source review; one P3 stale-comment correction applied. Final review/hash binding is recorded in the PR evidence | See PR evidence |
| Required CI | Post-push actual-head checks are recorded separately in the PR body; no pending or skipped check counts as success | Pending publication |

No declared ordering index exists in the base migrations, so this slice adds no speculative index or migration. Catalog/performance guarantees are not inferred from that source census.

Results identify actual assertion status separately from filtered exclusions. Issue closure is not authorized; refs #4770 and #4556. This slice adds no authorization for FSER-4.

## Source and evidence boundary

Runtime behavior changes only in the scan ordering expression. The worker's executable tokens and all pre-existing fairness test bodies remain identical after parser-based comment removal. The later P3 edit is comment-only; the 52-case PG run is bound to the same executable source, not described as a rerun after that comment edit.

The first reproduction harness expected a JSON stack/line that this reporter does not provide. That attempt is retained as ambiguous and is not counted as the identified reproduction. The identified red run uses the unique SWEEP_CONTINUOUS_ARRIVAL_RECOVERY_REVISIT assertion message. A discarded standalone lexical scan could not track template-literal context; parser-derived token comparison supplies the valid source-preservation result.

Local environment: Node20.20.2, pnpm9.15.9, isolated UTF8 PostgreSQL16. CI uses its own recorded environment; local results are not substituted for actual-head CI. Every temporary mutation was restored, and only the test-owned cluster was stopped with its data directory retained.

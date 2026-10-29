# Legacy-plan precondition organization scope: native verification (Draft/HOLD)

The bounded target is the ten SQL definitions and fourteen direct call sites in `w4c3a-legacy-plan-preconditions.ts`, on main base `a03d804d60d83717feaedce099e5ff14216afc58`. Their source is identical to the earlier parent-source audit. This is one family within the full MUT06 parent scope.

## Change and registration

A separate integration file exercises real PostgreSQL results from the existing record/group precondition functions. It is registered once in the executable native DB run-list and once in the no-DB config exclusion. Both original registration files retain every previous byte after removing the one new row. No production source, migration, dependency, scanner, allowance, budget, source policy or feature flag is changed.

The fixture invokes the existing production migration CLI with its TypeScript loader, asynchronously so Vitest RPC remains responsive. It lists first and applies only genuinely pending entries. All qualified local phases observed zero pending migrations, so none was executed again. The real group FK remains present and all constraints are checked immediately. Each case rolls back its own uniquely named fixture transaction.

## Actual local evidence

| Gate | Observed result |
| --- | --- |
| New native file | 9 distinct cases passed, zero skipped/filtered/todo |
| Executed production SQL | All 10 pinned definitions and all 14 source call sites observed in native receipts |
| Predicate faults | 8 separate single-predicate removals have matching named failing legs; parameter arity/type is retained |
| Global-ID binding faults | 2 separate post-read org guard faults have matching named failing legs |
| Fault execution counts | 10 source-fault phases, 11 failed leaf executions and 2 passing control executions; these are not unique-case additions |
| New-file wiring | 2 selected source guards passed; 322 filtered guards are not passes |
| Incremental quality | New-file AST lint 0 diagnostics; test-root type diagnostics baseline 4/current 4/introduced 0; no whole-backend typecheck-zero claim |
| Restoration | Runtime source restored exactly to SHA256 `77a5a8e74037ceeb9e4ffedd89845bf12db92bac2391812e0d9d1fe8505c379e`; owned PG closed and data retained |

The native cases cover existing/missing records, their revisions, existing/missing member pairs, a foreign normalized group name, current membership revocation with foreign liveness, and global group-ID refusal/collision. Runtime receipts carry only case codes, SQL hashes, row counts and source lines. Query results are passed through unchanged.

`READ_MEMBER_SQL` and `ACTIVE_ORG_MEMBER_SQL` retain `LIMIT 1`: their existing-active cases can remain positive under a removed later predicate, while the missing/revoked cases provide the matching red legs. The original two-red harness hypothesis was rejected from actual leaf results. The successful baseline nine and completed faults one through seven were not rerun; only the three unexecuted faults continued. Assertions and source guards were not weakened.

For the first global-ID guard, the mutation is detected by the loss of immediate refusal after the locked foreign row; a later guard still refuses. This is early-refusal/query-budget evidence, not a foreign-row leak. The membership-only global-ID read is independently rejected before fingerprint acceptance. These are direct precondition fixtures with only the frozen fields this boundary reads, not a full verified-plan worker or HTTP admission claim. Deliberately inconsistent org/group member pairs satisfy the real single-column FK; this does not claim an authorized public writer can create them.

## Retained failed preparation phases

The first beforeAll attempt could not load TS migration files: nine leaves remained pending and no native cases executed. The next synchronous CLI attempt emitted nine native query receipts but blocked Vitest task RPC; all nine assertion statuses remained pending even though aggregate fields said success/9 passed. Those aggregate fields are not credited. The asynchronous candidate then obtained the qualified whole-nine result. Original logs and reports remain retained.

The production SQL body and all nine test assertions are unchanged after that qualified baseline. The existing whole8/whole12 concurrency suites were retained from earlier CI, not repeated locally. No full validate:all, fresh backend build, whole parent denominator, complete MUT06 or product/production acceptance is claimed.

## CI corpus registration repair

The first published head, `7848bf2a1d1dd0fbc05fc07426f42b43e520a52a`, failed the existing W4C-2 wiring gate before dependency installation or native execution. The complete 638310-byte backend log is retained with SHA256 `90011fcee27ee34ef17205ce981391697c97d7422298aa6e453000122466448e`. The gate actually ran 324 cases: 320 passed and 4 failed. Disk/run-list derivation found 141 attendance suites while the fixed expected set still contained 140; the new native file was missing from that set. The filename-selected two local registration checks had not covered these four corpus-wide assertions.

The repair adds exactly the new suite's row to `EXPECTED_ATTENDANCE_SUITES`. Removing that row reproduces the prior source byte-for-byte; every scanner and assertion is retained. Only the four failed corpus/set/multiplicity assertions were then selected: 4 passed, 320 filtered/skipped, zero failed/todo. The 320 filtered cases are not passes. Neither the already-passed two registration leaves nor native whole-nine nor completed source-fault phases was rerun. PostgreSQL was not started. The later cleanup failure on the failed CI job followed its skipped PG-start step; no cleanup guard was changed.

Actual receipts, source-fault manifests, diagnostic reports and the final local audit are retained under `artifacts/attendance-mut06-legacy-preconditions-native-20261029/`. CI evidence must be read from the eventual exact PR head; local proof is not current-head CI.

Keep Draft/HOLD. No merge, deployment, R71 change, tag/release, target-server migration, business configuration or provider/live write. Stream/lifecycle/external writes remain OFF. Real UAT50004 is excluded; historical08PUT remains inconclusive. Refs #4556.

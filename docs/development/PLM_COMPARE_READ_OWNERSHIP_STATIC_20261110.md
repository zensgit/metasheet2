# BOM comparison request ownership — static delivery

Date: 2026-11-10. Status: independently accepted static implementation; execution NOT_RUN.

## Change

Editing either comparison ID while a request was pending allowed its old result or error to publish under the new IDs. The View now invalidates pending ownership synchronously on ID changes and assigns each dispatch a generation. Only the current generation may publish a result, invoke the auth-error callback, set the comparison error, or clear loading. An ID edit releases loading immediately while preserving previously published data. A same-tick A → C → A edit still invalidates the old request.

The existing query/payload option meanings and current-request error handling are preserved. There is no new loader framework, dependency, workflow, backend or write-path change.

## Exact local identity

- Base: `e958714d6a72aaa5cd61017e901f98d0968fc051` (the already published Draft6696 head; this change is not rebased on main).
- Source commit: `56b07a4ba8d156666778558e27052fb41bf7744c`.
- Source tree: `0e514587c4d68342dae8772a876812ea45fccdd4`.
- Local branch: `codex/plm-compare-read-ownership-20261110`.
- Production path: `apps/web/src/views/PlmProductView.vue`, only the compare-loader block and its immediately preceding ownership state/watcher.
- New regression: `apps/web/tests/plmCompareLoadOwnership.spec.ts`.

## Evidence and limits

Root and an independent reviewer accepted the production change. The same Grok session corrected two static test findings: reactive-proxy result assertions and the EffectScope cleanup type. The final test differs from its first version by exactly the requested five lines. Root made no product-code changes to the accepted Grok outputs.

The regression file has 10 authored cases: one source-anchor case and nine behavioral cases. It extracts the actual View comparison region, transpiles it, and uses real Vue refs/watch with deferred service mocks. It covers current success/options, either-ID stale success/error, same-tick ID reversal, both response orders, same-ID supersession, current errors and fallback. None of these cases has been executed. This fixture is not a mounted whole-SFC, browser, HTTP, real IdP, installation or business acceptance test.

Six read-only capsule inputs retained their hashes. The accepted loader and spec hashes are `bb84b2db25b3ff6c3c162225093c2296d94764202e684014030bab16e7f57da5` and `580dcdd7df4d6a0d45346165a69cacd23fbaf201135a9c3adb46e382f02c45da`. Reversing the one View replacement reproduces every base View byte. Git tree/path and whitespace checks passed. Tests, typecheck, imports, builds, dependency installation, product runtime and new CI are NOT_RUN. Draft6696's earlier CI qualifies only its fixed base, not these new changes. The new spec has no new CI registration in this increment.

Requested author model/effort: Grok 4.7/high. Native CLI displayed Grok 4.7/xhigh; the author self-reported Grok 4.7. Backend model/effort are independently UNKNOWN. The same owned session produced both revisions and was closed after all nine input/output hashes were rechecked. The approved hooks repair was consumed exactly once. Ignored 2000ms hook timeout warnings and truncated terminal history remain recorded; complete trace, all side effects and global HOLD intersection are not established.

## Remaining boundaries

This is local source plus one documentation commit, with no push, PR creation, dispatch, merge or deployment. All seven delivery packages remain OPEN. N2's retained lease and every Source23/W2/H3/StageA/RG249/perf/inventory/O-axis/P16/browser/runtime restriction remain in force. Future publication or execution requires its own concrete reviewed scope and exact authorization. Results after this fixed source/documentation pair belong in receipts/state/PR results only.

The detailed independent reviews, byte proof, Git tree admission, tool receipts and fixed candidate archives are retained under the task's existing `artifacts/plm-listener-review-20261015/unattended-12h-20261101/grok-tool-restore-20261101/plm-compare-read-ownership-20261110/` results directory.

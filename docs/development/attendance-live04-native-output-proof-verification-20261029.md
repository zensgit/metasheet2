# LIVE04 native output proof - Draft/HOLD

Base: #6637 `2310699b05c1fb94fe6b13710ec4799bf7c81cfc`; its business source is #6630 `fc914ccb6fe5ec628f184ea0ea71d55c79be1a4e`. Current main is not claimed equivalent.

Two existing manual-overtime cases now compare the stored merge-policy column and semantic/source/provenance fingerprints against intended inputs from native physical events, the pre-decision freeze, the approved fact and the nonnull manual snapshot. Expected fingerprints do not reuse the stored fingerprint inputs. The existing configured-shadow scheduled case now requires a completed calculation and one physical child with exact organization/record/calculation lineage, instants, work values and evidence references.

One new case first commits a legal same-user/date foreign peer through the actual scheduled activation boundary. With production composite FKs intact, the shared calculation INSERT rejects an own-org intent carrying the foreign record (`23503`, `fk_arc_record`). A second probe executes the real child INSERT SQL and PG responses while introducing only a foreign org/record parameter-binding fault; the new own calculation ID is retained so this reaches `fk_ars_calculation`, not a duplicate peer key. Both transactions roll back and both organizations' record/calculation/child snapshots remain identical. These are storage-binding/FK negatives, not HTTP identity forgery, a legal foreign-row leak, or org-WHERE predicate mutations: the two INSERT carriers have no such predicate.

## Executed validation

Existing whole37 cutover and whole10 scheduled runs on fc914 remain historical phase evidence. Both files were already registered in post-migrate CI and excluded from the no-DB default lane; no workflow registration changed.

| Phase | Actual result | Scope |
| --- | --- | --- |
| Four affected native leafs | Cutover 2 passed / 35 filtered; scheduled 2 passed / 9 filtered | Three extended cases and one new case, on the production-migrated owned PG16 database |
| Semantic manual-input omission fault | 2 matching failed / 35 filtered | Only the helper fingerprint's manual-override input changed to null; both failures identify `LIVE04_NATIVE_INTENDED_SEMANTIC_INPUTS` |
| Stored merge binding fault | 2 matching failed / 35 filtered | Only SQL policy binding changed to append; both failures identify `LIVE04_NATIVE_STORED_MERGE_POLICY` |
| Strengthened child-FK case | 1 passed / 10 filtered | After adding the second FK probe, only that changed case reran; the other three passes and both mutation phases were retained |

The final candidate has four distinct affected passing cases, not five; the last phase repeats the changed FK case. Vitest JSON labels the name-filtered cases skipped; those are not passes. The two FK probes are assertions inside one passing case, not extra failed-test or mutation credit. No fresh whole37, whole11, or parent MUT06 pass count is claimed.

Commands used `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run` with the two existing integration files, name filters and verbose + JSON reporters. Filters selected `EP01 shadow overtime bounded-manual(?:-explicit)? preserves`, the existing `shadow binds the real scheduled calculation identity and effective context` case, and `LIVE04 shared INSERT rejects wrong-org parent after a legal foreign peer commits`. Each fault selected only the two manual cases; the continuation selected only the changed FK case. Database connection values stay outside this document.

The shared helper was restored byte-exact after both faults: SHA256 `0e76e6f46333549201a323a7790ba5b527d31ddf3752f717f7d467e082bfdf32`. Owned PG processes stopped successfully and data was retained. No unchanged successful whole suite, dependency installation or full migration was repeated.

Explicit AST lint baseline/current: cutover 1/1 existing diagnostic, scheduled 0/0, introduced 0. The final scheduled revision also has 0 AST diagnostics. A targeted no-emit test-root type comparison has baseline 325/current 323 existing diagnostics and introduced 0, reusing the original baseline. An earlier raw comparison reported two unchanged middleware diagnostics solely because quoted-literal union display order differed; raw reports are retained and only that display ordering was canonicalized. This is not typecheck-zero, typed-lint-zero or a fresh whole-backend/validate-all claim.

Raw reporter JSON/logs, exact source/fault hashes, restoration proof and the earlier quality-harness result are retained under the owned `artifacts/attendance-live04-native-output-proof-20261029/` evidence directory. The source/log audit was performed by the main agent; no independent-review credit is claimed.

## Remaining boundary

Only two existing test files and this verification note change. Runtime, schema, workflow, scanners, exclusions, budgets, dependencies, flags and production configuration remain byte-identical to the base. Actual automatically created stacked-branch CI is recorded separately; no main-only job execution is inferred from an uncreated check.

Whole LIVE04/MUT06 denominator and other organization facets, manual financial acceptance, owner decisions, browser/manual/soak/live-provider gates and production readiness remain open. Keep Draft/HOLD; no merge, deployment, R71, tag/release or external-write enablement.

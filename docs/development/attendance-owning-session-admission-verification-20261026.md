# Owning-session admission verification — 2026-10-26

Draft/HOLD, refs #4844. Base main40ce1b47eab87b5fb4d7f69b3b8b9f7cfcdd003b. The user directly authorized the internal interface upgrade; owner/production acceptance is separate.

## Contract and source

The private adapter is pinned to pg8.16.3/pg-pool3.10.1. It observes actual ReadyForQuery from connection establishment, validates live backend/checkout generation and admits only quiescent I. The opaque handle has no query method; an exclusive lease scopes body queries. Query-only, forged, copied and standalone-client handles cannot establish admission.

Borrowed T/E/unknown refuse without SAVEPOINT, cleanup SQL, callback, emit or discard. A closed admitted owner retains unresolved ownership until actual I; host handoff destroys only its own unsettled checkout without cleanup SQL. A successful detached query still blocks normal handoff until protocol completion. Original errors, bounded retries and statement/lock budgets remain.

The two CLIs load pool, issuer and boundary through one CJS graph; no global trust registry/stamp bridges duplicate tsx module instances. Joining ports remain query-only. No dependency/lock/migration/OpenAPI/SDK/permission/flag change.

SQL-literal comparison covers19 changed runtime files: only three obsolete SAVEPOINT-probe statements were removed, and the old COMMIT adapter literal moved to the driver. Other SQL sequences match. The audit records324 unchanged named function bodies; this is bounded static evidence, not a complete dynamic graph.

## Actual phases

Counts describe individual invocations, not a fresh whole-candidate aggregate. Filtered cases are exclusions. Unchanged passed suites were not repeated solely to refresh receipts.

| Phase | Actual evidence |
|---|---|
| First driver lifecycle | 18/18 unit assertions using real pg Client/Pool/parser and synthetic wire; not real PostgreSQL |
| Custom Query escape | 1 matching red; fixed case plus native COMMIT budget control2 passed/17 filtered |
| Owned unsettled handoff | 2 matching red; fixed cases plus detached-success control3 passed/18 filtered; types/lint0 |
| Meta-event escape | Raw Client capture actually sent unauthorized COMMIT; 11 matching red, then11 passed/21 filtered; types/lint0 |
| Release observer | 3 passed/32 filtered: duplicate attempts versus handoff, active-owner refusal, caller argument versus synthesized disposition |
| Listener lifetime | 2 matching red, then2 passed/35 filtered; types/lint0 |
| Original Gate E PG | 18 passed/0skip: both sites, caller writes/savepoints/read-only/no-xid SERIALIZABLE/aborted, queued BEGIN and raw fences |
| AST ownership guard | 84/84, independent five-site literal-BEGIN census and strict unknown/signature/wrapper negatives |
| Migrated unit fixtures | Nine files106 passed/3 failed due unavailable Vitest1.6 mock.contexts; explicit native receiver capture: affected3 passed/10 filtered. Later helper const correction is syntax-only |
| Outbox/sweep PG | 17 passed/0skip |
| Release-destroy PG | First33 passed/2 failed/1 skipped sentinel/2 existingTODO; corrected session-as-lease fixture affected2 passed/36 filtered |
| Further PG batch1 | Five files13+30+32+17+31 passed, no skip |
| Further PG batch2 | Canonical13, import rollback49, rollout control68 passed; W4 CLI first16passed/15failed, corrected graph/direct-lock fixture affected15passed/16filtered |
| Registration/quality | W7 double-ban13 passed; explicit CLI TS-parser/new-helper lint0; production validate:all exit0 |
| Further integration | 26 files582 passed; three conditional EXPECT_DB sentinels skipped and two existing P11 TODOs separately retained |
| Remaining unit callers | Three files59 passed/0skip |
| Standalone protocols | Timezone/calendar61, CSV15, rule overrides27 passed/0skip under original configurations |
| Native destruction proof | Disabled native discard:1 matching red/17filtered, actual backend remained alive; exact source restored:1 passed/17filtered, failed backend confirmed absent |
| End fence | Two new Promise/callback controls passed/37filtered; suspected missing guard refuted in lower driver; no runtime change |

The test-only release observer counts before the actual facade guard while retaining the issuer-registered Proxy identity; pool handoff events remain independent. Native fault interception preserves original receiver/arguments/error identity below the dispatcher and never stamps idle/ownership.

Earlier zero-match probes, compile/lint errors, harness oracle corrections and CLI split-instance failures remain retained. Matching negative evidence is counted by assertion status, not Vitest1.6 header totals. Existing TODOs/skipped sentinels are not business acceptance proof.

Owned UTF8 PG uses verified ledger458 without replaying migrations; each controller records actual stop/postmaster identity and retains data. No real tenant/provider IO.

## Published-head CI adapter repair

Draft #6568 head6481d44 reached12/13 required success. Its backend failed at core85 in the sharding pg mock and two SQL/fence static-guard adapters; later database cleanup failed because setup had not started. The complete failure log and original local three-file reproduction remain retained. Driver39 actually passed in that CI invocation, independently of the overall failed job.

The sharding suite now mocks only its replaced DB adapter, without faking driver protocol/lease trust. Private driver forwarding puts the SQL argument-array carrier first; only six declarations/calls change order. Affected driver39 plus sharding17 passed56/56, real-PG positive smoke2 passed/16 filtered, explicit lint and production validate:all exited0. No other unchanged business suite was replayed.

The fence analyzer proves four exact declaration-keyed lease delegations and the private transaction lifetime. Its full81 assertions passed, retaining the original test bytes,16 ledger keys/21 sites/five public ADR seams and ordinary two-callee depth. Explicit same-path lint comparison introduced0 diagnostics. The W6 analyzer's complete98 assertions now pass with zero skipped. It distinguishes the native SQL argument-array carrier from config.text, retains first-formal/nonempty-caller checks, and separately proves pinned protocol notification and three exact non-SQL facade roles. Unknown/composed/shadowed targets remain refusals within the bounded grammar. The original local-provenance depth4 and closure expansion rounds8 remain; this is not a general JavaScript/proxy/alias proof.

Independent source review identified candidate-helper misclassification of non-SQL array elements and native container aliases; bounded original-source probes confirmed these shapes. A second review identified custom-submit config and returned-method overwrite; both named controls actually red, then passed after the narrow fixes. Earlier intermediate runs (81/83,84/88 and11/12 selected) retain their failures; newly added oracle expectations were corrected to include the expanded caller scan and the existing zero-caller refusal channel. No original assertion or budget was removed. Explicit same-path lint of the four guard/helper files introduced0 diagnostics.

A new published-head CI result remains pending; no whole-product acceptance is implied.

## Open gates

The explicit53-file test lint comparison has zero introduced errors/warnings; four unchanged pre-existing plugin require errors remain visible under this no-ignore scan. Only our six type imports/two orphan helpers were corrected. Nonsemantic cleanup preserves all eight files' test bodies and the two runtime files' transpiled JavaScript byte-for-byte. An updated source/hash audit precedes each normal fast-forward update of Draft #6568. Affected caller/protocol execution and independent source reviews are recorded above. Published-head required CI and evidence readback remain pending. The conditional recovery-only #6564 does not close original #4844.

Manual/owner/W8/PQA/frozen-transfer/performance/live evidence stays separate. No merge/deploy/R71/tag/release/business-config change. Stream/lifecycle OFF; real UAT and business50004 excluded; historical08PUT INCONCLUSIVE.

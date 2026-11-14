# Approved overtime frozen-source native proof — Draft/HOLD

Refs #4556. Test-only follow-up to Draft #6607; no runtime, schema, SDK, permission or configuration behavior is changed.

## Contract and scope
After a supported ordinary OT request freezes its attribution/context, changing the current synthetic shift timezone/grace or the current holiday working-day source must not replace that frozen definition at approval. The same immutable inputs must reach the canonical calculation, fingerprints, operation seal and replay. No current-policy context is manufactured for the old request.
This proves two actual HTTP fixture cases, not absence of every current SQL read, financial-policy freezing, all calendar configurations, real DingTalk delivery or real UAT.

## Gates
| Gate | Evidence |
| --- | --- |
| Actual HTTP source changes after request freeze | Shift bundle and holiday cases each pass, with old/new source values distinguished and exact snapshot/calculation/hash/binding/seal/replay checks |
| Actual current-source fallback counterfactual | Temporary current shift/holiday DB reload into the candidate frozen context produces two named409 SNAPSHOT_CONTEXT_MISMATCH failures; exact source restoration passes both |
| Existing cases and failure budgets | Original30 whole-file/import/case bytes remain unchanged; only2 new expanded cases with120000ms budget |
| Focused quality | Explicit baseline/current native lint and current validate:all are required before publication; raw receipts carry the actual outcomes |
| Current-head CI | Must execute the registered native file as32 actual cases and all required checks; no parent green borrowed |
| Full EP01/product/production acceptance | Not established by this test-only slice |

Positive2/30filtered, mutation2failed/30filtered, restoration2/30filtered are separate phases and2 unique cases, never6 unique passes. The mutant is not committed. Initial native runs use source2655; rebasing onto classification-only52182 preserves the entire tested backend/plugin source tree.

Evidence: native-source-probe-source-proof.json; native-frozen-source-main-independent-audit.json; frozen-current-fallback-mutation-audit.json. All native DBs are isolated synthetic clones; owned clusters stop and data is retained.

All PRs remain Draft/HOLD. No merge/deploy/R71/tag/release/provider or business configuration writes. Stream/lifecycle/externalwrites OFF; real UAT and50004 excluded; historical08PUT inconclusive.

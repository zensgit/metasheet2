# Canonical manual provenance envelopes and nonzero financial regression — Draft/HOLD

Refs #4556. Depends on Draft #6608 at6475db972f98e3a73d502d523c571fab43c00c05. This slice repairs the existing manual-edit consumer of flat canonical provenance metadata and adds one registered native regression plus nine query-stub admission guards. Financial, permission, schema, workflow, dependency and configuration policies are unchanged.

## Defect and minimal behavior
Canonical live/scheduled writers store five provenance reference fields plus operation metadata such as payloadFingerprint. The manual consumer passed that complete flat envelope into the exact-five-field fingerprint validator, mapping its rejection to409 W4C3C_MANUAL_EDIT_PRIOR_INCOMPLETE. The before-fix file is byte-identical to the pinned underlying main2e3aed2540659cd7a133f7b8c3f888b01115c7f8; no deployed incident/root-cause claim is made.

Project only the five canonical fields for the existing flat envelope branch. Nested provenance still enters the unchanged strict validator, and missing/invalid canonical fields or a stored fingerprint mismatch still refuse. No fingerprint algorithm, old row, provenance reference, SQL selection, connection ownership or authority source is replaced.

## Gates and actual evidence
| Gate | Actual evidence |
| --- | --- |
| Native reproduction | One compound HTTP/PG case fails at manual409; diagnostic-only retry names PRIOR_INCOMPLETE. Both runs filter original32. Actual-export probe shows flat envelope rejection and identical fingerprint after five-field projection. |
| Native positive | After the bounded consumer fix, the same case passes: linked non-null manual override, actual60-minute lot/event observed inside the transaction before deliberately failed canonical append, exact rollback across15 enumerated tables, same-operation retry with one grant, canonical/frozen/manual/fact preservation, seal/outbox and exact response/state replay. |
| Matching counterfactuals | Exact old consumer yields one matching manual409 failure; disabling only the actual comp-time grant yields one matching failed observation. Sources restore exactly; final native1 passes. Each phase filters32; all are the same one unique case. |
| Closed-reference admission | Nine query-stub actual-consumer cases pass: valid flat/nested2 reach a sentinel before INSERT execution; seven malformed source/nested/fingerprint variants refuse409 with zero calculation INSERT attempt. Malformed nested objects/array retain valid flat siblings, preventing a vacuous fallback check. This is not DB or authorization proof. |
| Original native cases | Complete original32 file/import/budget bytes reconstruct exactly by deleting the addition; unchanged cases are not rerun locally. New case remains120000ms. Native file was already registered in required backend CI; no new frontend spec. |
| Quality | Current code-phase validate:all exits0. Explicit same-config runtime/native/unit lint adds0 errors/0 warnings; one pre-existing native any warning remains. Final evidence-only documentation rewrite does not alter those code inputs. |
| Independent reviews | Bounded native oracle, runtime hunk and unit oracle source reviews plus main raw-report/hash audits have no confirmed introducedP1/P2; reviews are advice, not execution proof. |
| Current-head CI | All13 required terminal successes plus actual newunit9/nativewhole33 and affected manual PG file execution are required after publication; no parent/sibling greens borrowed. |

## Boundaries
The local proof is one synthetic authoritative comp-time conversion with banking/segmentation disabled, not the full bank-policy/financial universe, full DB fingerprint census, real authentication, provider delivery, concurrency/performance, UAT or full EP01. Rollback equality enumerates15 named business tables. Settings are global only within the disposable owned DB and are finally restored and GET-verified. The owned trigger/function/sequence are UUID-named and finally dropped. Inherited fixture teardown is best-effort; owned clusters stop and data is retained.

Raw first failures, diagnostic failure, mutant reports and exact-restoration receipts remain alongside source/review/quality evidence. Main corrected the new test's pre-run event oracle to require the legitimate one adjustment audit while preserving physical evidence; authoritative auditId=operationId was source-confirmed, unlike the legacy shadow path. No product assertion or budget was weakened to get green.

All PRs remain Draft/HOLD. No Ready/merge/deploy/R71/tag/release/business configuration/provider writes. Stream/lifecycle/externalwrites OFF; realUAT and50004 excluded; historical08PUT inconclusive. DG-OT-01 named minute-source question remains pending and unimplemented. This is not R76/R77 enablement or whole-product acceptance.

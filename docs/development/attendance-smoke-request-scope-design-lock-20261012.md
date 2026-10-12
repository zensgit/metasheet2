# Attendance smoke request and record organization scope

Baseline: 1dd42d08761039c9937dae06c712fadd10092ab6. Scope: existing acceptance URL helper and existing behavior spec only. Public publication, merge and deployment remain separate decisions.

In the owned fully synthetic runtime, non-default organization import, group membership and approval writes succeed, but the approved request list defaults to another organization. The smoke's import URL helper currently binds only import endpoints; request creation carries orgId in JSON while approval/list/record verification may omit the selector. Existing mock responses ignored this distinction.

Bind the same explicit organization on import endpoints, request collection/actions and record collection/readback, preserving other query fields. Reject contradictory or duplicate contradictory org selectors; leave auth, global directory/audit, rules/me, leave-balances/me and lookalike paths untouched. Preserve the existing helper export and fixed mismatch code. No backend tenancy rewrite, policy weakening, new flag, environment mutation, or global settings changes.

| Gate | Required evidence |
| --- | --- |
| Counterexample | Existing smoke mock refuses requests/records in default/wrong org; original helper fails |
| Positive | Actual smoke subprocess completes under a strict mock organization filter |
| Negative | Wrong and duplicate conflicting selectors fail; unrelated/lookalike paths unchanged |
| Wiring | Existing whole-file scope spec remains in plugin-tests with existing neighbor |
| Reproduction | Canonical UUID synthetic runtime approved-request/record readback succeeds after helper repair |
| Review | Independent source/test review, saved-byte mutation and restored positive control |
| Quality | Focused suites, syntax/diff and validate:all pass on the final candidate |

The earlier locale replacement-token patch is retained on its own branch. This concern is separate and must not silently extend that branch's pending publication approval. Global effects, frontend routing qualification and full Strict/performance gates remain separately evidenced.

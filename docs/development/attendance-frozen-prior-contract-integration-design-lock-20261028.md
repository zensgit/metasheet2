# Frozen-prior contract integration design lock — 2026-10-28

## Scope and immutable inputs

Integrate only the delivered frozen-history HTTP proof from Draft #6580 at
b92ab060ed075ebeb35410c72531350ffcc6fa9f and the delivered frozen-prior correction
from Draft #6594 at60056b6fe53faf601799ecc746084699040dc0ab, on fresh main
2e3aed2540659cd7a133f7b8c3f888b01115c7f8. Their concern path union is seven.
Import the separately qualified StageE9k shared-backlog fixture isolation from
Draft #6610 at8fffe1434fea2cee2d71a669c7261d68326b9ee6 as one test-only CI
prerequisite, without its overtime runtime or unrelated native additions.
These are source inputs, not merged PRs or claimed Git ancestors.

## Named reconciliation

For policy=frozen_prior only, persisted prior.merge_policy is a frozen semantic
input. C1 must persist that same policy and independently compute the complete
nine-key semantic fingerprint. The canonical hash primitive is reused; this is
independent input assembly, not a second cryptographic implementation or copying
the prior hash. The six frozen snapshots/source fingerprint and output/history
constraints remain.

This narrowly supersedes the different-merge-policy/different-hash expectation
in #6580's historical semantic-domain section and CALC13 oracle, when composed
with #6594. Original source/receipts remain historical; chronology alone is not
the justification. #6594 records the reproduced defect and implements this
persisted-policy correction. Runtime is imported exactly from that input, not
changed back to unconditional merge. current_policy behavior remains unchanged.
DG-OT-01, correction-target and CALC14 decisions are not made here.

## Gates

1. Preserve the real CALC13 original matching red under the delivered runtime.
2. Real HTTP punch09–17, shift PUT10–16/grace/rounding edit and frozen_prior
   recompute must retain C0, all six snapshots, independent fingerprints and480
   output; advance exactly one version/calculation/child, retain event counts,
   correct OCC/supersession/response/native ownership and environment finally.
3. Explicitly assert prior append policy and C1 prior-policy equality, plus
   both independently assembled semantic expectations and equal semantic hashes.
   Retain all other assertions/hooks/imports/budgets including120000ms.
4. New public candidate must pass its own focused case. A temporary old
   unconditional-merge runtime must fail the matching policy/hash gate; exact
   restoration must pass. No thresholds, retries, gates or permissions weakened.
5. Preserve #6594 native case bodies and all other #6580 case/hook bytes.
   Both native files already enter backend required CI; no frontend spec.
   Validate quality and introduced lint diagnostics. Filtered/skipped/todo are
   not passes; no unchanged green local suites rerun.
6. Publish only Draft/HOLD with reproduction, patches, phase/source evidence.
   Current-head required CI must all terminate success with actual target logs;
   parent/private/sibling greens are not substitutes.

## Boundaries

One frozen legacy-target integration proof is not full five-entrypoint EP01,
all timezones/groups/calendar fallback, current_policy semantics, authentication
universe, human AT, UAT/provider delivery or production acceptance. No schema,
dependency, OpenAPI/SDK, permission, configuration or flag change is authorized.
All PRs remain Draft/HOLD: no Ready/merge/deploy/R71/tag/release/provider writes,
Stream/lifecycle/externalwrites OFF, real UAT and50004 excluded, historical08PUT
INCONCLUSIVE.

## Actual public-candidate validation

The isolated real HTTP/PostgreSQL CALC13 case passes1 with25 other cases
filtered. Temporarily restoring unconditional merge produces1 matching failure
at CALC13_RECOMPUTE_PRESERVES_PRIOR_POLICY with25 filtered; exact runtime
restoration passes the same1/25 again. This is one unique case across phases,
not26 local passes. Runtime restoration and all nine source pins were verified;
the owned cluster is stopped with data retained, ledger452 reused without
migration replay. No private-candidate green is borrowed.

The earlier private composition demonstrates the original conflicting oracle
failure1/44 filtered and corrected1/44 filtered; its different source scope is
kept separate. The public candidate uses the delivered runtime/native file
byte-exactly, and every request-file byte outside CALC13 remains exact to #6580.
Original120000ms budget and the complete remaining CALC13 safeguards stay.

Four executable files were linted against both fresh-main and their qualified
input versions with identical configuration: introduced errors/warnings0.
Existing diagnostics are retained, not represented as zero total diagnostics.
pnpm validate:all exits0 on the complete public candidate. Independent bounded
nine-path source review reports no confirmed introducedP1/P2 and is not counted
as runtime evidence. This evidence-only append preserves every tested
executable hash; unchanged green suites were not repeated.

Receipts: public-native-mutation-state.json,
public-main-independent-native-source-audit.json, public-quality-state.json,
public-integration-independent-review.json and candidate-final-source-manifest.json.
Current-head required CI and complete registered request/native/StageE execution
must still be collected after Draft publication. All HOLD boundaries remain.

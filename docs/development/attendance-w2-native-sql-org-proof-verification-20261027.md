# W2 native SQL org proof verification

Draft/HOLD candidate over main `5193da4c5667418a8bd9fa40a9a80021cdcac077`.
Only the existing registered real-PG test file and two documents change.
No persisted runtime, permissions, schema, dependencies, workflow, flags or
API-contract changes. Stream/lifecycle and external writes remain OFF.
No merge, deploy or R71 change; real UAT and business50004 remain excluded.

## Local execution

All native execution used the uncommitted candidate over the base above,
Node20.20.2/pnpm9.15.9, an isolated PostgreSQL16 UTF8 database with the
existing458-entry migration ledger. No migrations were replayed. Own PG
was stopped after each phase; its data was retained.

Three new unique cases exercise published direct/rotation candidates,
active-current open records and approved legacy overtime for one global
user with active memberships in two organizations. Exact legal A/B results
and existing-user/nonmatching-date empty controls use unchanged native
database rows. All ordinary constraints stay enabled.

The first selected baseline had3 actual passes, one new OPEN date-oracle
failure and10 filtered exclusions. The failure was test representation:
native DATE at local midnight was converted to the previous UTC calendar
day. Only the new oracle changed to local calendar components; complete
row/date assertions remain. The affected OPEN rerun passed1 case with13
filtered exclusions. The earlier three passes were not rerun at that point.

Ten isolated predicate-removal faults each produced one matching new-case
failure and one passing existing unique-night control, with12 filtered
exclusions. These are ten executions of one unique control, not ten unique
controls. SQL/setup/type errors were not accepted as mutation evidence.

| Facet group | Actual matching oracle | Groups |
| --- | --- | --- |
| Assignment, rotation, filtered-name, open-record, overtime WHERE org | Native rows included one foreign row in each A/B arm before downstream rejection; empty arm stayed empty | 5 |
| Assignment/rule join, shift-by-ID org, ID/name segment correlation | Actual successfully executed SQL/binds lost the required predicate; legal result rows stayed unchanged | 5 |

The second row is predicate execution evidence, not five more data leaks.
Rotation/name downstream refusal cannot erase the raw native-row evidence.
Exact runtime bytes were restored between every fault. The final restored
selected run passed all three new cases plus the existing control:4 actual
passes, zero failures and10 filtered exclusions. This is not a local
whole14-file execution.

Removing only the additive nested describe reconstructs the original
whole11-case file exactly, including hooks and budgets. Current tested file
SHA256: `2e10a633069c447ccc71d1114a38131bce516aff914f23e89e4f2c42197337ff`.

## Quality and review

Explicit same-path/config lint baseline and candidate both exit1 with11
existing errors and zero warnings: introduced errors0, warnings0. This is
not a full-file lint0 claim. Previously successful same-base production
`validate:all` applies through14117 identical other tracked inputs and
the actual test exclusion; it was not rerun as fresh candidate quality.

Independent source review found no confirmed introduced P1/P2 in its
bounded source scope. The main agent independently inspected raw reporter
assertion statuses, receipts, log hashes and restoration evidence. Review
opinion is not an execution result.

Evidence retained outside tracked source: `native-baseline-state.json`,
`native-open-date-fixed-state.json`,
`native-ten-facet-mutations-state.json`,
`native-ten-facets-main-independent-audit.json`,
`explicit-test-lint-and-quality-state.json` and
`main-independent-local-final-audit.json`.

## Gates and remaining scope

| Gate | Current disposition |
| --- | --- |
| Three native cases and populated/empty controls | PASS in selected restored run |
| Ten isolated faults and exact restoration | PASS: five rowset plus five executed-carrier facets |
| Original11 cases/hooks/budgets | Original bytes preserved; not relabeled as locally rerun |
| Incremental diagnostics | PASS: zero introduced errors/warnings; existing11 remain |
| Production quality | Same-base result retained by identical inputs; not fresh rerun |
| Exact-head required CI / current whole14 and three new named cases | PENDING publication and terminal CI |
| Full MUT06 denominator, W2-04/W2-08, W7, EP01, parent/owner acceptance | OPEN |

Six carriers/ten facets are a finite increment. No authenticated HTTP,
producer reachability, approval-apply, live-provider, UAT or arbitrary SQL
equivalence proof is claimed. The whole-parent query denominator remains
open, including changed/nested/relocated queries and explicit disposition
of trusted-ID/global/zero-path exceptions. Three pending human semantic
choices are not inferred or ratified by this PR.

# CALC15 legacy envelope read-contract verification

Human-approved named read-only exception; Draft/HOLD over main
`5193da4c5667418a8bd9fa40a9a80021cdcac077`. The current response adds optional
literal `calculationMode: "envelope_legacy"` only for visible active,
active-reason, strictly pointer-null legacy_untracked projections. Original
four required current keys and independent posture remain. No SQL,
permissions, writers, migrations, data rewrite or calculator enablement.

## Actual local evidence

Tests ran on the uncommitted candidate over the base above, pinned
Node20.20.2/pnpm9.15.9. Post-commit binding must prove the same source bytes;
no test is relabeled as a post-commit rerun.

- Original runtime plus seven new unit cases:1 matching eligible-response
  red,6 actual negative controls passed,37 filtered exclusions. The receipt
  harness expected JSON to expand the diff; it did not. Main independently
  read the raw full diff showing only the missing literal. No red rerun.
- Affected whole unit44 and route3:47 actual passes, zero skip.
- Initial native whole11:11 executed passes. Independent review found the
  new tracked control reused a parent deliberately corrupted by an older
  test. That initial control is not accepted as legal tracked proof.
- Added native six-field parent/current-calculation consistency discriminator:
  actual1 matching red plus the old mutating-test control passed,9 excluded.
  Seeded a distinct legal tracked user/record/calculation using ordinary
  helpers and pointer guard. Same pair then passed2/2,9 excluded. Original
  eight test-call bodies and budgets remain exact; cleanup adds only its own
  fixture user. No runtime change was required.
- Three new native cases therefore qualify across phases, not a fresh final
  whole11: visible virgin legacy self/admin exact full response and zero
  calculation/segment children; retired review placeholder unlabeled;
  independent legal completed tracked record unlabeled. Parent, calculation
  and child row snapshots compare exactly before/after each qualifying read.
  HTTP tests reuse the existing fixture authentication/RBAC mocks and are
  not a new real-JWT authorization proof.
- Five isolated unit faults (omit literal, remove owner/pointer/visibility/
  reason guard) caused1/2/1/1/1 matching failures respectively; an actual
  existing admin-detail control passed in every group. Each group selected8
  cases with36 filtered exclusions. Exact runtime restored between faults;
  restored selected8 passed.
- Native literal omission:1 matching legacy-response red plus the independent
  legal tracked control passed,9 excluded. Exact runtime restored; affected
  legacy native case passed1,10 excluded. Filtered cases never count as pass.

## Contract and quality

Actual OpenAPI build, validation, generated SDK guard and production
`validate:all` all exit0. Parsed generated OpenAPI differs from baseline
only at the new optional current.calculationMode property. The old four keys
remain required, additionalProperties remains false and the enum has one
literal. Six actual generated-schema probes accept legacy literal/old shape
and reject wrong literal/null/extra key/missing original key; SDK optional
literal is bound.

Explicit same-path/config lint baseline=current2 existing errors/0warnings;
introduced0/0. Do not call this full-file lint0. Production quality preceded
the native-only fixture repair; all production/schema inputs remain exact
and actual tsconfig excludes tests. It was retained, not needlessly rerun.
The source-only review found one fixture P2; actual discriminator red and
independent-fixture green addressed it. Follow-up source review found no
confirmed new P1/P2. Opinion does not substitute for execution.

Raw reporters/log hashes, source inverses and receipts are retained in
`main-independent-local-final-audit.json` and referenced phase artifacts.
Own UTF8PG ledger458 reused without migration replay; every own cluster
finally stopped and data retained.

## Delivery gates

| Gate | Disposition |
| --- | --- |
| Explicit named read-only compatibility exception | Approved by human |
| Exact eligible/ineligible unit and existing routes | PASS;47 actual |
| Three new native row-preservation cases | PASS across qualified phases |
| Five eligibility faults plus one native omission fault | Matching red and exact restoration |
| Schema/SDK/quality | Actual exit0; only optional literal property |
| Explicit lint | Introduced0;2 baseline errors retained |
| Current-head required CI and whole final44/3/11 files | PENDING |
| CALC14/correction-target semantics and parent/owner/full product | OPEN |

No Ready/merge/deploy/R71/tag/release/business configuration/flags.
Stream/lifecycle and external writes OFF; realUAT/50004excluded; historical
08PUT INCONCLUSIVE. This current-projection label does not invent or classify
all historical calculations or fabricate segments.

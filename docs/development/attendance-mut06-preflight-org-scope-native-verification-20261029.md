# MUT06 organization-wide preflight query-scope verification

This test-only slice extends the existing legacy timezone repair native file under the advanced attendance design-lock section 7.4. It covers `inspectAttendanceTimezoneLegacyRepairV1` and its six SELECT definitions; it does not establish the full MUT06 query/newness denominator.

## Source

Base: `a03d804d60d83717feaedce099e5ff14216afc58`.

| Input | SHA256 |
| --- | --- |
| Runtime `attendance-timezone-legacy-repair.ts` | `b7974f50f848de1f1296b22f5294f408c003b7adea48b22ab3cbd6d4c4b81b16` |
| Original native file | `b9078571a19341329ffe6d250855d5ce8ef02f42e998b5df88d21b5a49cbfaf3` |
| Candidate native file | `7998f33d6b8d1011c367a1f7cb6763f33f9d8573e03ea2ec00485a9c34cefe1c` |
| Unchanged online-punch fixture | `0759eba1421ed3a0d1b4746b34feee50d546808afb3cbdc1efd8e9cf7ad2f855` |

The runtime, original native file and online-punch fixture also match composed source `285314d03a989f284f1647b713b3eb5258273e7a` byte for byte. The new cases were executed on the stated main base; source equality is not a second native execution.

Removing the new block and reversing only the added builtin `createHash` import recovers the entire original native file. All eighteen original helpers and test bodies remain byte-identical. The existing filename is already present in the integration run-list, no-DB exclusion and fixed corpus, so no registration/count change is required.

## New native cases

- `MUT06_PREFLIGHT_SCAN` seeds own and foreign organizations with legal records and pending requests for the same subject/date, plus foreign default rule, policy and rollout decoys. It checks the exact result and every count, actual record/request query predicates, read-only transaction boundaries and unchanged selected business rows.
- `MUT06_PREFLIGHT_ACTOR` pairs a persisted own-organization administrator with a persisted administrator belonging only to the foreign organization. The latter must be refused before either business scan; the own administrator remains a positive control.

The database adapter forwards real query text, parameters and PostgreSQL results without replacement. SQL hashes are logged without fixture values. The existing app fixture starts normally, but the inspector is called directly through its pool interface: this does not prove an HTTP preflight endpoint or full JWT admission.

The before/after snapshot covers selected records, requests, companions, events, rules, policies and rollout rows. It is not an all-possible-side-effects census.

## Actual execution and source faults

| Phase | Actual result | Filtered, not passed |
| --- | --- | ---: |
| Two new cases only | 2 passed | 18 |
| Administrator membership organization predicate | 1 matching failed leaf | 19 |
| Default-rule organization predicate | 1 matching failed leaf | 19 |
| Rollout organization predicate | 1 matching failed leaf | 19 |
| Timezone-policy organization predicate | 1 matching failed leaf | 19 |
| Record scan organization predicate | 1 matching failed leaf | 19 |
| Record companion same-organization JOIN | 1 matching failed leaf | 19 |
| Record calculation same-organization JOIN | 1 matching failed leaf | 19 |
| Pending-request organization predicate | 1 matching failed leaf | 19 |
| Request-to-record same-organization JOIN | 1 matching failed leaf | 19 |
| Request companion same-organization JOIN | 1 matching failed leaf | 19 |

There are **two distinct passing native cases** and **ten source-fault phases with ten matching failed leaf executions**, not ten additional unique cases. Seven faults change the observed behavior/counts or administrator refusal. Three companion/calculation JOIN faults are executed-predicate evidence; no illegal foreign companion/calculation insertion or row leak is claimed.

Each fault changes one source predicate and retains parameter arity. Actual SQL hashes match the corresponding baseline or single-query fault construction. Every source fault was restored exactly; all assertions, constraints and budgets remain intact.

The original eighteen cases were not rerun locally. Their existing whole-file CI receipt is retained separately. Current-head CI must independently establish the resulting whole twenty-case file.

## Real schema and retained receipts

The current own database reports 458 applied migrations and zero pending; no migration apply was run. Its real unique index is `(user_id, work_date, org_id)`, allowing the legal same-subject/date peers. A separate read-only inspection confirmed two validated companion FKs, three validated calculation FKs, replication role `origin` and zero disabled user triggers. This is not claimed as the same connection as every native query.

The first controller completed the two baseline cases and the actor fault. Its receipt checker then rejected the Promise failure summary because Vitest omitted the custom assertion message. The actual named case failed at the foreign-admin rejection assertion, and both control/foreign SQL receipts matched the mutant; the raw code frame retained the marker. Main-agent review qualified those existing results without changing source/assertions or rerunning either phase. A continuation executed only the remaining nine faults. Both owned PostgreSQL instances stopped successfully; data/history were retained.

Owned evidence: `artifacts/attendance-mut06-preflight-org-scope-native-20261029/`.

- `actual-native-and-mutation-execution-audit.json`: `d22bb36823b5c8f51ca7a2afb18d445035ded222c00bb9a4cf8348541c52fedc`.
- `native-actor-receipt-checker-main-disposition.json`: `502376a72e6d3a639ad8fc9bd3087ee330d7506e4506dda6772a61fa52a0e124`.
- `actual-own-schema-constraint-readback.json`: `17e6d29fa2f0b0978b6048d536865fc126b2b5b9c00f377c593e5a5739de0188`.

Raw assertion-result JSON, logs, baseline/fault sources, six-query construction hashes and restoration receipts are retained there. No independent reviewer was used; main-agent evidence review has zero independent-reviewer credit.

## Quality and reproduction

Explicit lint diagnostics are baseline 1/current 1; AST lint is 0/0. Focused native-file type diagnostics are 316/316 with zero introduced diagnostics. The imported existing fixture/core closure carries those baseline diagnostics; this is not a zero-diagnostic backend typecheck or a fresh `validate:all`.

```sh
pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts run \
  tests/integration/attendance-timezone-legacy-repair.db.test.ts \
  --watch=false --cache=false \
  --testNamePattern='MUT06_PREFLIGHT_(SCAN|ACTOR):'
```

Use an owned migrated test database through the existing fixture's database variables. The two cases use synthetic legacy rows; they do not establish public-writer creation, verified V1 worker/provenance, Redis/live transport, other preflight/query families or whole-product acceptance.

| Design-lock gate | Evidence | Boundary |
| --- | --- | --- |
| Section 7.4 organization scope and named failing legs | Six SELECTs, ten org facets, two native cases and ten matching source faults | Seven behavior legs; three executed-predicate JOIN legs |
| Preserve existing gates | Original eighteen-case bytes recovered; filename remains in existing CI registrations | Whole twenty-case current-head CI pending at publication |
| Production authorization | Draft/HOLD, switches OFF | No merge, deploy, R71, target migration or provider enablement |

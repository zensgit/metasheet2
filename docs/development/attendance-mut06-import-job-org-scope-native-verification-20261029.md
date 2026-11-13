# MUT06 native import-job organization scope verification

This test-only slice adds two cases to the existing CSV protocol gate. It addresses the organization predicates in `loadImportJob` and `loadImportJobByIdempotencyKey` under the existing advanced attendance design-lock, section 7.4. It does not close the full MUT06 query denominator or authorize release.

## Source and unchanged inputs

The published candidate starts from main `a03d804d60d83717feaedce099e5ff14216afc58`. The same added cases were also exercised on composed source `285314d03a989f284f1647b713b3eb5258273e7a`.

| Input | Main SHA256 | Composed SHA256 |
| --- | --- | --- |
| `plugins/plugin-attendance/index.cjs` | `09ceaf51b9088de51377610ee4a5e4f633e28b763b4dd131aa41d7eec72eacef` | `52ef58e2c4c6e435499fd5f3c36ea144aca742de516d8b334c020b0fd47707a3` |
| Existing CSV migration fixture | `692f87844ecb4756eabb463f560c6457876160138287560e3485a6bb020a4064` | `76650786649be8ba5bd1a93693ec1eb9bc56e1a5e1c17547d1142971a132a532` |
| Candidate CSV test | `b7fcaa1d891e3e9921ae1f411679160f6e560ddbeb1b2f9661b5721d80740b95` | same |

Removing the exact new block recovers the original test SHA256 `8a504cabcc2b192bfac1cdf00c5f2c491469c8ab73bdb11e560cc831bd2a34ce`: all original fifteen cases, helpers, provider refusal and final aggregate assertions retain their bytes. Runtime, migration fixture, schemas, dependencies, workflow, configuration and flags are unchanged. The composed copy and runtime fault sources were restored exactly.

The existing `plugin-tests.yml` CSV calendar step runs the existing `vitest.csv.config.ts`, whose include is this CSV file. No new file registration or suite-count change is needed.

## Cases and actual execution

- `MUT06_JOB_SCOPE_ID`: own job returns the exact DTO with 200; a legal job in another organization returns the exact 404 response. The synthetic user belongs to both organizations, so membership denial cannot substitute for the query scope.
- `MUT06_JOB_SCOPE_IDEMPOTENCY`: both organizations hold the same retry key, with the foreign row newer. Replay must return the exact own job and `idempotent: true`.

The tests seed legal queued legacy jobs with `w4_contract_version = NULL` using the unchanged schema. They compare selected job rows and counts/transitions before and after, including tokens, records, batches, items, reservations, processors, queue entries and events; provider IO remains forbidden. Fixture cleanup removes only the new rows and membership.

The actual registered plugin handlers run against PostgreSQL through the existing passthrough database adapter. Captured SQL is the SQL executed by that adapter. Request identity is synthetic `req.user`; this is not JWT or HTTP wire acceptance.

| Phase | Passed | Matching failed | Filtered/skipped |
| --- | ---: | ---: | ---: |
| Main, new cases only | 2 | 0 | 15 |
| Composed source, same new cases only | 2 | 0 | 15 |
| Composed: remove ID lookup organization predicate | 0 | 1 | 16 |
| Composed: remove retry lookup organization predicate | 0 | 1 | 16 |
| Composed: remove shared terminal same-organization JOIN | 0 | 2 | 15 |

There are **two distinct new cases**, four passing executions across the two source variants, and three source-fault phases with four matching failed leaf executions. Filtered/skipped cases are not passes. The original fifteen cases were not rerun locally; whole-file CI must independently establish all seventeen.

The first two faults retain SQL parameter arity and produce the named behavior failures `_FOREIGN_REFUSAL` and `_OWN_REPLAY`. The JOIN fault produces `_JOIN` failures on actual executed SQL. It proves the executed predicate; it does not demonstrate insertion or leakage of an illegal foreign terminal row. Schema and constraint definitions remain unchanged throughout.

## Reproduction and retained receipts

With the existing test database configured in an isolated own checkout:

```sh
pnpm --filter @metasheet/core-backend exec vitest \
  --config tests/attendance-import-timezone-protocol/vitest.csv.config.ts \
  run --watch=false --cache=false --reporter=verbose --reporter=json \
  --testNamePattern='MUT06_JOB_SCOPE_(ID:|IDEMPOTENCY:)'
```

The retained receipt directory is `artifacts/attendance-mut06-import-job-org-scope-native-20261029/`. Raw logs, actual assertion-result JSON, runtime/test pins and full query hashes are in `native-state.json`, `matching-source-fault-manifest.json` and `actual-native-and-mutation-execution-audit.json`. The latter SHA256 is `3e7aed47a4f0ed16be54a4253e822bd90014bc051a194c68b9d763ce58983a0d`. Fault source snapshots and exact restoration receipts are retained there. Own PostgreSQL was stopped successfully with data retained; the heavy slot is idle.

## Quality and limits

Explicit lint baseline/current diagnostics are 1/1; AST lint baseline/current are 1/1, with the existing `no-var-requires` diagnostic. Focused type diagnostics are 4/4. Introduced diagnostics are zero. These results do not claim zero lint/type diagnostics, a whole-backend typecheck or a fresh `validate:all`.

Preparation failures are retained: the first JSON parser rejected a pnpm output trailer; the first candidate type check found a new helper outside the old helper's scope. Only the new helper was corrected, before native execution. Candidate checks then passed against reused baseline diagnostics. A later read-only workflow search used a literal filename absent from the workflow command; searching its actual config name resolved the wiring. None of these harness attempts executed the original fifteen cases.

No Redis transport, verified V1 worker, whole IMP14 provenance, full inbound/provider census, full MUT06 parent completion or production acceptance is claimed. Existing production migration functions initialize the own test database; no target-server migration or installation occurred.

| Design-lock gate | Evidence | Boundary |
| --- | --- | --- |
| Section 7.4 organization scope | Two query behavior cases; three source faults with named failing legs | Bounded to these lookups and executed JOIN |
| Preserve existing guards and cases | Exact original fifteen-case bytes recovered | Whole seventeen-case CI pending at publication |
| Release/production authorization | Draft/HOLD, defaults OFF | No merge, deploy, R71, release or provider enablement |

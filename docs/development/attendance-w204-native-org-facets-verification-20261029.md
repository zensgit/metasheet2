# W2-04 native organization facets — verification (2026-10-29)

Refs #4556. Draft only. Base: `66a45e9a3b4817940fcaf91956efc1de3368b580`.

## Change and boundary

The existing W2 integration file gains three native PostgreSQL cases. A persisted whitespace rotation reference exercises the existing unfiltered lookup through `resolveEffectiveCalendar`. The observer captures actual query results after execution and does not depend on either organization predicate being present.

No runtime, migration, dependency, API, workflow, flag or business-configuration change. The original eleven test calls and budgets are byte-identical. This slice is separate from the earlier W2 ten-facet, W208 reader and W7R6 proofs; it does not complete the whole MUT06 ledger or authorize release.

## Actual local execution

| Phase | Actual passed | Actual failed | Filtered |
| --- | ---: | ---: | ---: |
| Three new cases plus existing org-scoped candidate neighbor | 4 | 0 | 10 |
| Outer organization condition neutralized, valid bind retained | 2 controls | 1 matching W204_OUTER | 11 |
| Nested segment organization condition removed | 2 controls | 1 matching W204_SEGMENT | 11 |
| Exact runtime restoration | 3 | 0 | 11 |

Counts come from Vitest 1.6.1 assertionResults.status, not its filtered-inclusive file header. There are three new unique cases and one existing neighbor; phases are not added into a unique-test total.

- W204_OUTER checks both organization directions, exact own identity, zero foreign raw rows and exact org binding. Its mutation failed specifically at W204_OUTER_ZERO_FOREIGN_ROWS.
- W204_SEGMENT checks the actual executed SQL predicate and exact own segment counts (one and two). Its mutation failed specifically at W204_SEGMENT_EXECUTED_ORG_PREDICATE.
- W204_INTEGRITY proves the composite FK rejects foreign organization segments with SQLSTATE 23503 and the exact constraint name, then verifies legal rows survive savepoint rollback. The nested-predicate proof is an executed-carrier assertion, not a claim that the FK permits foreign segment leakage.

The existing owned UTF8 database ledger was 458; migrations were not replayed. Fixtures were transaction-local and rolled back; the test-user residue check was zero. Only the owned PostgreSQL instance was started and stopped, and its data was retained. No HTTP, real-provider or production-acceptance claim is made.

Focused command from core-backend:
```sh
pnpm exec vitest run --config vitest.integration.config.ts \
  tests/integration/attendance-work-date-resolver-w2.db.test.ts \
  -t 'W204_|loads org-scoped published candidates only' \
  --reporter=verbose --reporter=json --outputFile=<evidence-file>
```

Mutation/restoration phases selected only `W204_`. No original suite was rerun wholesale.

## Quality and review

- Same-path/config explicit ESLint baseline and candidate each retain eleven existing diagnostics; introduced diagnostics: zero. This is not a claim that whole-file lint is clean.
- TypeScript AST: original eleven complete it-call texts identical; candidate fourteen calls; syntax diagnostics zero.
- `pnpm validate:all`: exit 0. Log SHA256: `33e0f223c3f9c27d6ca904b24b0006e2c054f969b30dd269101fde4a1c192103`.
- Independent source review: no confirmed P1/P2 within this bounded delta. Main separately verified candidate/reference pins, actual reports, matching negative assertions and restoration.
- A reporting-script typo (`String.index` instead of `indexOf`) interrupted the first AST receipt. The original script/log are retained. Only the corrected artifact check and previously unrun validate:all continued; passing native and lint phases were not repeated.

Test source SHA256: `ca3bdddb2fe0c16f4fd4ace0926eff248aecd3b7d11dac0f956e07a7236a78d6`.
Unchanged runtime SHA256: `09ceaf51b9088de51377610ee4a5e4f633e28b763b4dd131aa41d7eec72eacef`.

Private receipt names: native-validation-state.json, quality-state.json, quality-v2-state.json, quality-harness-repair-history.json, original-test-preservation.log, independent-source-review.json, main-independent-local-final-audit.json.

## Delivery gates

The existing file remains registered in plugin-tests.yml and test:integration:attendance. Current-head required CI and the actual whole fourteen-case execution remain pending at publication. Local 4 + restoration 3 is not whole-file fourteen passed. R77 target adaptation still requires the exact deployed R76 build.commit; this proof does not block that separate organization package. Owner/manual/live/frozen/remaining semantic decisions remain open. No merge, deployment, R71, release, configuration or provider writes.

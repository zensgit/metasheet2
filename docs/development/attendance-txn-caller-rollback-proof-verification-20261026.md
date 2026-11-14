# Gate E caller rollback proof verification — 2026-10-26

Status: test-only Draft/HOLD supplement on base 40ce1b47eab87b5fb4d7f69b3b8b9f7cfcdd003b. Runtime implementation and ownership semantics are unchanged.

## Requirement boundary

The current issue #4844 is OPEN. Its original cleanup-failure acceptance says the probe must not leave a savepoint defined or a transaction in an unexpected state. **This supplement does not prove or satisfy that unconditional requirement.** It demonstrates what the actual caller can recover after the existing typed refusal when both probe teardown statements were intentionally prevented from reaching PostgreSQL. No owner amendment is inferred.

The original 4b cases first RELEASE the leftover probe and then ROLLBACK. Their two titles and the shared helper explanation are corrected to describe that exact sequence. The original ten bodies, assertions, wrappers, namespace, setup and budgets remain behaviorally unchanged.

## Actual two-case proof

The new 4c case runs once for each existing boundary: operation registry and outbox dispatcher. Both use a real PostgreSQL client and a second connection for row visibility.

1. Caller begins a transaction and inserts its own namespaced probe row.
2. The existing teardown-failure wrapper rejects only ROLLBACK TO / RELEASE of the idle probe. The callee returns the product refusal, never enters its business callback or emits.
3. The second connection cannot see the row; the caller still sees it.
4. Two real caller ROLLBACK TO statements succeed. ROLLBACK TO retains the savepoint, so it is still defined immediately before full caller ROLLBACK. No caller RELEASE occurs in that interval.
5. Full caller ROLLBACK removes the uncommitted row. In a new transaction, RELEASE of the old probe fails 3B001; SELECT then fails 25P02; final caller ROLLBACK restores a usable connection.

Actual result: **2 passed, 10 filtered exclusions, exit 0**. This is not 12 passed, and the original green ten were not rerun locally.

The existing owned UTF8 synthetic database was reused after verifying the stopped cluster, free loopback port and schema. Migration ledger 458, pending 0; no migration replay. Scratch-table inventory was restored, and a separate read-only audit after the mutation found zero leftover probe tables. The owned cluster was stopped normally and data retained.

## Matching refutation

A temporary mutation added a callee ROLLBACK immediately after failed probe teardown. Both new cases failed at the exact caller-row assertion: expected one, observed zero. Results: **2 matching failures, 10 filtered exclusions, no actual passes**, mutation command exit 1. Original source was restored exactly; no mutation is committed.

The mutation controller's postcheck originally expected the abbreviated Vitest JSON failure message to contain the received row count. That detail exists only in the default reporter. The main audit matched both named cases, both raw expected1/received0 diffs and exact assertion locations against the original log/JSON hashes. The failed postcheck is retained; the negative suite was not rerun merely to repair its receipt.

## Commands and quality applicability

Use the existing disposable UTF8 schema with matching DATABASE_URL and ATTENDANCE_TEST_DATABASE_URL, original strict settings and the isolated empty environment directory:

```sh
pnpm --filter @metasheet/core-backend exec vitest run --config vitest.integration.config.ts tests/integration/attendance-gate-e-txn-ownership-batch1.db.test.ts -t '4c\. caller ROLLBACK' --reporter=default --reporter=json --outputFile=artifacts/two-caller-rollback.vitest.json
```

- Explicit non-ignored lint on original and candidate test: both exit 0, no introduced diagnostics.
- The existing file is already registered whole-file in required real-DB execution, no-DB exclusion and strict corpus; those files are byte-identical to base. No new path registration is required or removed.
- Root validation command remains validate:plugins, recursive lint and recursive type-check. Its production inputs are unchanged from the same-base successful W6-auth quality run (log SHA256 1801d4bdd774d70055006e997c5de78935d899615d7d648309bf553121d5eb5d). Effective TypeScript config parsing confirms this test is excluded from both backend production programs; the backend has no recursive lint script, so this test was explicitly linted.
- That quality evidence is carried by unchanged inputs, **not claimed as a fresh validation run of this candidate**. No already-green full suite, migration, build or quality run was repeated.
- Independent read-only source/evidence review found no confirmed new P1/P2 within this supplement. Main independently checked actual assertions, the raw negative diffs, restored runtime hashes and residue audit.
- Published-head required CI is pending and must be verified separately; the registered whole file must execute all twelve cases there before final CI evidence.

## Evidence and remaining gate

Local receipts under artifacts/attendance-txn-caller-rollback-proof-20261026/: source-plan.json, two-caller-validation-state.json, two-caller-rollback.vitest.json, caller-ownership-mutation-state.json (postcheck failure retained), mutation-main-independent-audit.json, quality-residue-audit-state.json and independent-review.json.

This proves caller recovery and protects ownership from an accidental callee rollback. It does not assert that a query-only helper can always clean up through a permanently failing transport, grant the callee permission to consume a caller transaction, or accept residual savepoints as meeting the original issue. Original unconditional cleanup and owner/lane disposition remain unclosed.

All PRs Draft/HOLD; no merge, deployment, R71/tag/release, business configuration or flag change. Stream/lifecycle OFF. Real UAT and business50004 excluded. Historical08PUT remains INCONCLUSIVE; human/owner/manual/live acceptance is separate.

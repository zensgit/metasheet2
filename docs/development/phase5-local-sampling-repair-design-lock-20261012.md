# Phase5 local sampling repair

Owner authorized local implementation, tests and independent review on 2026-10-12. Staging remains conditional on explicit review approval. This slice repairs the existing Phase5 producer; it does not establish the cause of the latest external scheduled failure or complete Time Machine acceptance.

Base: `58f4842e0be56c6bf25de06bff47105ccf2892a4`.

## Contract

- Mandatory startup, producer, validation and report failures return nonzero. Optional warm-up probes cannot override a mandatory failure. Reports belong to the current run; stale or fabricated reports cannot produce PASS.
- The runner uses its intended local endpoint, refuses an occupied port and cleans up only the process group it starts, on success, failure and interruption.
- Before sending population writes, verify that the actual listener belongs to the owned backend process group. Plugin reload uses the protected endpoint and its one-use SafetyGuard challenge/retry with the same actor and plugin, not the legacy unsafe endpoint or token-trust bypass.
- Snapshot sampling requires a separately provisioned dedicated test database and test admin. A loopback address or database name alone is not proof of disposable infrastructure. Live database provisioning and target qualification remain separate gates.
- The fixture lifecycle creates a fresh synthetic UUID view with no table, records its ownership and checks the API view against that fixture before creating a snapshot. The created snapshot and exactly one view item must match the fixture in the same database before restoration.
- Restore only that view using `partial` and `item_types: [view]`. The initial request must receive the actual SafetyGuard challenge; confirm with the same actor, then retry the same resource and body using the issued token. `confirm_full` is not a substitute for a safety token. Do not disable the guard.
- Require successful HTTP status, current `ok/data` response shape, `data.success === true` and `itemsRestored === 1`. Metric presence alone is not operation success. Never manufacture samples with direct metric observations.
- The restore path accepts the PostgreSQL driver's decoded JSONB object as well as the existing serialized object representation. A regression must assert the actual view update and restored count; do not broaden unrelated snapshot readers in this slice.
- Cleanup is identity-bound to this run's synthetic resources; failure remains visible. Evidence contains stages, codes and counts, not credentials, response bodies or resource values.

## Local gates

| Gate | Required evidence |
| --- | --- |
| Regression | Old runner/producer failures reproduced by tests |
| Snapshot contract | Happy path and invalid target, response, confirmation, scope and cleanup negatives with mocked transport/database |
| Runner contract | Mandatory failure propagation, stale report rejection, occupied port refusal and owned process cleanup |
| Required test entry | New Node suites execute through the required backend test chain, with no skipped cases |
| Neighbors | Existing Phase5 sample/cache tests and snapshot authorization/safety/scope tests remain green |
| Guard sensitivity | Selected guard mutations make their tests fail, then restored source passes |
| Independent review | Astra safety review, Grok process/exit review, Kimi contract counterexamples, root source/test verification |

Local mocked gates do not qualify real PostgreSQL fixture provisioning, actual metric deltas, external producer identity, same-archive recovery, APFS, or staging. Those results must be reported separately. No production/customer data, merge, deployment or TM enablement is part of this slice.

Fixture teardown removes only the generated view and its owned snapshots/items. Restore/audit logs remain as evidence. An interrupted request can have an indeterminate server-side outcome; real database cancellation and reconciliation are part of the deferred live qualification, not proven by command shims.

## Verification on 2026-10-12

| Gate | Result |
| --- | --- |
| Baseline reproduction | Both old scripts returned zero on mandatory failure; neither reproduction timed out |
| Backend contracts and neighbors | 6 Vitest files, 51 tests passed; includes both Node contract suites, with zero skips/TODOs required by the wrapper |
| Phase5 sample/cache neighbors | 6 Node tests passed, zero skipped/TODO |
| Guard sensitivity | Six initial script guard mutations and the JSONB object guard mutation failed their selected regressions; repeated-signal cleanup and integer-count regressions also failed before their fixes and passed afterward |
| Repository quality | `pnpm validate:all`, shell/Node syntax, workflow actionlint and whitespace checks passed |
| Independent review | Sol6.1 high implementation; Luna medium CI/test wiring; Astra xhigh approved local contracts; Kimi K3 supplied contract counterexamples; root reviewed source and final results |
| Grok review | Grok 4.7 xhigh identified repeated-signal cleanup and fractional-count gaps; both received red/green regressions and fixes. The arbitrary replacement-helper example did not reproduce the actual wrapper's exec-to-Node and bounded curl lifecycle |
| Real database and sampling | Not run; provenance, cancellation/reconciliation and actual metric deltas remain unqualified |
| Latest scheduled failure | External producer identity and runtime evidence still required; this patch does not establish that incident's cause |
| Native recovery and staging | Not run; awaiting explicit review approval under existing owner authorization |

Commands:

```sh
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/phase5-ops-node-contracts.test.ts tests/unit/snapshot-restore-jsonb.test.ts tests/unit/snapshots-authz.test.ts tests/unit/snapshots-safety-guard.test.ts tests/unit/snapshot-restore-invariant.test.ts tests/unit/safety-guard-confirm-flow.test.ts
node --test scripts/ops/phase5-required-samples-contract.test.mjs scripts/ops/phase5-cache-hit-rate-contract.test.mjs
pnpm validate:all
bash -n scripts/phase5-ci-run.sh scripts/phase5-populate-snapshots.sh
node --check scripts/ops/phase5-snapshot-fixture.mjs
actionlint .github/workflows/phase5-slo-validation.yml
git diff --check
```

The manual Phase5 workflow now exposes missing prerequisites as failure. It does not provision a database, mint credentials, or become green without a separately qualified fixture. Mocked SQL/process contracts cannot detect every PostgreSQL constraint, cancellation, process-platform or real plugin activation failure. These remain live qualification gates; no threshold or missing-sample gate was relaxed.

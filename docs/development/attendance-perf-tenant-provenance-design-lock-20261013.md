# Attendance performance consumer tenant and source gate — 2026-10-13

Authorized narrow slice; baseline `625d18ae47671d0010c0b8cb1629ac4cd427df17`.

## Scope and contract

- Only the performance consumer, a minimal sibling helper/test, existing Node ops CI command wiring, and the three performance workflow binding fields change. No runtime, variables, triggers, credentials, public writes, commit, or parent audit artifacts.
- Legacy local calls with all three binding selectors absent (`AUTH_EXPECTED_TENANT_ID`, `ATTENDANCE_SYNTHETIC_ORG_ID`, `ATTENDANCE_EXPECTED_DEPLOY_SHA`) retain unbound behavior. Presence of any selector, including an empty value, selects bound acceptance. Bound acceptance requires explicit nonblank synthetic org, identical explicit `ORG_ID` and expected tenant, and a lowercase full 40-character expected deployment SHA. Partial binding cannot downgrade to compatibility.
- Existing performance workflows historically bind org/tenant without a deployment SHA. This slice deliberately upgrades all three to full binding by adding the existing synthetic-org and expected-deployment-SHA fields (empty defaults remain errors). It does not invent a deployment SHA from checkout or change repository variables.
- Reuse acceptance preflight configuration, exact HTTP 200 `/auth/me` tenant proof, and `/api/health` `ok: true` / `build.commit` proof. Deployment identity must equal the explicit expected SHA. `checkoutSha` is independently read from Git at the consumer's own repository root, never caller cwd or an environment override; checkout and deployment need not equal.
- Validate configuration and both identities before performance requests. Recheck effective token and runtime before each authenticated consumer request attempt, including upload, prepare, preview, commit, rollback, retry, polling and idempotency recovery. Verify refresh candidates before adoption. A rejected gate is terminal through retry/refresh/recovery catches and emits only fixed `ACCEPTANCE_*` codes. Bound transport rejects redirects; source/tenant proof transport failures are fail-closed.
- Add verified provenance to successful bound performance summaries. Existing unbound summaries retain their shape. No unrelated values-free logging rewrite.

## Verification gates

| Gate | Required evidence |
| --- | --- |
| Reproduction | Actual consumer child process against local synthetic HTTP server reaches mutations under wrong tenant / missing or mismatched runtime before fix |
| Negative boundary | Wrong/missing/malformed tenant, partial/blank config, refresh identity drift, source drift/missing/malformed SHA, proof redirect/network failures block the next mutation with fixed errors |
| Positive control | Actual script completes preview + sync/async commit + rollback on HTTP mock; explicit provenance records real consumer checkout |
| Lifecycle | Retry, refresh, async poll and idempotency recovery exercise the same gate; terminal errors are not swallowed |
| CI union | Append tests to the existing Node ops command, preserve every previous command; workflow config missing SHA cannot downgrade |
| Mutation | Temporarily neuter tenant/source/candidate or request barrier, observe focused negatives fail, restore only this slice's bytes and rerun green |

Parent owns Mac runtime, heavy `validate:all`, review and final commit. Local mock success is not deployed-runtime or production acceptance.

## Local evidence and limits

- Before implementation, real child-process HTTP tests for wrong tenant, mismatched runtime SHA and missing runtime SHA each returned `exit=0; performance mutations=5; summaries=1`. The mutation sequence was prepare, preview, prepare, commit, rollback. The initial full test run had 8 failures, including missing provenance on the positive control.
- After restoration of all mutations, the actual CI command below passed `tests 93 / pass 93 / fail 0 / skipped 0` on Node `v24.14.1`. The new suite accounts for 55 tests. The existing Node 20 CI lane keeps its prior command prefix and its window-runner/production-flow commands unchanged.

```sh
node --test scripts/ops/attendance-import-scope.test.mjs scripts/ops/attendance-history-reconcile.test.mjs scripts/ops/attendance-acceptance-preflight.test.mjs scripts/ops/attendance-import-perf-payload.test.mjs scripts/ops/attendance-import-perf-gate.test.mjs
node --test scripts/ops/attendance-import-perf-longrun-workflow-contract.test.mjs scripts/ops/attendance-run-perf-highscale.test.mjs
git diff --check
```

- Neighbor perf suites: `tests 6 / pass 6 / fail 0 / skipped 0`; diff check passed. The locale lifecycle neighbor could not load because this owned checkout has no `@playwright/test` package (`ERR_MODULE_NOT_FOUND`). No dependency install or lockfile change was made.
- Five independent, one-at-a-time mutations each produced `tests 1 / pass 0 / fail 1`, with assertion failures: remove tenant proof; remove runtime proof; remove per-attempt barrier; swallow the refresh gate error; keep stale retry Authorization. Tenant/runtime/refresh mutations resumed all five mutations and wrote success summaries. Each mutation restored only the original bytes of this slice's own helper/consumer, verified by SHA-256, before the final green run.
- Async recovery tests use a child-only `Date.now` clock and a 60-second configured poll timeout to reach the real idempotency recovery POST without waiting a minute. The positive control asserts two commit-async POSTs with the same key and no commit token on recovery; the negative control stops that second POST.
- Bound initial tokens must already pass `/auth/me`; an expired/unverifiable initial token is terminal before the proactive refresh. The existing upstream auth resolver remains responsible for obtaining a usable initial token. Successful refresh candidates and every retried authenticated request are reverified; retry Authorization uses the current verified token.
- Gate errors are fixed: `ACCEPTANCE_SYNTHETIC_ORG_REQUIRED`, `ACCEPTANCE_ORG_MISMATCH`, `ACCEPTANCE_EXPECTED_SHA_REQUIRED`, `ACCEPTANCE_API_BASE_INVALID`, `ACCEPTANCE_CHECKOUT_SHA_INVALID`, `ACCEPTANCE_TENANT_UNVERIFIED`, `ACCEPTANCE_RUNTIME_IDENTITY_UNAVAILABLE`, `ACCEPTANCE_DEPLOYMENT_MISMATCH`.
- Each bound request adds tenant and health reads. Existing wall-clock performance timers include this overhead; thresholds were not changed. Proof and mutation are sequential HTTP calls, not an atomic server operation. A late identity failure can leave an earlier synthetic batch in place because unchecked rollback is also prohibited. `checkoutSha` identifies Git HEAD, not a hash of dirty working files. No remote runtime, GitHub CI run, heavy validation, commit or public write was performed.

# Attendance import scope follow-up: verification

Status: post-review read-boundary correction under local verification. This document does not assert exact-head GitHub merge readiness or staging acceptance.

Base: `1c22d3b328f377dface03b222bf57d09f4b7dec0`.

Publication catch-up base: `9fb29831c33abba5eac1a5d64adbe62d915676c2`. The results below describe pre-publication local verification. New PR-head checks, independent review, merge/image/runtime identities and staging acceptance will be reported separately, not inferred from this table.

## Local evidence

| Check | Result |
| --- | --- |
| Three focused frontend specs | 66/66 PASS after rollback/session review corrections |
| Frontend on-disk mutations | 8/8 RED, source SHA-256 restored |
| Application TypeScript (`tsconfig.app.json`) | PASS |
| Full `vue-tsc -b` | FAIL: local Vite 5/7 config type incompatibility; same failure reproduced on clean base |
| OpenAPI build and guard | PASS after linking the existing local SDK dependencies |
| Domain attendance web-guard command | Earlier full run: 67 files / 1348 tests PASS; later rollback delta covered by the three focused specs |
| Required web script | Final post-review rerun PASS: 19 batches / 8548 test executions (not a deduplicated test count); final batch 455 files / 6627 tests |
| Ops contract regressions | 47/47 PASS across strict, override-confirm, import-perf-payload and acceptance-preflight suites |
| Ops on-disk mutations | 9/9 RED, source SHA-256 restored |
| Local Chromium request-panel fixture | PASS: real helper opens hidden/collapsed details, fills date, preserves already-open state; not product E2E |
| Historical local review | Earlier Sol source/test review excluded docs; its nonblocking verdict is superseded by the publication review below |
| Publication review at `97de651662e09b837594b40d3dfa786ccdbc8e5e` | CHANGES REQUESTED; read-boundary authorization and runner scope/cleanup required correction |
| CI at the publication head | Attendance guard 67 files / 1351 tests plus 6 browser cases PASS; required web final batch 455 files / 6627 tests PASS; these results do not transfer to the backend correction |
| New staging/product-browser/real-database acceptance | NOT RUN |

The initial async test used an incorrect option name and did not reach the intended lane. It was corrected to the actual `thresholds` option before positive verification and on-disk mutation. That initial failure is not counted as reproduction of the polling defect.

The final required-web run started before a comment-only correction from "both specs" to "these specs" in its shell script. Its executable command list is unchanged. Application typecheck was also rerun after the rollback review corrections and passed. The full build-mode typecheck limitation above remains disclosed rather than relabeled as success.

Delegation: Grok 4.6 was assigned the bounded ops slice but produced no edits during its session; it was stopped and the parent implemented that slice. Sol performed independent source review and local reruns. No additional model fan-out was used. All delegated sessions and the temporary clean-base typecheck worktree were closed; the delivery worktree and local evidence remain.

## Executed mutations

### Read-boundary follow-up

The registered plugin-handler suite plus import permission, identity, UUID validation and fixed-schedule neighbors passed 206/206 locally. The new suite contributes 50 cases across the five readers, with no PostgreSQL dependency. Each reader's identity resolver was independently replaced on disk by the old organization selection; every run failed 9 cases and passed 41. The restored plugin SHA-256 was `89f70a83d5fb1e49f70e9db951605b44afaf0dc0bf12620b59fb447d795d5b28`. No guard mutation remains applied. These controls prove the handler boundary with query doubles, not real-DB or shared-staging acceptance.

The existing malformed-UUID positive-auth fixture now supplies its authenticated tenant so it reaches UUID validation; its 400/body/no-query expectations were retained. Missing-tenant refusal has dedicated new cases. Backend unit discovery already includes this new non-DB suite; no workflow or provenance pin was edited for it.

### Earlier caller corrections

Each mutation edits one implementation site, runs its named regression, requires an assertion failure, restores the full file, then verifies SHA-256. No mutation is left applied.

| Mutation | Matching regression |
| --- | --- |
| Remove query scope from live-shell polling | Live async preview/commit |
| Remove query scope from composable polling | Composable async preview/commit |
| Drop scope retention on old live job response | Live refresh/resume |
| Drop scope retention on old composable job response | Composable refresh/resume |
| Remove organization from batch item GET | Batch read/export/rollback flow |
| Remove organization from CSV export | Batch read/export/rollback flow |
| Neuter rollback session match guard | Mismatched, absent and expired session refusal |
| Read mutable list org on each fallback page | List switch during paginated export |

Ops mutations remove scope from smoke/perf polling, smoke items, perf detail/export and strict items; remove the strict panel expansion; bypass the session-match predicate; and bypass perf's immediate pre-rollback session check. Each produces an assertion failure in the existing strict contract suite before restoration.

The first rollback-body mutation proved only an incorrect client mock. It is superseded and not counted in the final eight-mutation result. Independent review established that the real backend ignores rollback body/query organization; the final regression models its session-only contract.

The committed regression specs are durable; the temporary mutation driver and raw logs are local artifacts under `artifacts/import-scope-followup/`, not a newly installed CI mutation job.

## Reproduction commands

```sh
pnpm --filter @metasheet/web exec vitest run tests/useAttendanceAdminImportBatches.spec.ts tests/useAttendanceAdminImportWorkflow.spec.ts tests/attendance-import-preview-regression.spec.ts --reporter=dot
pnpm --filter @metasheet/web exec vue-tsc --noEmit -p tsconfig.app.json --incremental false --pretty false
pnpm openapi:build
pnpm openapi:guard
node --test scripts/ops/attendance-strict-import-advanced-contract.test.mjs scripts/ops/attendance-import-override-confirm-contract.test.mjs scripts/ops/attendance-import-perf-payload.test.mjs scripts/ops/attendance-acceptance-preflight.test.mjs
NODE_OPTIONS=--max-old-space-size=8192 bash apps/web/scripts/run-required-web-tests.sh
```

The domain suite command is read from the YAML step named `Run attendance web guard specs (targeted)` and executed locally without its relevance condition. Local execution is not an exact-head GitHub green result.

## Design gates

| Gate | Evidence / boundary |
| --- | --- |
| Preserve requested job/batch organization | Live-shell and extracted-workflow tests; pagination/export scope mutations |
| Bind import reads to authenticated tenancy | Five readers use the existing identity resolver; new registered-handler suite and five independent on-disk mutations; rollback stays session-scoped |
| Reject mismatched rollback session | Positive same-org control plus missing/mismatched/expired negatives, no automatic redirect |
| Interact with reachable controls | Strict helper function tests and local Chromium details fixture; staging still required |
| Durable frontend test execution | Three specs appear in attendance-web-guard and the explicit required-web batch |
| Remote acceptance | Not claimed; separate exact-SHA CI, publication, deployment and synthetic retest remain |

## Remaining acceptance

The earlier deployed candidate passed security 7/7 and Chinese locale, but failed strict/import. Those historical results are not transferred to this unmerged patch. After separate authorization: restore public DNS, publish/deploy an exact reviewed SHA, verify migration alignment and OFF posture, then rerun security, strict twice, locale, import/export/business rollback and synthetic cleanup. Retained append-only evidence must be reported separately from mutable residue.

The historical security runner did not cover these five import readers. Its strict configuration also enabled a global settings write, outside a synthetic-organization-only scope, and its cleanup skipped ambiguous seed acknowledgements. That runner must not be reused unchanged. A scoped run excluding global settings is not full strict acceptance; any excluded global case remains BLOCKED unless verified in a separately isolated environment.

No deployment, rollout/shadow enablement, real tenant data use, production traffic expansion or #4556 closure occurred in this work.

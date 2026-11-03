# Attendance Import Token Organization Binding - Verification - 2026-09-12

## Local Evidence

Implementation base: `53ba819366f8e2b2a7dc2612ed18a8eefeb2ce53`.
The following results were obtained from the local repair diff before its PR.
They do not establish GitHub checks or acceptance of a subsequently deployed
image. Those results are recorded separately against the PR and workflow runs.

| Check | Result |
| --- | --- |
| Live attendance import preview regression | 18/18 PASS |
| Extracted import workflow | 27/27 PASS |
| Ops verifier contracts | 28/28 PASS |
| Required web script | Exit 0; dedicated import batch 45/45, final batch 455 files / 6627 tests |
| OpenAPI build, guard, validation, import contract | PASS |
| Ops script syntax and diff whitespace | PASS |
| Independent Grok 4.6 review plus final delta | No P1/P2 in reviewed local diff |
| Local web type-check | Inconclusive: shared dependency links resolve incompatible Vite versions in unchanged vite.config.ts; requires clean CI |

## Discriminating Controls

- Live UI: a non-default tenant is sent to both prepare and preview, and the
  preview carries the returned token. Replacing the prepare body with `{}`
  made the new test fail; restoring it passed.
- Extracted workflow: payload organization differs from the selector. Prepare
  and preview must use the payload organization. Reverting prepare to the
  selector made the test fail; restoring it passed.
- Ops scripts: deleting organization from one prepare call made its contract
  test fail. Restoration returned the suite to green.

The ops checks inspect current source call sites; they are not a substitute for
running the import pipeline against PostgreSQL on the deployed candidate.

## Commands

```sh
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/attendance-import-preview-regression.spec.ts \
  tests/useAttendanceAdminImportWorkflow.spec.ts
node --test scripts/ops/attendance-verifier-contract.test.mjs
bash apps/web/scripts/run-required-web-tests.sh
node --check scripts/ops/attendance-smoke-api.mjs
node --check scripts/ops/attendance-import-perf.mjs
pnpm openapi:build
pnpm openapi:guard
pnpm --filter @metasheet/openapi validate
node scripts/ops/attendance-validate-openapi-import-contract.mjs
git diff --check
```

## Staging Evidence Before the Fix

- Migration run `34676188836`: applied 402, pending 0.
- Deploy run `34676412330`: product SHA
  `578e0d313aca4c5c7f66307e784feab17cdf62eb`.
- QA run `34678668234`: organization-isolation security probes 7/7 PASS;
  Chinese locale PASS; strict API/production-flow legs FAIL; import preview
  FAIL with `COMMIT_TOKEN_INVALID`.
- Cleanup removed mutable synthetic fixtures and uploads; append-only audit
  and target-revision evidence was retained. Rollout/shadow flags remained OFF.

## Release Validation

Pending at authoring: required GitHub checks on the submitted commit, merge,
exact image publication and staging deployment, then security/strict/locale/
import replay. Only the replay can establish whether the observed staging
failure is closed and reveal later failures previously masked by token rejection.

## Residuals

The backend still permits prepare without `orgId` and defaults it as before.
External callers can therefore reproduce the mismatch by omitting organization
on prepare but supplying it later. The live UI regression covers preview; the
same preparation helper is used by commit and async paths. Commit, retries,
upload and rollback require staging replay before acceptance.

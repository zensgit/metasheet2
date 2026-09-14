# Attendance QA Report Fixes - Verification Record - 2026-09-12

## Verdict

PASS for local implementation and synthetic-fixture verification at authorized
base `02ca7b1ef5145b84760f4a5471b3e0a4f7ca1300`.

This is not a merge, deployment, authenticated staging test, or product
acceptance verdict. Fresh exact-head CI is still required after a PR head
exists.

## Verification Matrix

| Area | Result | Evidence |
| --- | --- | --- |
| Focused frontend behavior | PASS | 3 files, 122 tests |
| Admin timestamp preservation | PASS | full admin file 144/144; selected auto-shift run test reproduced `--` before the fix and rendered the prior browser-local value after it |
| Mixed historical timezone handling | PASS | a valid-timezone row plus a missing-timezone row reproduced cross-row borrowing before the fix; the missing row now renders unavailable without loading `/rules/me` |
| Required web gate | PASS | full script exit 0; dedicated punch leg 27/27; final curated batch 455 files, 6626 tests |
| Web TypeScript | PASS | `pnpm --filter @metasheet/web type-check` |
| Assignment route contract | PASS | 87 tests |
| Workday-context integration | PASS | 1 selected test passed against PostgreSQL for records and anomalies after a shift timezone change; reverting to current-rule timezone made the same test fail; 165 unrelated tests skipped by selection |
| Runner source and mutation gate | PASS | 153/153 |
| Attendance DML inventory | PASS | 60/60 |
| Plugin manifests | PASS | 13 valid, 0 invalid; 9 pre-existing warnings |
| Diff hygiene | PASS | `git diff --check` |
| Public test-machine health | PASS with version caveat | root and `/api/health` returned HTTP 200; 13/13 plugins active; DB pool waiting=0 |
| Test-machine build identity | NOT CURRENT | health reported `c02fef470271c2fbd6cd829d38a2bea1991875b9`, not this branch/base |
| Authenticated test-machine scenarios | NOT RUN | source archive exposed plaintext credentials; they were not used |

## Focused Commands

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/attendance-punch-outcome.spec.ts \
  tests/attendance-selfservice-dashboard.spec.ts \
  tests/attendanceEmployeeWorkspacePresentation.spec.ts

bash apps/web/scripts/run-required-web-tests.sh
pnpm --filter @metasheet/web type-check

pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-uuid-validation-routes.test.ts

DATABASE_URL=<isolated-postgres-url> \
pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts run \
  tests/integration/attendance-plugin.test.ts \
  -t 'exposes persisted-timezone workday context'

bash -n scripts/ops/attendance-staging-window-runner-remote.sh
node --test scripts/ops/attendance-window-runner-pipeline.test.mjs
node --test scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs
pnpm validate:plugins
git diff --check
```

## Adversarial Controls

The runner contract was mutation-checked so each of these changes independently
turns the suite red:

- remove the synthetic `attendance:read` grant;
- change scheduler scope from `view`;
- use raw MD5 UUIDs without RFC version/variant bits;
- move manual assignments into the soak window;
- allow a one-user synthetic family.

The timezone boundary was also mutation-checked in both layers:

- a report containing one valid-timezone row and one missing-timezone row must
  not lend the valid timezone to the missing row;
- replacing the persisted record timezone with the currently resolved shift
  timezone makes the PostgreSQL records/anomalies test fail after the shift is
  changed from `UTC` to `Asia/Shanghai`.

The workflow validation also executes its real embedded shell block and rejects
`users_per_org=1` before any SSH step, while the two-user positive control
passes. This keeps the workflow and remote runner on the same lower bound.

The existing runner mutations also remained green in their expected
neuter-to-red form.

## PostgreSQL Seed Rehearsal

The generated seed SQL was executed twice against a fresh, fully migrated
PostgreSQL 15 scratch database. The second run was stable and did not accumulate
fixtures.

Observed closed-family counts after the second run:

| Fact | Count |
| --- | ---: |
| Synthetic users | 3 |
| Users with `attendance:read` | 3 |
| Manual swap assignments | 2 |
| Distinct manual assignment dates | 1 |
| Manual assignments shaped as RFC 4122 v4 UUIDs | 2 |
| View scopes | 3 |
| View scopes shaped as RFC 4122 v4 UUIDs | 3 |

The scratch database contains no production or customer data and is removed
after final verification.

## Test-Machine Observation

Unauthenticated, read-only probes on 2026-09-12 showed:

- test-machine root -> HTTP 200 and redirects/renders the
  MetaSheet sign-in page;
- `/api/health` -> status OK, 13 active plugins, 0 failed plugins, DB pool
  `total=2`, `idle=2`, `waiting=0`;
- reported build commit ->
  `c02fef470271c2fbd6cd829d38a2bea1991875b9`.

That commit predates this work. The observation proves availability only; it
does not verify the fixes in this change.

## Sanitized QA Artifact

- Original archive SHA-256:
  `f616ab4a5c51529c357e346df44be05bf9c75a4785ebddc488d48f395545b515`
- Sanitized local copy:
  `metasheet-attendance-qa-pack-2026-09-12-sanitized.tar.gz`
- Sanitized copy SHA-256:
  `513f3abf5948637092b81d0008a236fea1abc6a41850d304210db88d989ec3a4`
- Eight sensitive lines were replaced. The original archive was not modified.

## Remaining Gates

- Push a Draft PR and run fresh required checks on its exact head.
- Deploy that exact merged SHA to the test machine before repeating the report
  scenarios.
- Use newly provisioned or rotated synthetic credentials through the approved
  channel; do not reuse credentials from the source archive.
- Re-run completed-pair, rule-timezone, reports, leave, overtime, and shift-swap
  scenarios with an isolated organization and synthetic data.

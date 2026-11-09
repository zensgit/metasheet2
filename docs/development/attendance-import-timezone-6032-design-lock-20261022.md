# Attendance non-CSV import calendar correction (#6032)

Base: `4c78e75a0d1a96743c0b5b0ee9c8e8f059e99e3d`.
Branch: `codex/dingtalk-import-timezone-20261022`. R71 candidate; keep the PR Draft until separately approved.
Scope: entries/DingTalk column/JSON dates and offset-aware punch parsing.
Draft #6014 remains independent; no cherry-pick or CSV/absence/report changes.
No OAuth/help edits, feature-switch changes, deployment, real tenant IO or UAT.

## Contract

- Offset-bearing ISO and 10/13-digit epoch work dates denote instants. Preserve
  the raw source until normalization, before authorization/day keys and storage.
- Calendar selection reads the existing rotation/assignment sources only: rotation
  shift, published assigned shift, then explicit/group rule-set override or organization
  default. It does not execute calculation admission on candidate dates. The selected
  date still runs the unchanged `resolveWorkContext` calculation gate after scope
  authorization. Resolve subjects through the same
  organization-scoped import identity reader as the plan, including aliases,
  field userMap and authenticated fallback semantics.
- Examine UTC day +/-1. A candidate must map the instant to its own date in its
  effective zone. One published candidate beats an unscheduled rule-calendar
  alternative. Multiple/no candidates produce fixed 422
  `IMPORT_CALENDAR_DATE_UNRESOLVED` after request scope authorization.
- On an unresolved calendar, `scopeRows` carries every viable candidate date to
  the existing guard. Preview, commit and legacy import must return the complete
  existing 403 `SCHEDULER_SCOPE_FORBIDDEN` body for an invisible subject, before
  exposing 422. An authorized actor still receives 422 at each actual route.
  The provisional normalized rows cannot reach a writer while calendarError exists.
- Provider sync uses the same payload/user-map options in normalization and
  planning. Direct row.userId retains the existing precedence over userMap;
  canonical IDs and org-scoped aliases must select the same subject and timezone
  for normalization and persistence. This global-import wrapper does not need
  the scoped request error-deferral path.
- Date-only literals, naive/time-only punches and overnight rollover retain
  their existing meanings. Z/numeric-offset punches retain exact milliseconds,
  including additional punch-pair metadata. Coalesce entries/DingTalk by local
  day, first value wins; preserve JSON duplicate detection. CSV is unchanged.

## Verified gates

All current logs/results below are under `artifacts/6032/`.

| Gate | Result and evidence |
| --- | --- |
| Original A/B/C reproduction | `red-preview.log`: 6 failed / 2 passed, exit 1 |
| Published-source reproduction | `red-protocol-published.log`: 2 date assertion failures / 3 passes with real PG, exit 1 |
| Scope-order reproduction | `review-red.log`: real RBAC expected 403, received 422; the separate provider missing-table fixture error is NOT business-red evidence |
| Full final CI entry | `green-ci-protocol-final.log`, `protocol-result.json`: 12 passed / 0 skipped, exit 0 |
| Full protocol accounting | `protocol-counts.json`: 6 records, 15 batches, 15 items, 0 tokens, 0 jobs, 15 real core-host calls, 0 forbidden IO calls |
| Final focused neighbors | `green-final-review-neighbors.log`: 5 files / 302 passed, exit 0 |
| Process timezone | `green-process-zone-review.log`: 26 passed under America/New_York, exit 0 |
| New denial-order mutation | `mutation-denial-order.log`, `mutation-denial-order-result.json`: restore early throw -> named real-RBAC full 403 assertion receives 422, exit 1; restored and final protocol green |
| Final parser/calendar mutations | `final-main-mutations/result.json`: all four guards independently removed on the final source, each produced named assertion failures; restored source hashes match; restored unit suite 26/26 passed |
| Actual default unit glob | `unit-glob-proof.json`: Vitest globTestFiles collected new unit among 1369 files; protocol excluded from no-DB collection |
| Required chain UNION | `ci-union-proof.json`: all 119 pre-existing steps and all other parsed workflow fields unchanged, one mandatory step added to test (20.x) |
| Existing CI wiring neighbor | `ci-neighbor-wiring.log`: 320 passed, 0 skipped, exit 0 |
| Missing database negative | `missing-db.log`: named REQUIRES_DATABASE_URL collection failure, exit 1; no skip fallback |
| Root quality entry | `validate-all.log`: pnpm validate:all exit 0 (13 valid plugins, 9 existing warnings, lint and all configured type checks pass) |
| Isolated dependencies | `install-offline.log`: frozen/offline, ignore-scripts, import-method=copy; 934 cached packages, 0 downloaded, exit 0; no shared-worktree dependency links |
| Inert neighbors | `unchanged-neighbors.json`: CSV normalizer, generic normalizer, absence scheduler unchanged from base |

The protocol creates a fresh randomly named scratch database, applies 27 actual
production attendance migrations and minimal synthetic identity/FK fixtures,
then drops it. Registered production handlers use real RBAC, prepare/token SQL,
`createAttendanceSyncImportHostV1` SERIALIZABLE transactions, timezone source
checks and issuance. No SQL read stubs or commit-host mock. Provider HTTP is an
in-memory fetch mock; all unconfigured IO throws. Internal event delivery is
captured. It is not a deployed HTTP/login or real-tenant acceptance test.

Thirteen synchronous import protocol commits include token creation/consumption
and idempotent replays: A/B/C inputs, per-day LA shifts and rotations against a
Shanghai org rule, aliases and a mapped field subject, date-only/naive and
night-shift neighbors. Two additional provider route commits assert canonical
and alias subjects against conflicting userMap values; exactly three fetch calls
are intercepted in memory. Each persisted row assertion includes canonical
subject, local date, exact instant, timezone and import-item day. Scope cases
exercise preview, commit and the legacy route, with exact 403 and authorized 422
bodies and unchanged batch count after denial. No switches are enabled.

## CI and local commands

Required workflow: `.github/workflows/plugin-tests.yml`, job `test`, stable step
`attendance-import-timezone-protocol`, immediately after the existing PG setup.
It reuses that job's DATABASE_URL and creates only its own scratch DB; it does not
replace the workflow migration chain or existing attendance integration gate.

```sh
pnpm --filter @metasheet/core-backend exec vitest --config tests/attendance-import-timezone-protocol/vitest.config.ts run --watch=false --cache=false --reporter=verbose --reporter=json --outputFile.json=../../artifacts/6032/protocol-result.json
pnpm validate:all
```

The exact CI shell body is extracted to `artifacts/6032/ci-command.sh`. The local
runner below verifies the owned stopped PG16 data directory/system identifier,
uses its private Unix socket/port and stops the cluster on exit. CI uses its
existing PostgreSQL14 service; this work does not claim a remote CI run.

```sh
bash artifacts/6032/run-protocol.sh
bash artifacts/6032/mutation-denial-order.sh
bash artifacts/6032/probe-baseline-partial-rule.sh
```

Via the remote runtime wrapper, cd back to this worktree/packages/core-backend:

```sh
pnpm exec vitest run tests/unit/attendance-import-timezone.test.ts tests/unit/attendance-live-punch-work-date.test.ts tests/unit/attendance-import-permission.test.ts tests/unit/attendance-work-date-resolver-w2.test.ts tests/unit/attendance-uuid-validation-routes.test.ts --watch=false --cache=false --maxWorkers=1 --minWorkers=1
TZ=America/New_York pnpm exec vitest run tests/unit/attendance-import-timezone.test.ts --watch=false --cache=false --maxWorkers=1 --minWorkers=1
```

## Independent existing failure and boundaries

`baseline-cause.json` contains the minimal synthetic fixture and frozen-main code
references. A partial rule-set supplies timezone, 22:00/06:00 and workingDays but
omits grace fields; a date-only row supplies naive 22:00/06:00 punches.
`normalizeRuleOverride` (base index ~L8559) returns undefined grace values; the
spread in commit planning (~L30129) overwrites defaults. `computeMetrics`
(~L12431, thresholds ~L12469) produces NaN lateMinutes/earlyLeaveMinutes. The
runtime probe captures these exact nonfinite paths in previewSnapshot.metrics
and recordWrites. The real host's commandFingerprint (~L451 in
w4c3a-sync-import-host.ts) calls strict canonical JSON, which rejects a nonfinite
number at w4c0-fingerprints.ts:53. This is a host fingerprint failure, not a
provider transport failure. Original main bytes reproduce it, exit 1:
`baseline-partial-rule.log`, `baseline-partial-rule-stack.txt` and
`baseline-nonfinite-paths.json`. It requires no epoch/offset input and remains
unfixed outside this A/B/C slice. The probe restores the current source exactly.

Async job execution, enabled multi-timezone policy/business trips, real login,
real provider APIs, deployment, real UAT and remote CI are not claimed. Stream
and lifecycle remain OFF; 50004 is excluded. Keep Draft; no Ready, merge or deployment. Exact-head required CI remains pending until terminal success is verified.
Artifacts and dependency/build caches stay remote; generated evidence is not a
production source change. Earlier direct-writer proof is historical and is
superseded by the full protocol; temporary writer exports were removed.
Root lint has its existing scope and does not lint the new attendance spec;
CJS syntax and source whitespace checks also pass separately.


## Candidate-date calculation gate correction (2026-10-22)

Baseline remains dependency HEAD `943cf280771def4e9c208815dd1e4e5bbf709672`.
The independent real-PG review reproduced 18 named assertion failures: nine
invisible-subject imports returned the multi-segment calculation 422 before the
required full scope 403, and nine valid imports were blocked by a multi-segment
shift on a neighboring date that did not map the input instant to itself.
Nine actually selected multi-segment controls retained the exact existing 422.
Original evidence stays under `artifacts/calendar-denial-review/`.

Candidate selection now calls `loadRotationAssignment` then, when no rotation
wins, `loadShiftAssignment`, reusing their organization/publish/date/reference
semantics. It preserves rotation > assignment > rule timezone/source precedence.
`applyCalendarPolicyToWorkContext` changes working-day/policy fields only, not the
source timezone; holiday/policy calculation is therefore unnecessary at this seam.
No exception catch, calculation-gate bypass option, flag, timeout, or production
schema change is introduced. Both calculation-context functions and their segment assertions
remain unchanged. The request's existing scope guard runs before the selected-day
calculation, so authorized multi-segment inputs still fail closed.

`calendar-denial.ts` is collected whole-file by the existing required timezone
protocol config, alongside `protocol.ts`. Its real-migration/RBAC/core-host matrix
covers JSON seconds, milliseconds and entries across preview, commit and legacy;
it asserts full 403/422 shapes, valid neighboring-day imports, explicit-date
controls, no outside-network/provider IO and no denied-input effects. Focused unit
cases also cover simultaneous rotation/assignment timezone precedence. Tests use
synthetic scratch databases only. Stream/lifecycle remain OFF.

Repair validation and mutation evidence: `artifacts/calendar-denial-review/fix/`.
Final commands, counts and restored hashes are recorded there after execution.
The reviewed correction is submitted to the existing Draft PR; fresh exact-head CI
is still required. Merge, deployment and real UAT remain unauthorized.
The existing partial-rule nonfinite-metrics baseline limitation above remains
independent and unchanged; CSV, #6014 scheduler/report and 50004 remain out of scope.


### Token-order and fixture proof boundary

The first corrected-source probe returned the expected scope/calendar outcomes
but failed nine extra assertions that required authorized 422s not to consume a
token. It is retained as `fix/token-order-before-control/` (37 passed / 9 failed),
not relabeled green. A frozen-HEAD explicit-date control then ran all three real
routes: each returned the full existing segment 422, consumed token 1 -> 0 before
probe cleanup, and left records/batches/items/jobs/events unchanged. Its log has
3 passed / 58 explicitly filtered; Vitest 1.6's misleading global JSON passed
count is not used. Instant-input expectations now require strict equivalence to
that original path; scope 403s must still leave the token untouched.

Latest fetched `origin/main` is `4c78e75a0d1a96743c0b5b0ee9c8e8f059e99e3d`.
The protocol fixture now includes `users.role text NOT NULL DEFAULT 'user'` from
its actual users migration and runs the actual roles-table migration, bringing
the applied production migration count to 28. No admin role is assigned. The
owner retains a direct attendance:admin grant. The scoped actor has enabled
attendance namespace admission and only the actual attendance_employee role with
read/write permissions, plus scheduler self/import scope. It has no direct or
role-derived global import/admin grant. The matrix asserts the exact role and
permission sets and counts auth schema-error fallbacks, which must remain zero. Phase timestamps separate DB
creation, migration and plugin activation failures from assertion outcomes.


### Correction validation results

All counts below are executed test cases, checked against named assertions,
observations, suite status and process exit. Filtered cases are not passes.
Vitest 1.6 global JSON counts are not authoritative on setup/filtered runs.

| Evidence label | Passed | Failed | Explicitly filtered | Disposition |
| --- | ---: | ---: | ---: | --- |
| Original independent baseline | 28 | 18 | 0 | R1/R2 named business assertion failures |
| token-order-before-control | 37 | 9 | 0 | Retained overstrong token assertions; all original 18 repaired |
| token-baseline, frozen dependency HEAD | 3 | 0 | 58 | Explicit-date controls, required token; original JSON global 61 ignored |
| qualified46 | 46 | 0 | 0 | Corrected token equivalence, stronger real-auth fixture |
| official-protocol, forced require-token=1 | 50 | 11 | 0 | Original optional-token protocol incompatible with forced harness setting; preserved, not a product-regression verdict |
| official-protocol-default0 | 61 | 0 | 0 | Existing protocol 12 plus new calendar matrix 49 |
| unit | 341 | 0 | 0 | Eight affected/neighbor files, including W7 classification and W6 graph checks |
| mutation | 18 | 18 | 10 | Original early full-context call restored: exact same R1/R2 assertions red |
| restored46 | 46 | 0 | 0 | Byte-exact source restoration; full independent matrix green |

Earlier setup/runtime attempts are retained separately and count as zero valid
business passes, not named business reds. The original nine-token-failure log,
JSON, observations and production-source bytes remain preserved. Its assertion
source was reconstructed by reversing the known expectation block, with matching
failure line; the evidence manifest explicitly distinguishes that reconstruction
from a contemporaneous snapshot.

`pnpm validate:all` exits 0: 13 valid plugin manifests (nine existing warnings,
zero errors), scoped root lint, backend type checking and web type checking,
including verification-approval and verification-stock-prep. CJS syntax and
`git diff --check` also pass. Root lint keeps its pre-existing limited scope.
No timeout was increased.

Actual commands ran from the owned repo through `../run-import-timezone.sh`:

```sh
bash artifacts/calendar-denial-review/fix/finish-validation.sh
```

That frozen sequential runner invokes the installed Vitest CLI with the formal
`tests/attendance-import-timezone-protocol/vitest.config.ts` and
`ATTENDANCE_IMPORT_REQUIRE_TOKEN=0`, then `EMIT_W7_CLASSIFICATION=1 bash
artifacts/calendar-denial-review/fix/unit.sh`, `pnpm validate:all`, the targeted
`mutation.py`, and the restored independent matrix. Every PG leg uses
`with-pg.sh` with a distinct evidence label, the owned synthetic cluster on
56435, real fixture migrations and a stop trap. Independent required-token
controls and qualified46 have separate logs/JSON. Do not rerun with an existing
evidence label: historical artifacts must remain unchanged.

All repaired matrix runs apply 28 production migrations. The successful fixed
full matrices each exercise 12 real synchronous core-host commits; no auth
schema fallback, provider IO or outside-network attempt is observed. Rejected
cases preserve records/batches/items/jobs/events and core-host call counts;
403 also preserves tokens. Authorized 422 token order matches the existing
explicit-date path for each configured route. Stream/lifecycle and async
endpoints remain OFF. No rollout rows or async jobs are created.

Production SHA256 after mutation and restored46:

- `plugins/plugin-attendance/index.cjs`: `ea9f63d8f3d052a101141f7ab42e5cef460c5c35d11ce07fe97f7fce5c134265`
- `plugins/plugin-attendance/lib/attendance-import-calendar.cjs`: `595033a82ae6f1a3d85b6278e59caa8fd0c7ceaf08b61dde719de8fdddc19747`

`fix/final-summary.json` records all changed-file hashes and byte-equivalence
checks for both work-context resolvers, the segment assertion, calendar policy
and CSV date normalization. `fix/final.diff` includes the new formal protocol
file as well as tracked modifications. The PG stop log and no-listener check
confirm 56435 is stopped after restored46. No further PG run is part of closeout.
This is local synthetic registered-handler/core-host proof; real login, deployed
namespace routing, exact-head CI, provider calls and UAT remain unclaimed.

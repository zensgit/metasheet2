# Attendance non-CSV import calendar correction (#6032)

Base: `4c78e75a0d1a96743c0b5b0ee9c8e8f059e99e3d`.
Branch: `codex/dingtalk-import-timezone-20261022`. R71 candidate; keep the PR Draft until separately approved.
Scope: entries/DingTalk column/JSON dates and offset-aware punch parsing.
Draft #6014 remains independent; no cherry-pick or CSV/absence/report changes.
No OAuth/help edits, feature-switch changes, deployment, real tenant IO or UAT.

## Contract

- Offset-bearing ISO and 10/13-digit epoch work dates denote instants. Preserve
  the raw source until normalization, before authorization/day keys and storage.
- Reuse `resolveWorkContext`: rotation shift, assigned shift, then explicit/group
  rule-set override or organization default. Resolve subjects through the same
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

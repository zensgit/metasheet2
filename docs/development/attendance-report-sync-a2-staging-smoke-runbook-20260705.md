# Report-sync A2 scheduled-trigger staging smoke runbook

**Date:** 2026-07-05
**Scope:** ops tooling only — this runbook and its companion helper build the S3 staging-smoke
slice of `docs/development/attendance-report-sync-a2-scheduled-trigger-design-lock-20260705.md`
(#3623, RATIFIED owner-delegated). Zero runtime/product code changes. It does **not** mark
report-sync A2 complete by itself — the design-lock's §4 completion bar also requires the
backend runtime + reverse tests (that is #3630, not this slice) and an Opus adversarial review
pass, and this runbook's own tracker line only flips after a real staging PASS with residue `0`.

## Dependency note (read first)

This runbook and its helper assert against the settings keys / job shapes / exported test seam
that **#3630 (report-sync A2 scheduled trigger runtime, OPEN as of this writing)** introduces:

- `reportSync.scheduledTrigger.{enabled,cadence,maxOrgsPerRun,maxUsersPerRun}` settings (default
  all-off);
- env flag `ATTENDANCE_REPORT_SYNC_SCHEDULED_TRIGGER_ENABLED`;
- scheduler job name `attendance-report-sync-scheduled`;
- test seam `attendancePlugin.__attendanceReportFieldCatalogForTests.runAttendanceReportSyncScheduledTriggerOnce`
  (and its siblings `resolveAttendanceReportSyncScheduledTriggerOrgIds` /
  `resetAttendanceSettingsCacheForTests`).

**The helper cannot run until #3630 merges and is deployed to the target environment.** If #3630's
implementation shape changes during its own review (settings keys, function names, return shape,
job statuses), this runbook and `scripts/ops/staging-attendance-report-sync-a2-smoke.mjs` /
`.test.mjs` must be updated to match before the next run — see the PR body for the exact
dependency this slice took on #3630's diff as read at authoring time.

## Automated helper

The env+settings-gate / seed / tick / idempotency / throttle / residue steps below are scripted by
`scripts/ops/staging-attendance-report-sync-a2-smoke.mjs` (+ companion `.test.mjs` contract
tests), modeled on two existing helpers:

- structure/style/two-stage-stamp convention from
  `scripts/ops/staging-attendance-manual-missed-punch-reminder-hmr5-smoke.mjs` (pure helpers
  exported for the companion `.test.mjs`, `IS_MAIN` gate, `resolveEnvConfig`, STAMP regex lock);
- the scheduler-job mechanics (direct plugin require + in-process tick calls + a second-tick
  idempotency proof) from `scripts/ops/staging-attendance-auto-shift-a2-smoke.mjs` — this helper
  calls the exported A2 tick function directly against the staging DB, the same way that helper
  does, rather than waiting on `AttendanceScheduler`'s own interval loop.

Run it from a prepared metasheet2 checkout, on a host that can reach both the staging API and its
Postgres (the helper calls the scheduled-trigger tick function **directly in this Node process**,
not through the deployed server — see SCOPE NOTE below):

```bash
BASE_URL=http://127.0.0.1:8082 \
DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet \
DEPLOY_SHA=<staging-main-sha> \
ATTENDANCE_SCHEDULER_ENABLED=true \
ATTENDANCE_REPORT_SYNC_SCHEDULED_TRIGGER_ENABLED=true \
node scripts/ops/staging-attendance-report-sync-a2-smoke.mjs
```

Optional env: `SMOKE_TOKEN=<admin bearer>` (else the helper mints its own dev-token — dev-node-env
only), `STAMP=reportsync-a2-smoke-...` (else auto-generated), `RUN_DATE=YYYY-MM-DD` (else today,
UTC), `ALLOW_CROSS_ORG_REPORT_SYNC_FANOUT=1` (see the cross-org fan-out hazard below — required
whenever the target DB already has other orgs' `attendance_rules` rows).

It prints `REPORT_SYNC_A2_API_DB_SMOKE_PASS deploy=<sha> stamp=reportsync-a2-smoke-...
org=<main-org> orgs=<gate>|<main>|<throttle> synced=<n> collateralOtherOrgs=<n> residue=0`, which
is **not** the final PASS stamp — same two-stage pattern as the HMR-5 / MP-6 / AE-4 / RD-4/5
helpers. See "Manual close-out steps" below for what it does not cover and the final stamp name.

### SCOPE NOTE — two things the automated helper deliberately does not prove

1. **Real multitable base/sheet writes.** The helper's `context.api.multitable` is an in-process,
   in-memory stand-in (`createFakeReportRecordsMultitable` in the `.mjs`), matching the exact same
   shape the real-DB CI gate's own fake uses — not the real multitable REST/plugin stack. The
   design-lock explicitly delegates every write to the **existing**
   `syncAttendanceReportRecordsForUsers` writer and says A2 must not re-implement multitable
   writes; that writer's real multitable behavior is already staging-proven separately (2026-05-19
   live evidence via `pnpm run verify:attendance-report-fields:live` JOB_MODE=1,
   `scripts/ops/attendance-report-fields-live-acceptance.mjs`). This helper's job is the genuinely
   **new** part: the scheduling/claim/idempotency/throttle layer around that writer, proven for
   real against real staging Postgres and the real settings HTTP API — hence the `API_DB` stamp
   name, not an `API_MULTITABLE` one.
2. **The real `AttendanceScheduler` interval pickup.** Like the auto-shift-A2 helper, this one
   calls the exported tick function directly in the helper's own process. It does not prove the
   real deployed scheduler actually registers and ticks `attendance-report-sync-scheduled` on its
   own interval once both gates are left open for real.

### Cross-org fan-out hazard

`resolveAttendanceReportSyncScheduledTriggerOrgIds` (the org-fan-out helper #3630 adds) has **no
per-org filter** — `SELECT DISTINCT org_id FROM attendance_rules ORDER BY org_id`, sliced to
`maxOrgsPerRun`. A gate-open tick claims+runs a report-sync job for **every** org with an
`attendance_rules` row, up to that cap (deterministic `ORDER BY org_id` as of the #3630 review
pass; still no allowlist). This helper computes `maxOrgsPerRun` wide enough to guarantee its own
3 synthetic orgs are always covered, which means it also sweeps in any pre-existing real orgs on
the target DB — read-only reads of their `attendance_records`, plus one real
`plugin_attendance_report_sync_jobs` row created for each (no multitable write escapes to them,
per the SCOPE NOTE above).

The helper **refuses to run** against a DB with pre-existing other-org `attendance_rules` rows
unless `ALLOW_CROSS_ORG_REPORT_SYNC_FANOUT=1` is set, and — even when allowed — reports (but does
not delete) any collateral job rows it caused for those other orgs at the end, so an operator can
review/clean them up manually. Prefer running this against a scratch/isolated staging Postgres
with no other tenants' `attendance_rules` rows if at all possible.

## What This Proves

- both gate halves (env flag, settings) independently no-op when either is off — byte-exact
  `{ ran:false, reason:'disabled', orgs:[] }`, zero job rows either way;
- with both gates open, a tick claims (creates) a `mode:'enqueue'` / `kind:'daily_records'` job row
  for an org, delegates to the existing writer, and the SAME tick both **creates** a report-record
  for a brand-new user and **patches** a pre-existing-but-stale one (dual-fingerprint compare) in
  one page;
- a repeat tick in the same period is a byte-exact no-op (`claimed:false,
  reason:'already_completed'`, same `jobId`, zero additional writes) — the job table's
  `(org_id, idempotency_key)` unique index plus the writer's own fingerprint compare;
- `maxUsersPerRun` throttles pagination: the SAME job resumes (not recreated) across several ticks
  until the whole roster drains, then further ticks are no-ops;
- `maxOrgsPerRun` throttles the org fan-out itself (proven directly against the exported pure
  helper, not by guessing which orgs a full run happens to cover);
- cleanup removes every synthetic org/user/rule/record/job row this helper created, with residue
  `0` (collateral rows on **other**, pre-existing orgs are reported, not deleted — see the hazard
  note above).

## Prerequisites

1. Staging (or the target environment) runs a build containing #3630 (report-sync A2 scheduled
   trigger runtime) — merged on top of #3623 (this design-lock, already RATIFIED and merged).
2. Migrations current through `plugin_attendance_report_sync_jobs`
   (`zzzz20260519070000_create_plugin_attendance_report_sync_jobs`) and the settings schema change
   #3630 adds (no new migration — `reportSync` lives in the existing JSONB settings blob).
3. Run from a host that can reach both the API and the Postgres the API itself uses:

```bash
BASE_URL=http://127.0.0.1:8082
DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet
DEPLOY_SHA=<staging-main-sha>
ATTENDANCE_SCHEDULER_ENABLED=true
ATTENDANCE_REPORT_SYNC_SCHEDULED_TRIGGER_ENABLED=true
```

4. Confirm no pre-existing `attendance_rules` rows for other orgs, or plan to set
   `ALLOW_CROSS_ORG_REPORT_SYNC_FANOUT=1` and review the collateral report at the end.
5. This helper mints its own admin dev-token via `/api/auth/dev-token` (dev/staging node-env
   only). Supply `SMOKE_TOKEN=<bearer>` for an environment that 404s that route.

## Manual fallback (if the helper cannot run on a given host)

The helper is a thin, mechanical wrapper around:

1. `GET /api/attendance/settings` → capture `data.reportSync` for restore.
2. Seed one `attendance_rules` row (`is_default=true`, `timezone='UTC'`) + one or more
   `users`/`user_orgs` rows + `attendance_records` rows per synthetic org, for 3 disposable orgs
   (`<stamp>-gate`, `<stamp>-main`, `<stamp>-throttle`).
3. `PUT /api/attendance/settings` with `{ reportSync: { scheduledTrigger: { enabled, cadence,
   maxOrgsPerRun, maxUsersPerRun } } }`.
4. In a Node REPL from the repo root, with `ATTENDANCE_REPORT_SYNC_SCHEDULED_TRIGGER_ENABLED` set
   appropriately:
   ```js
   const plugin = require('./plugins/plugin-attendance/index.cjs')
   const seam = plugin.__attendanceReportFieldCatalogForTests
   // context.api.multitable needs a records/provisioning stand-in — see createFakeReportRecordsMultitable
   // in the .mjs helper for the exact shape to hand-construct here.
   await seam.runAttendanceReportSyncScheduledTriggerOnce(context, pluginDb, console, { now, emitEvent: () => {} })
   ```
5. Inspect `plugin_attendance_report_sync_jobs` rows directly by `org_id`.

Prefer the `.mjs` helper — this fallback exists only for a host without Node/`pg` access to run it.

## Residue Check

Before cleanup, record evidence (replace `:GATE_ORG`/`:MAIN_ORG`/`:THROTTLE_ORG` with the actual
stamped org ids the helper printed, or query by `stamp` prefix):

```sql
SELECT org_id, status, mode, kind, idempotency_key, totals
FROM plugin_attendance_report_sync_jobs
WHERE org_id IN (:GATE_ORG, :MAIN_ORG, :THROTTLE_ORG)
ORDER BY org_id;
```

Cleanup (the helper does this automatically; shown here for the manual-fallback path):

```sql
DELETE FROM plugin_attendance_report_sync_jobs WHERE org_id = ANY(ARRAY[:GATE_ORG, :MAIN_ORG, :THROTTLE_ORG]);
DELETE FROM attendance_records WHERE org_id = ANY(ARRAY[:GATE_ORG, :MAIN_ORG, :THROTTLE_ORG]);
DELETE FROM attendance_rules WHERE org_id = ANY(ARRAY[:GATE_ORG, :MAIN_ORG, :THROTTLE_ORG]);
DELETE FROM user_orgs WHERE user_id = ANY(ARRAY[/* every synthetic user id */]);
DELETE FROM users WHERE id = ANY(ARRAY[/* every synthetic user id */]);
```

Residue must be zero:

```sql
SELECT
  (SELECT count(*) FROM plugin_attendance_report_sync_jobs WHERE org_id = ANY(ARRAY[:GATE_ORG, :MAIN_ORG, :THROTTLE_ORG])) AS jobs,
  (SELECT count(*) FROM attendance_records WHERE org_id = ANY(ARRAY[:GATE_ORG, :MAIN_ORG, :THROTTLE_ORG])) AS records,
  (SELECT count(*) FROM attendance_rules WHERE org_id = ANY(ARRAY[:GATE_ORG, :MAIN_ORG, :THROTTLE_ORG])) AS rules;
```

Collateral cross-org rows (informational only — these belong to orgs the helper did not create and
are intentionally left in place; review and decide manually):

```sql
SELECT org_id, count(*) FROM plugin_attendance_report_sync_jobs
WHERE org_id NOT IN (:GATE_ORG, :MAIN_ORG, :THROTTLE_ORG)
  AND created_by = 'system:attendance-report-sync-scheduled-trigger'
  AND created_at >= :SMOKE_STARTED_AT
GROUP BY org_id;
```

## Manual close-out steps

The automated helper's `REPORT_SYNC_A2_API_DB_SMOKE_PASS` stamp is not the final PASS stamp. Two
manual steps close the gap the SCOPE NOTE above describes:

1. **Required — real scheduler interval pickup.** With both gates left open for real (env flag +
   settings `enabled:true` on the actual deployed backend, not just this helper's own process),
   wait one real `AttendanceScheduler` interval and confirm a NEW
   `plugin_attendance_report_sync_jobs` row appears for a real org **without any manual/helper
   trigger** — i.e. the registration wired in #3630's plugin bootstrap actually ticks on its own.
   Then turn the settings back off (or leave on, per the owner's rollout decision) once confirmed.
2. **Optional, recommended — real multitable spot-check.** If an operator wants to go beyond the
   "delegates to an already-proven writer" argument and see a real multitable row for themselves:
   create one `mode:'manual_step'` job via the existing
   `POST /api/attendance/report-sync-jobs` + `.../run-next-page` routes (already staging-proven
   2026-05-19) for a throwaway user/date, and inspect the resulting report-record row through the
   normal multitable UI/API. This is the same underlying writer the scheduled trigger delegates to,
   so it is not required to close A2 — it is an extra confidence check some operators may want.

## Expected PASS Stamps

Two-stage, same convention as HMR-5 / MP-6 / AE-4 / RD-4/5:

```text
REPORT_SYNC_A2_API_DB_SMOKE_PASS deploy=<sha> stamp=reportsync-a2-smoke-... org=<main-org> orgs=<gate>|<main>|<throttle> synced=<n> collateralOtherOrgs=<n> residue=0
```

Only after that helper run passes **and** the required manual scheduler-interval-pickup step above
is confirmed, record:

```text
REPORT_SYNC_A2_STAGING_SMOKE_PASS deploy=<sha> stamp=reportsync-a2-smoke-... residue=0
```

## Tracker note

Report-sync A2 is **not** part of the current staging-window 5-smoke bundle (that bundle is
tracked separately and is a distinct, already-scoped set) — this slice is independent. Once both
PASS stamps above are recorded, add one line to the attendance/report-sync tracker noting "A2
smoke ready" with the two stamps; do not fold this into the 5-smoke bundle's own tracking doc.

## Failure Hints

- `requireRunnerExport()` throws "attendance plugin is missing exported test seam(s)": #3630 is not
  merged/deployed yet on the target checkout — this is expected until it lands; do not try to work
  around it by hand-patching the plugin file.
- Gate-closed tick returns `ran:true` or a non-empty `orgs` array: the double-gate regressed —
  check both `isAttendanceReportSyncScheduledTriggerRuntimeEnabled()` (env) and
  `trigger.enabled` (settings) are each independently `false`-safe in the deployed source.
- Main-flow tick 1 totals show `patched:0` for the stale user: the dual-fingerprint compare
  (`existingSource === sourceFingerprint && existingField === fieldFingerprint`) may be comparing
  against the wrong physical field id, or the stale fixture's marker values coincidentally match a
  freshly-computed fingerprint — regenerate the stale markers to be obviously distinct strings.
- Repeat tick creates a second job row instead of a no-op: the `(org_id, idempotency_key)` unique
  index may be missing on the target DB — verify migration
  `zzzz20260519070000_create_plugin_attendance_report_sync_jobs` applied cleanly.
- `assertCrossOrgFanoutRisk()` refuses to run: expected on a shared staging DB with other real
  orgs — either set `ALLOW_CROSS_ORG_REPORT_SYNC_FANOUT=1` deliberately, or point `DATABASE_URL` at
  a more isolated DB.
- `resolveMaxOrgsPerRunForFullCoverage` throws "caps maxOrgsPerRun at 50": the target DB already has
  47+ distinct orgs in `attendance_rules` — clean up stale/unrelated orgs first, or accept that this
  helper cannot guarantee its own org's inclusion on that DB.
- Residue is non-zero after cleanup: inspect rows by the printed `stamp`-prefixed org ids; the
  helper's own `cleanup()` is idempotent-safe to re-run manually with the same org ids.

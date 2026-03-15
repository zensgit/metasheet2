# Attendance Run11 Nightly Watch Checklist

## Status

- Date: `2026-03-15`
- Main commit: `06561f8f649ee4b736fbf5d74943b066a3dc02e4`
- Scope: `run11` post-release watch

## Watch Windows

- `Attendance Strict Gates (Prod)`
  - Schedule: daily `02:15 UTC` / `10:15 Asia/Shanghai`
- `Attendance Daily Gate Dashboard`
  - Schedule: daily `04:30 UTC` / `12:30 Asia/Shanghai`
- `Attendance Import Perf High Scale`
  - Schedule: weekly `Sunday 06:00 UTC` / `Sunday 14:00 Asia/Shanghai`

## Nightly Checklist

1. `Strict Gates`
   - Check: `Attendance Strict Gates (Prod)` remains green on `main`.
   - Normal: full workflow passes, especially login entry, admin import, and desktop flow assertions.
   - Escalate: any `FAIL`, any new `playwright` timeout, or any `/api/auth/me` regression signal.

2. `Daily Dashboard`
   - Check: `Attendance Daily Gate Dashboard` reports overall `pass` for `main`.
   - Normal: dashboard stays green, or only reflects the already known `perf-highscale` capacity track separately.
   - Escalate: new `P0` dashboard failure, or `strict`/`locale zh`/`contracts` begin failing.

3. `Perf High Scale Classification`
   - Check: high-scale runs continue to classify `100000 rows` vs current `20000 CSV cap` as `capacity_mismatch`.
   - Normal: workflow run itself may end in `failure`, but issue/comment/artifact should include `classification: capacity_mismatch`, and post-merge policy should treat it as known non-blocking capacity mismatch.
   - Escalate: the same scenario reverts to opaque perf failure, loses the mismatch artifact, or starts failing the aggregated post-merge verdict again.

4. `Login Idle Behavior`
   - Check: no renewed login-page `/api/auth/me` storm after merge.
   - Normal: empty token means no repeated probe; stale token means at most one failed probe then stop.
   - Escalate: repeated unauthenticated `/api/auth/me` requests, login form instability, or strict-gates login failures.

5. `Holiday + Import Critical Paths`
   - Check: the most recent tester feedback or smoke verification still matches the `run11` release scope.
   - Normal: holiday sections stay grouped and save/reload correctly; `holidaySync.lastRun: null` save path remains valid; invalid JSON import still shows both error and retry action; numeric placeholder groups such as `"1"` do not create attendance groups.
   - Escalate: any regression in holiday settings persistence, import retry UI, localized dates/messages, or `paid/unpaid` leave visibility.

## Current Baseline

- `run11` tester brief is already on `main`:
  - [attendance-run11-test-brief-20260315.md](/Users/huazhou/Downloads/Github/metasheet2-attendance-nightly-watch-20260315/docs/development/attendance-run11-test-brief-20260315.md)
- `perf-highscale` capacity mismatch classification is already on `main`:
  - PR merge commit: `06561f8f649ee4b736fbf5d74943b066a3dc02e4`
- Manual post-merge verification confirmed the new policy:
  - High-scale run: [23109237073](https://github.com/zensgit/metasheet2/actions/runs/23109237073)
  - Tracking issue: [#447](https://github.com/zensgit/metasheet2/issues/447)

## Evidence

- Strict gates pass reference:
  - [23107792219](https://github.com/zensgit/metasheet2/actions/runs/23107792219)
- Prior post-merge summary before classification fix:
  - [23107785329](https://github.com/zensgit/metasheet2/actions/runs/23107785329)
- High-scale classified run after fix:
  - [23109237073](https://github.com/zensgit/metasheet2/actions/runs/23109237073)

## Escalation Rule

- If the only abnormal signal is `perf-highscale = capacity_mismatch`, keep tracking under [#447](https://github.com/zensgit/metasheet2/issues/447) and do not treat it as a `run11` functional blocker.
- If any new `strict`, `dashboard`, login, holiday settings, import retry, or leave-visibility regression appears, treat it as a fresh release blocker and re-open active engineering work immediately.

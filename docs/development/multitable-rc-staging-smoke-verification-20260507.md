# Multitable RC Staging Smoke — Remote Verification Harness · Verification

> Date: 2026-05-07
> Companion to: `multitable-rc-staging-smoke-development-20260507.md`

## Syntax check

```bash
node --check scripts/verify-multitable-rc-staging-smoke.mjs
```

Result: passes (no output / exit 0).

## package.json validity

```bash
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"
grep -n 'verify:multitable-rc:staging' package.json
```

Result: parses; entry registered at line 48.

## Dry-run against unreachable URL (loud-failure validation)

The script does not have access to a real staging cluster from this worktree, but the runtime structure is validated by pointing it at a closed local port and confirming each check fails with a clear error and the report is written.

```bash
AUTH_TOKEN=fake-token \
API_BASE=http://127.0.0.1:1 \
OUTPUT_DIR=/tmp/rc-smoke-fake-test \
node scripts/verify-multitable-rc-staging-smoke.mjs
```

Result (truncated):

```
[rc-smoke] FAIL lifecycle (11ms): fetch failed
[rc-smoke] FAIL public-form (0ms): fetch failed
[rc-smoke] FAIL hierarchy (0ms): fetch failed
[rc-smoke] FAIL gantt-config (0ms): fetch failed
[rc-smoke] FAIL formula (0ms): fetch failed
[rc-smoke] FAIL automation-email (0ms): fetch failed
[rc-smoke] FAIL autoNumber-backfill (1ms): fetch failed
[rc-smoke] report json: /tmp/rc-smoke-fake-test/report.json
[rc-smoke] report md:   /tmp/rc-smoke-fake-test/report.md
[rc-smoke] result: 0 pass / 7 fail / 0 skip / 7 total
```

`report.md` excerpt:

```
# Multitable RC Staging Smoke Report

- API: `http://127.0.0.1:1`
- Started: 2026-05-08T05:26:23.794Z
- Finished: 2026-05-08T05:26:23.807Z
- Total: 7 (pass=0, fail=7, skip=0)

| Check | Status | Duration |
| --- | --- | --- |
| lifecycle | fail | 11ms |
| public-form | fail | 0ms |
| ...
```

Confirms:
- All seven checks are registered and iterated
- Errors are caught per-check (no early termination)
- Both `report.json` and `report.md` are written
- Exit code is non-zero on any failure (verified via `&&`-chain semantics in the dry-run)

## Diff hygiene

```bash
git diff --check
```

Result: passes.

## Scoped diff

- `scripts/verify-multitable-rc-staging-smoke.mjs` — new harness
- `package.json` — `verify:multitable-rc:staging` script entry
- `docs/development/multitable-rc-staging-smoke-development-20260507.md` — new
- `docs/development/multitable-rc-staging-smoke-verification-20260507.md` — new

## Operational usage

```bash
AUTH_TOKEN=$(cat /tmp/metasheet-staging-admin.jwt) \
API_BASE=http://142.171.239.56:8081 \
pnpm verify:multitable-rc:staging
```

Outputs land at `output/multitable-rc-staging-smoke/{report.json,report.md}` by default. Operator pins these to the release decision artifact. For a partial run that excludes the slowest check, use:

```bash
SKIP=automation-email pnpm verify:multitable-rc:staging
```

## What is NOT validated by this PR

- A real staging cluster run. The dry-run against an unreachable port proves the runtime structure; running the harness against `142` requires a fresh admin JWT that this PR does not include.
- Real SMTP / mail receipt. `notificationStatus === 'sent'` is the channel-result contract that the spec asserts; the underlying default `EmailNotificationChannel` is a mock.
- DingTalk-protected public-form access modes (`'dingtalk'` / `'dingtalk_granted'`).
- UI / browser interaction layers (Codex's RC checklist + the human smoke pass cover those).

## Pre-deployment checks

- [x] No DingTalk / public-form runtime / `plugins/plugin-integration-core/*` files touched.
- [x] No migration / OpenAPI / route additions.
- [x] No new env vars beyond what operators must already know about (AUTH_TOKEN / API_BASE pattern matches the existing `verify-multitable-live-smoke.mjs`).
- [x] Branch rebased onto `origin/main@20fb5270a` before push.

## Result

Script syntax-clean, package.json valid, dry-run produces clean reports + correct exit code. Ready to run against the deployed RC staging by the operator/Codex during the RC validation window.

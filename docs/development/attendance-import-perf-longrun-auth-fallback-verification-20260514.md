# Attendance Import Perf Long Run Auth Fallback Verification 2026-05-14

## Baseline Failure

- Workflow: `Attendance Import Perf Long Run`
- Run: `25845123113`
- Head SHA: `298de5699df9d96900d0dbf936b4673d3a1dbadc`
- Event: scheduled run
- Result: failure

Observed failure:

- Scenario jobs failed in `Resolve valid auth token`.
- Resolver emitted `no valid auth token after token/refresh/login fallback`.
- `LOGIN_EMAIL` and `LOGIN_PASSWORD` were empty in the job environment.
- `trend-report` then failed because no current perf summary existed.
- The summary step also attempted to read an empty markdown output path.

## Verification Commands

Run from repo root:

```bash
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/attendance-import-perf-longrun.yml"); puts "yaml-parse-ok"'
bash -n scripts/ops/resolve-attendance-smoke-token.sh
bash -n scripts/ops/attendance-resolve-auth.sh
bash -n scripts/ops/attendance-write-auth-error.sh
node --test scripts/ops/attendance-import-perf-longrun-workflow-contract.test.mjs
node --test scripts/ops/resolve-attendance-smoke-token.test.mjs scripts/ops/attendance-auth-scripts.test.mjs
files="$(git diff --name-only)"
pattern='access_''token=[^[:space:]]+|SEC[0-9A-Za-z]{20,}|ey''J[0-9A-Za-z_-]+\.|Bearer[[:space:]]+[A-Za-z0-9._-]{20,}|ATTENDANCE_ADMIN_''PASSWORD=\S'
rg -n "${pattern}" ${files}
```

## Expected Result

- YAML parses successfully.
- Shell scripts pass syntax checks.
- Workflow contract test confirms:
  - configured token/login fallback remains present;
  - deploy-host fallback secrets are wired;
  - `resolve-attendance-smoke-token.sh` is called only after configured auth
    fails;
  - fallback diagnostics are written to `deploy-host-auth-fallback.log`;
  - trend summary no longer runs `cat` with an empty output path.
- Existing auth resolver and deploy-host token resolver tests continue to pass.
- Secret scan has no real token/webhook/password findings.

## Local Results

- `yaml-parse-ok`
- shell syntax checks: pass
- `attendance-import-perf-longrun-workflow-contract.test.mjs`: 2 pass
- `resolve-attendance-smoke-token.test.mjs` +
  `attendance-auth-scripts.test.mjs`: 8 pass
- `git diff --check`: pass
- changed-file strict value-pattern secret scan: 0 findings

## Post-Merge Live Check

After merge, manually rerun `Attendance Import Perf Long Run` or wait for the
next scheduled run. Success criteria:

- At least the enabled scenarios pass the auth resolution step.
- Scenario artifacts show either configured auth or deploy-host fallback as the
  source, without exposing token values.
- Trend report no longer fails with `cat: '': No such file or directory`.

## Current Delivery Status

This patch fixes the workflow-level red introduced by credential drift. It does
not change Attendance business behavior and does not change DingTalk runtime
behavior.

# DingTalk P4 Regression Gate Verification

- Date: 2026-04-23
- Scope: local verification for the DingTalk P4 regression gate runner

## Commands

```bash
node --test scripts/ops/dingtalk-p4-regression-gate.test.mjs
node scripts/ops/dingtalk-p4-regression-gate.mjs --profile ops --plan-only --output-dir /tmp/dingtalk-p4-regression-plan
node scripts/ops/dingtalk-p4-regression-gate.mjs --profile ops --output-dir /tmp/dingtalk-p4-regression-ops
git diff --check
```

## Results

- `node --test scripts/ops/dingtalk-p4-regression-gate.test.mjs`: passed, 4 tests.
- `--profile ops --plan-only`: passed and wrote `/tmp/dingtalk-p4-regression-plan/summary.json`.
- `--profile ops`: passed and wrote `/tmp/dingtalk-p4-regression-ops/summary.json`.
- `git diff --check`: passed.

## Expected Coverage

- Ops profile plan writes `summary.json` and `summary.md` without executing checks.
- Fast selftest profile executes a real child process and captures stdout/stderr logs.
- Secret-like command output is redacted in both logs and summaries.
- Invalid profile input fails with a clear public profile list.

## Remote Scope

This verification does not call DingTalk, staging, or PLM. The product profile is intentionally available as an operator command but was not required for this local tooling slice.

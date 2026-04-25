# DingTalk P4 Release Readiness Smoke Handoff Development

- Date: 2026-04-23
- Branch: `codex/dingtalk-next-slice-20260423`
- Base: `origin/main` at `8d2d3e1b0`
- Scope: collapse release readiness and smoke-session startup into one operator path without adding any real private staging inputs

## Problem

The repo already had:

- a canonical private env file at `$HOME/.config/yuantus/dingtalk-p4-staging.env`;
- a safe env setter and readiness checker around that file;
- a separate `dingtalk-p4-smoke-session.mjs` flow for the real 142/staging run.

The remaining gap was operator handoff. After readiness passed, the maintainer still had to translate the report into a second command manually. That kept the last-mile DingTalk P4 runbook inconsistent with the canonical private env flow.

## Changes

- Extended `scripts/ops/dingtalk-p4-release-readiness.mjs` with:
  - `--run-smoke-session`
  - `--smoke-output-dir <dir>`
  - `--smoke-timeout-ms <ms>`
- When release readiness passes, the script now starts `scripts/ops/dingtalk-p4-smoke-session.mjs` automatically with:
  - `--env-file <canonical-private-env>`
  - `--require-manual-targets`
  - the requested smoke output dir
- Stored redacted smoke-session stdout/stderr logs alongside the release-readiness report.
- Read smoke-session outputs back into the readiness summary:
  - `session-summary.json`
  - `session-summary.md`
  - `smoke-status.json`
  - `smoke-status.md`
  - `smoke-todo.md`
- Updated the markdown report so the next-step section now distinguishes:
  - readiness passed and smoke auto-started;
  - readiness failed and smoke launch was blocked;
  - smoke launch failed after readiness passed.
- Updated `--help` text to advertise the new one-command handoff path.
- Added focused tests for:
  - successful auto-launch after readiness pass;
  - blocked launch when readiness fails;
  - smoke-session failure propagating back to `overallStatus: "fail"`.

## Testability

- The release-readiness script accepts test-only script override `DINGTALK_P4_RELEASE_READINESS_SMOKE_SESSION_SCRIPT`.
- Tests use a local stub smoke-session script so the new handoff path is verified without calling DingTalk, staging, or any private endpoint.

## Operator Flow

```bash
node scripts/ops/dingtalk-p4-release-readiness.mjs \
  --p4-env-file "$HOME/.config/yuantus/dingtalk-p4-staging.env" \
  --regression-profile ops \
  --run-smoke-session \
  --smoke-output-dir output/dingtalk-p4-remote-smoke-session/142-session
```

This command still depends on real private values being filled outside git. If the private env is blank or malformed, smoke startup is blocked and only the redacted readiness report is produced.

## Out Of Scope

- No real admin token or DingTalk webhook was added.
- No real 142/staging smoke was executed in this slice.
- No manual DingTalk evidence, final strict finalize, or handoff packet was produced here.

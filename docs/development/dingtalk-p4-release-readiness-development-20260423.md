# DingTalk P4 Release Readiness Development

- Date: 2026-04-23
- Branch: `codex/dingtalk-p4-release-readiness-20260423`
- Scope: local release gate orchestration; no DingTalk or staging calls.

## Completed Work

- Added `scripts/ops/dingtalk-p4-release-readiness.mjs`.
- The script combines:
  - private env readiness via `dingtalk-p4-env-bootstrap.mjs --check`
  - local regression gate via `dingtalk-p4-regression-gate.mjs`
- It writes a single redacted go/no-go report:
  - `release-readiness-summary.json`
  - `release-readiness-summary.md`
- The default flow uses:
  - env file: `$HOME/.config/yuantus/dingtalk-p4-staging.env`
  - regression profile: `ops`
  - output root: `output/dingtalk-p4-release-readiness/<run-id>`
- The final smoke command is printed only when both env readiness and regression gate pass.

## Behavior

- `overallStatus: "pass"` means the operator can start the final P4 smoke session with `--require-manual-targets`.
- `overallStatus: "fail"` means at least one required gate failed; the final remote smoke should not be started.
- `overallStatus: "manual_pending"` means env readiness passed but regression was intentionally plan-only.
- `--allow-failures` preserves a zero process exit for report collection while keeping the summary status as `fail` or `manual_pending`.

## Secret Handling

- The release readiness report reuses redaction for:
  - bearer tokens
  - DingTalk robot access tokens
  - SEC secrets
  - JWTs
  - public form tokens
  - DingTalk webhook timestamps and signatures
- The script stores only redacted child stdout/stderr and child summaries.

## Operator Command

```bash
node scripts/ops/dingtalk-p4-release-readiness.mjs
```

For a full product-level pre-smoke gate:

```bash
node scripts/ops/dingtalk-p4-release-readiness.mjs \
  --regression-profile all \
  --timeout-ms 1200000
```

## Out Of Scope

- No robot message send.
- No table/form creation.
- No manual DingTalk client evidence collection.
- No final packet export.

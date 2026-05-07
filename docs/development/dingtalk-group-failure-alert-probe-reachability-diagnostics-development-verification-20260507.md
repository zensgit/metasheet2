# DingTalk Group Failure Alert Probe Reachability Diagnostics - Development & Verification

Date: 2026-05-07

## Goal

Make the DingTalk group failure-alert deployment probe more useful when a 142
validation run cannot reach a backend API. A blocked run should identify the
exact API path that timed out or failed at the network layer, while still
writing redaction-safe `summary.json` and `summary.md` evidence.

## Development

- Updated `scripts/ops/dingtalk-group-failure-alert-probe.mjs`.
- `fetchJson` now records timeout failures as `API_TIMEOUT` with:
  - failing `pathname`;
  - configured `timeoutMs`.
- `fetchJson` now records network reachability failures as `API_NETWORK_ERROR` with:
  - failing `pathname`;
  - redacted original fetch error message.
- HTTP response failures still keep their existing `status`, `pathname`, and
  redacted response body details.
- Added operator next action text for `API_NETWORK_ERROR`.
- Extended fatal classification so `timed out` and `timeout` message variants
  both map to `API_TIMEOUT`.
- Updated handoff and probe docs to include timeout and network blocker evidence.

## Files Changed

- `scripts/ops/dingtalk-group-failure-alert-probe.mjs`
- `scripts/ops/dingtalk-group-failure-alert-probe.test.mjs`
- `docs/development/dingtalk-group-failure-alert-142-probe-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-record-scope-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-fatal-summary-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-to-rule-creator-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-final-handoff-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-reachability-diagnostics-development-verification-20260507.md`

## Verification

Syntax check:

```bash
node --check scripts/ops/dingtalk-group-failure-alert-probe.mjs
```

Result: passed.

Targeted probe test:

```bash
node --test scripts/ops/dingtalk-group-failure-alert-probe.test.mjs
```

Result: passed, 21 tests.

New coverage:

- timed out `/api/auth/me` writes `API_TIMEOUT`;
- timeout summary includes `detail.pathname` and `detail.timeoutMs`;
- closed local backend port writes `API_NETWORK_ERROR`;
- network summary includes `detail.pathname`;
- `summary.md` includes the failing API path without exposing tokens.

Targeted backend automation test:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/automation-v1.test.ts --watch=false
```

Result: passed, 143 tests.

Scoped diff check:

```bash
git diff --check -- scripts/ops/dingtalk-group-failure-alert-probe.mjs scripts/ops/dingtalk-group-failure-alert-probe.test.mjs packages/core-backend/tests/unit/automation-v1.test.ts docs/development/dingtalk-group-failure-alert-142-probe-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-probe-record-scope-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-probe-fatal-summary-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-to-rule-creator-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-final-handoff-20260507.md docs/development/dingtalk-group-failure-alert-probe-reachability-diagnostics-development-verification-20260507.md
```

Result: passed.

Secret scan:

```bash
rg -l "SEC[A-Za-z0-9]{20,}|access_token=[0-9a-f]{20,}|https://oapi\\.dingtalk\\.com/robot/send\\?access_token=[0-9a-f]|eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}" scripts/ops/dingtalk-group-failure-alert-probe.mjs scripts/ops/dingtalk-group-failure-alert-probe.test.mjs packages/core-backend/tests/unit/automation-v1.test.ts docs/development/dingtalk-group-failure-alert-142-probe-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-probe-record-scope-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-probe-fatal-summary-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-to-rule-creator-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-final-handoff-20260507.md docs/development/dingtalk-group-failure-alert-probe-reachability-diagnostics-development-verification-20260507.md
```

Result: no matches.

## Operator Impact

- If the backend is slow, `summary.md` now tells which API path timed out and
  what timeout value was used.
- If the backend host or port is unreachable, `summary.md` now reports
  `API_NETWORK_ERROR` with the failing API path.
- Operators can attach the blocked `summary.md` to the 142 acceptance packet
  instead of losing evidence when the probe exits non-zero.

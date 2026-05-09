# DingTalk P4 Final Input Blocked Count Verification

- Date: 2026-04-29
- Branch: `codex/dingtalk-final-input-blocked-count-20260429`
- Result: pass

## Commands

```bash
node --check scripts/ops/dingtalk-p4-final-input-status.mjs
node --check scripts/ops/dingtalk-p4-final-input-status.test.mjs
node --test scripts/ops/dingtalk-p4-final-input-status.test.mjs
```

Synthetic CLI snapshot:

```bash
node scripts/ops/dingtalk-p4-final-input-status.mjs \
  --env-file "$TMP_ENV" \
  --output-json "$TMP_OUT/summary.json" \
  --output-md "$TMP_OUT/summary.md" \
  --allow-blocked
node -e 'assert blockedInputCount matches missingInputs length and Markdown count'
```

Repository hygiene:

```bash
git diff --check
git diff origin/main...HEAD -- \
  scripts/ops/dingtalk-p4-final-input-status.mjs \
  scripts/ops/dingtalk-p4-final-input-status.test.mjs \
  docs/development/dingtalk-p4-final-input-blocked-count-design-20260429.md \
  docs/development/dingtalk-p4-final-input-blocked-count-verification-20260429.md \
  | rg -v "rg -n" \
  | rg -n "(access_token=[A-Za-z0-9]|SEC[0-9a-fA-F]{8,}|Authorization:|Bearer [A-Za-z0-9._-]{20,}|https://oapi\\.dingtalk\\.com/robot/send|JWT_SECRET|DINGTALK_APP_SECRET|publicToken=[A-Za-z0-9._~+/=-]{12,})"
```

## Actual Results

- Syntax check passed for the script.
- Syntax check passed for the test file.
- Node test runner passed 5/5 tests.
- Synthetic blocked snapshot returned `blockedInputCount=6`.
- Synthetic Markdown contained the same `Blocked Input Count` value.
- No real webhook URL, robot signing secret, app token, public form token, or temporary password is stored in this document.

## Non-Run Items

- Real 142 release-readiness was not run from this slice.
- Real DingTalk smoke was not started.
- Private env outputs were not committed.

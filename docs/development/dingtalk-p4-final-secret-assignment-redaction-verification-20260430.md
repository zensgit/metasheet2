# DingTalk P4 Final Secret Assignment Redaction Verification

## Commands

```bash
node --check scripts/ops/dingtalk-p4-final-handoff.mjs
node --check scripts/ops/dingtalk-p4-final-docs.mjs
node --check scripts/ops/dingtalk-p4-final-closeout.mjs
node --check scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs
node --check scripts/ops/dingtalk-p4-final-handoff.test.mjs
node --check scripts/ops/dingtalk-p4-final-docs.test.mjs
node --check scripts/ops/dingtalk-p4-final-closeout.test.mjs
node --check scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs
node --test scripts/ops/dingtalk-p4-final-handoff.test.mjs scripts/ops/dingtalk-p4-final-docs.test.mjs scripts/ops/dingtalk-p4-final-closeout.test.mjs scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs
git diff --check
rg -n "DINGTALK_CLIENT_SECRET = [^<]" \
  scripts/ops/dingtalk-p4-final-handoff.mjs \
  scripts/ops/dingtalk-p4-final-docs.mjs \
  scripts/ops/dingtalk-p4-final-closeout.mjs \
  scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs \
  docs/development/dingtalk-p4-final-secret-assignment-redaction-design-20260430.md \
  docs/development/dingtalk-p4-final-secret-assignment-redaction-verification-20260430.md
```

## Result

- All syntax checks passed.
- The targeted finalization test set passed: 36/36.
- `git diff --check` passed.
- The targeted raw-value scan stayed clean for production scripts and the companion docs.

## Residual Risk

This slice validates finalization tool output paths and CLI errors. It does not re-run a live DingTalk smoke session or send real DingTalk robot messages.

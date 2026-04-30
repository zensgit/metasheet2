# DingTalk P4 Smoke Secret Assignment Redaction Verification

## Commands

```bash
node --check scripts/ops/dingtalk-p4-remote-smoke.mjs
node --check scripts/ops/dingtalk-p4-smoke-session.mjs
node --check scripts/ops/dingtalk-p4-remote-smoke.test.mjs
node --check scripts/ops/dingtalk-p4-smoke-session.test.mjs
node --test scripts/ops/dingtalk-p4-remote-smoke.test.mjs scripts/ops/dingtalk-p4-smoke-session.test.mjs
git diff --check
rg -n "DINGTALK_CLIENT_SECRET = [^<]" \
  scripts/ops/dingtalk-p4-remote-smoke.mjs \
  scripts/ops/dingtalk-p4-smoke-session.mjs
```

## Expected Result

- All `node --check` commands pass.
- The paired smoke test files pass.
- `git diff --check` is clean.
- The targeted scan stays clean for the production smoke scripts, proving this slice does not add a raw secret to operator-facing output paths.

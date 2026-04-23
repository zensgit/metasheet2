# DingTalk P4 Env Bootstrap Verification

- Date: 2026-04-23
- Branch: `codex/dingtalk-p4-env-bootstrap-20260423`

## Commands Run

```bash
node --test scripts/ops/dingtalk-p4-env-bootstrap.test.mjs

node --test \
  scripts/ops/dingtalk-p4-env-bootstrap.test.mjs \
  scripts/ops/dingtalk-p4-smoke-preflight.test.mjs \
  scripts/ops/dingtalk-p4-smoke-session.test.mjs

git diff --check
```

## Results

- Env bootstrap tests: pass, 4 tests.
- Bootstrap plus adjacent P4 preflight/session regression: pass, 15 tests.
- Full DingTalk P4 ops regression suite: pass, 86 tests.
- `git diff --check`: pass.

## Covered Cases

- Private env template creation uses POSIX mode `0600` and refuses accidental overwrite without `--force`.
- Missing readiness inputs fail with redacted JSON/Markdown reports.
- Complete env readiness passes and derives `authorizedUserId` from the allowlist when not explicitly set.
- Group/world-readable env files fail readiness.
- Reports do not include raw bearer tokens, DingTalk robot access tokens, signs, timestamps, or SEC secrets.

## Real External Dependency Status

- Real 142/staging DingTalk P4 smoke was not executed in this slice.
- Blocking input remains the real private env file:
  - `$HOME/.config/yuantus/dingtalk-p4-staging.env`
  - DingTalk robot webhooks
  - admin/table-owner bearer token
  - authorized and unauthorized DingTalk-bound local users
  - no-email DingTalk external account target

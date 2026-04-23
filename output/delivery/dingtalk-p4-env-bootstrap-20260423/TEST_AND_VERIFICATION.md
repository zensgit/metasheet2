# TEST AND VERIFICATION - DingTalk P4 Env Bootstrap

## Summary

Added a local ops helper that prepares and checks the private DingTalk P4 staging env file before the final 142/staging remote smoke.

This closes the current practical gap: the product stack is merged, but the real smoke should not start until the required private robot, token, and manual target inputs are present and redacted reports show readiness.

## Files

- `scripts/ops/dingtalk-p4-env-bootstrap.mjs`
- `scripts/ops/dingtalk-p4-env-bootstrap.test.mjs`
- `docs/development/dingtalk-p4-env-bootstrap-development-20260423.md`
- `docs/development/dingtalk-p4-env-bootstrap-verification-20260423.md`

## Verification

| Gate | Result |
| --- | --- |
| Env bootstrap Node tests | 4/4 passed |
| Bootstrap + adjacent P4 preflight/session tests | 15/15 passed |
| Full DingTalk P4 ops regression suite | 86/86 passed |
| `git diff --check` | passed |

## Commands

```bash
node --test scripts/ops/dingtalk-p4-env-bootstrap.test.mjs

node --test \
  scripts/ops/dingtalk-p4-env-bootstrap.test.mjs \
  scripts/ops/dingtalk-p4-smoke-preflight.test.mjs \
  scripts/ops/dingtalk-p4-smoke-session.test.mjs

git diff --check
```

## Real Smoke Status

Real DingTalk/142 remote smoke was not run because the private P4 env is still absent. The next operator step is:

```bash
node scripts/ops/dingtalk-p4-env-bootstrap.mjs --init
```

Then fill `$HOME/.config/yuantus/dingtalk-p4-staging.env` outside git and run:

```bash
node scripts/ops/dingtalk-p4-env-bootstrap.mjs --check
```

Only after readiness is `pass`, run the final smoke session with `--require-manual-targets`.

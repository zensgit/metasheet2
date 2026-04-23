# DingTalk P4 Env Safe Set - Test And Verification

- Date: 2026-04-23
- Branch: `codex/dingtalk-p4-env-safe-set-20260423`
- Scope: safe private-env update support for DingTalk P4 staging smoke

## Development Summary

- Added `--set`, `--set-from-env`, and `--unset` to `scripts/ops/dingtalk-p4-env-bootstrap.mjs`.
- Updates are restricted to known DingTalk P4 env keys.
- The private env file is always rewritten as `0600`.
- Secret update output is redacted; list fields report counts only.

## Verification

- `node --check scripts/ops/dingtalk-p4-env-bootstrap.mjs`: pass.
- `node --check scripts/ops/dingtalk-p4-env-bootstrap.test.mjs`: pass.
- `node --test scripts/ops/dingtalk-p4-env-bootstrap.test.mjs`: 6/6 pass.
- `node --test scripts/ops/dingtalk-p4-env-bootstrap.test.mjs scripts/ops/dingtalk-p4-release-readiness.test.mjs`: 12/12 pass.
- Temporary safe-set smoke reached readiness pass and did not print test secret strings.
- Real `$HOME/.config/yuantus/dingtalk-p4-staging.env` remains fail-closed because required values are blank.

## Next Step

Fill the private env with real staging values using `--set-from-env` for secrets, then run:

```bash
node scripts/ops/dingtalk-p4-release-readiness.mjs \
  --p4-env-file "$HOME/.config/yuantus/dingtalk-p4-staging.env" \
  --regression-profile ops
```

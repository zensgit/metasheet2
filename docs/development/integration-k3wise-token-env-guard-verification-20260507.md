# K3 WISE Smoke Token Env Guard Verification

## Commands

```bash
bash -n scripts/ops/resolve-k3wise-smoke-token.sh
node --test scripts/ops/resolve-k3wise-smoke-token.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
git diff --check
```

## Local Result

- `bash -n scripts/ops/resolve-k3wise-smoke-token.sh`: passed.
- `node --test scripts/ops/resolve-k3wise-smoke-token.test.mjs`: 10/10 passed.
- `node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs`:
  2/2 passed.
- `git diff --check`: passed.

## Covered Cases

The resolver test suite now covers:

- configured compact JWT writes to `GITHUB_ENV` through guarded heredoc syntax;
- configured token payload containing newline / env-file injection text is
  rejected before `::add-mask::` or `GITHUB_ENV` writes;
- invalid `K3_WISE_TOKEN_OUTPUT_ENV` names are rejected before token export;
- multiline tenant scopes are rejected before token export;
- optional no-input mode still exits zero with a warning;
- required no-tenant mode still fails;
- deploy-host singleton tenant auto-discovery still writes both tenant and token;
- tenant auto-discovery disabled mode still keeps the previous skip reason;
- optional and required missing SSH fallback behavior is unchanged.

## Residual Risk

This is an offline resolver hardening slice. It does not run a live deploy-host
SSH token mint. The existing fake-SSH test still exercises the command boundary
and `GITHUB_ENV` output contract without contacting production infrastructure.

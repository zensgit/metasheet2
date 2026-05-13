# K3 WISE Smoke Token Temp Key Refresh Verification

Date: 2026-05-12
Branch: `codex/k3wise-smoke-token-temp-key-refresh-20260513`
Base: `origin/main@f8bc09865`

## Commands

```bash
bash -n scripts/ops/resolve-k3wise-smoke-token.sh
node --test scripts/ops/resolve-k3wise-smoke-token.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
pnpm verify:integration-k3wise:poc
git diff --check
```

## Results

- `bash -n scripts/ops/resolve-k3wise-smoke-token.sh`: pass
- `node --test scripts/ops/resolve-k3wise-smoke-token.test.mjs`: 11/11 pass
- `node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs`: 2/2 pass
- `pnpm verify:integration-k3wise:poc`: preflight 20/20 pass, evidence 37/37 pass, mock PoC chain PASS
- `git diff --check`: pass

## Coverage Notes

- Configured-token path still writes a compact JWT through the safe
  `K3WISE_ENV_EOF` heredoc delimiter.
- Malicious configured-token newline payload still fails before `::add-mask::`.
- Invalid GitHub env output name still fails before writing.
- Multiline tenant scope still fails before writing.
- Deploy-host fallback now proves:
  - SSH receives `-i <tmp>/k3wise-smoke-ssh-key.*`.
  - The key file exists while fake SSH runs.
  - The key file mode is `0600`.
  - The key file is removed before the resolver process exits.
  - No `~/.ssh/deploy_key` file is created.

## PR Queue Impact

This refresh supersedes the useful part of PR #1327 without reintroducing the
older branch's GitHub env safety regressions.

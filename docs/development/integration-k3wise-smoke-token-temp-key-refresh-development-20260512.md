# K3 WISE Smoke Token Temp Key Refresh Development

Date: 2026-05-12
Branch: `codex/k3wise-smoke-token-temp-key-refresh-20260513`
Base: `origin/main@f8bc09865`

## Context

PR #1327 proposed using a temporary SSH private key for the K3 WISE smoke token
resolver, but its branch predates current `main` hardening for compact JWT
validation, tenant single-line validation, GitHub env heredoc delimiters, and
safe output-name validation.

This refresh keeps the current `main` safety behavior and applies only the
durable part of #1327: deploy-host fallback no longer writes
`~/.ssh/deploy_key`.

## Changes

- `scripts/ops/resolve-k3wise-smoke-token.sh`
  - Decode `DEPLOY_SSH_KEY_B64` into `mktemp` under `${TMPDIR:-/tmp}`.
  - Set the temporary key mode to `0600`.
  - Pass SSH options as a bash array so the temporary key path is quoted.
  - Install an `EXIT` trap that removes the key after fallback execution or
    failure.
  - Preserve current compact-JWT and GitHub env export guards unchanged.

- `scripts/ops/resolve-k3wise-smoke-token.test.mjs`
  - Assert the deploy-host fallback does not use or create
    `~/.ssh/deploy_key`.
  - Add a regression test that the temporary key exists during fake SSH
    execution, has mode `0600`, and is deleted after resolver exit.

## Non-Goals

- No changes to token minting semantics inside the remote backend container.
- No changes to tenant auto-discovery behavior.
- No changes to postdeploy smoke evidence/signoff gates.


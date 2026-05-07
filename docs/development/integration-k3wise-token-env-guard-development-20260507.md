# K3 WISE Smoke Token Env Guard Development

## Context

`scripts/ops/resolve-k3wise-smoke-token.sh` resolves the bearer token used by
the K3 WISE postdeploy smoke. It supports two paths:

- use `METASHEET_K3WISE_SMOKE_TOKEN_SECRET` /
  `METASHEET_K3WISE_SMOKE_TOKEN` when a configured token exists;
- otherwise mint a short-lived JWT from the deploy-host backend runtime.

Both paths export values into `GITHUB_ENV` for later workflow steps. Before this
change, the configured-token path used a fixed `EOF` heredoc delimiter and the
resolved tenant was written as a simple `NAME=value` line. That made the GitHub
env-file boundary depend on operator-provided values.

## Change

The resolver now uses one guarded env-file writer for every exported value:

- validates env variable names with `^[A-Za-z_][A-Za-z0-9_]*$`;
- writes values with a collision-checked heredoc delimiter;
- exports `K3_WISE_SMOKE_TENANT_ID` through the same guarded path as the token;
- rejects multiline tenant scopes before anything is exported;
- accepts configured smoke tokens only when they are compact JWT-shaped values,
  matching the deploy-host fallback extraction contract.

Logs keep the existing operator-visible source messages, but multiline tenant
values are flattened before display so CI logs cannot be split by an input
value.

## Scope

Changed files:

- `scripts/ops/resolve-k3wise-smoke-token.sh`
- `scripts/ops/resolve-k3wise-smoke-token.test.mjs`

No workflow YAML, plugin runtime code, K3 adapter code, database schema, or
frontend code is changed.

## Follow-Up

The parallel adapter audit found a separate K3 WebAPI relative-path issue:
protocol-relative paths such as `//example.test/K3API/Login` should be rejected.
That should land after the already-open WebAPI adapter PRs, because PR #1352
currently touches the same adapter and test files.

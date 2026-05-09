# K3 WISE Postdeploy Env Check - Design

Date: 2026-05-06
Branch: `codex/k3wise-postdeploy-env-check-20260506`

## Goal

Add a small pre-smoke gate for physical-machine K3 WISE deployment testing.

The existing postdeploy smoke validates the deployed MetaSheet app over HTTP:

- `/api/health`
- `/api/integration/health`
- `/integrations/k3-wise`
- authenticated integration route contract
- staging descriptor contract

That is the right smoke boundary, but it means input mistakes such as a missing token file, invalid base URL, bad `require_auth` boolean, or empty tenant scope are only discovered when the smoke step is already running.

This slice adds a local input check that runs before the smoke and writes its own JSON/Markdown artifact.

## Implementation

Files changed:

- `scripts/ops/integration-k3wise-postdeploy-env-check.mjs`
- `scripts/ops/integration-k3wise-postdeploy-env-check.test.mjs`
- `scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs`
- `.github/workflows/integration-k3wise-postdeploy-smoke.yml`
- `.github/workflows/docker-build.yml`
- `package.json`

## Checks

The new script validates only local inputs. It does not contact a deployment host or call MetaSheet APIs.

It checks:

- `baseUrl`: required, valid `http`/`https`, no inline credentials, no query/hash.
- `timeoutMs`: positive integer.
- auth mode: `REQUIRE_AUTH` / `K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH` boolean parsing, including common English and Chinese operator values such as `yes`/`no`, `on`/`off`, `是`/`否`, `启用`/`禁用`, `开启`/`关闭`.
- token source: inline env token, `--auth-token`, or `--token-file`.
- token file: exists, is a file, trim result is non-empty.
- tenant scope: pass when supplied, warn when optional and absent, fail when `--require-tenant`.
- smoke output path: included in the generated next command.

Secret handling:

- Output reports token source and token length only.
- Markdown and stdout redact token-like strings.
- Rejected base URLs are also redacted before they are written to JSON or Markdown. Inline URL credentials and secret-like query values such as `token`, `secret`, `password`, `apiKey`, `authorization`, `jwt`, and `sessionId` never appear in the report.
- The generated next command never prints the raw token.

## Workflow Wiring

Manual workflow:

1. Resolve K3 smoke token.
2. Run input check.
3. Run smoke only when input check passed.
4. Always render input-check and smoke evidence summaries.
5. Fail final gate if token resolution, input check, or smoke failed.

Deploy workflow:

1. Resolve K3 smoke token after remote deploy succeeds.
2. Run input check.
3. Run smoke only when input check succeeded.
4. Render input-check Markdown before smoke summary.
5. Upload both input-check and smoke artifacts under `output/deploy/**`.

## Non-Goals

- Does not validate live K3 WISE, PLM, or SQL Server connectivity.
- Does not infer customer GATE answers.
- Does not replace `integration-k3wise-postdeploy-smoke.mjs`.
- Does not write customer secrets into reports.

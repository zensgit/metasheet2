# K3 WISE Postdeploy URL Secret Guard Development - 2026-05-07

## Context

`integration-k3wise-postdeploy-smoke.mjs` writes the tested base URL into stdout, JSON evidence, Markdown evidence, and GitHub summary output. The smoke script already avoids printing bearer tokens, but an operator could still paste a base URL that contains username/password material, query parameters such as `access_token`, or a fragment.

That would make otherwise safe postdeploy evidence carry URL-secret material.

## Design

- Reject `--base-url` values that contain username or password material.
- Reject `--base-url` values that contain query parameters.
- Reject `--base-url` values that contain a fragment.
- Keep error details actionable by returning the field name and query keys, not query values.
- Redact legacy evidence display in `integration-k3wise-postdeploy-summary.mjs` so old JSON with unsafe `baseUrl` does not leak into GitHub summaries.

## Files Changed

- `scripts/ops/integration-k3wise-postdeploy-smoke.mjs`
- `scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs`
- `scripts/ops/integration-k3wise-postdeploy-summary.mjs`
- `scripts/ops/integration-k3wise-postdeploy-summary.test.mjs`

## Behavior

- Clean `http://` and `https://` base URLs still work.
- Base URLs with credentials fail before any request is made.
- Base URLs with query strings fail before any request is made.
- Summary rendering strips credentials and redacts query/fragment display for old evidence files.


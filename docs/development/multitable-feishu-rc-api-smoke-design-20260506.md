# Multitable Feishu RC API Smoke Design - 2026-05-06

## Status

- Branch: `codex/multitable-rc-staging-api-smoke-20260506`
- Scope: add an executable API-layer staging smoke helper for the Feishu-parity RC checklist.
- Non-goal: replace browser/manual verification for XLSX UI, formula editor, filter builder UI, Gantt, hierarchy, and visual styling.

## Problem

The RC staging checklist is intentionally manual. That is correct for UI coverage, but it leaves every deploy with the same repeatable API questions:

- Is staging running and reachable?
- Is the tester token valid?
- Are multitable templates present?
- Can the backend create the Feishu-parity field types and persist values?
- Does record patch still go through expected-version write semantics?
- Does conditional formatting config persist through the view API?
- Does public form sharing still allow unauthenticated submit with a valid public token?

Those checks should be executable before a human spends 30-60 minutes on browser smoke.

## Implementation

Added `scripts/ops/multitable-feishu-rc-api-smoke.mjs`.

The script uses only Node built-ins plus the existing `scripts/multitable-auth.mjs` token helper. It writes:

- `report.json`
- `report.md`

Default output path:

```bash
output/multitable-feishu-rc-api-smoke/<timestamp>/
```

## Safety Gates

The runner refuses to run unless all required staging-safety inputs are present:

- `API_BASE` or `BASE_URL`
- `AUTH_TOKEN` or `TOKEN`, unless `ALLOW_DEV_TOKEN=1`
- `CONFIRM_WRITE=1`
- either `SMOKE_SHEET_ID` or `ALLOW_INSTALL=1`

`ALLOW_INSTALL=1` installs the `project-tracker` template into a unique base and runs the smoke against that isolated sheet. If `SMOKE_SHEET_ID` is provided, the script uses that sheet instead.

The script records token source only. It never writes bearer tokens or public form tokens to the JSON or Markdown report.

## Covered Checks

- `api.health`: probes `/api/health`, then `/health` fallback.
- `api.auth.me`: validates the bearer token against `/api/auth/me`.
- `api.integration-staging.descriptors`: optional probe for integration-core staging descriptors; unavailable plugin is reported as skipped, not failed.
- `api.templates.list`: verifies the target template exists.
- `api.templates.install` or `api.context.smoke-sheet`: resolves a writable sheet.
- `api.fields.batch-types`: creates currency, percent, rating, URL, email, phone, barcode, location, dateTime, and multiSelect fields.
- `api.records.create`: writes one record with representative values for all created field types.
- `api.records.patch.expected-version`: patches the record with `expectedVersion`.
- `api.views.conditional-formatting`: creates a grid view with a persisted conditional formatting rule.
- `api.public-form.submit`: creates a public form view, enables public share, loads form context, and submits an unauthenticated record.

## Deferred Manual Coverage

These remain in the manual staging checklist:

- XLSX import/export through the browser modal and toolbar.
- Formula editor token insertion, function catalog, and diagnostics.
- Filter builder typed controls.
- Gantt and hierarchy view rendering/interaction.
- Visual conditional-formatting behavior after reload.
- Automation `send_email` delivery/provider behavior.

## Staging Command

```bash
API_BASE="https://staging.example.com" \
AUTH_TOKEN="<redacted>" \
CONFIRM_WRITE=1 \
ALLOW_INSTALL=1 \
EXPECTED_COMMIT="<deployed-main-sha>" \
pnpm verify:multitable-feishu-rc:api-smoke
```

For an existing scratch sheet:

```bash
API_BASE="https://staging.example.com" \
AUTH_TOKEN="<redacted>" \
CONFIRM_WRITE=1 \
SMOKE_SHEET_ID="sheet_xxx" \
pnpm verify:multitable-feishu-rc:api-smoke
```

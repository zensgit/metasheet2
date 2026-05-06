# Multitable Feishu RC 142 API Smoke Design - 2026-05-06

## Status

- Branch: `codex/multitable-rc-142-api-smoke-result-20260506`
- Target: `http://142.171.239.56:8081`
- Runner: `scripts/ops/multitable-feishu-rc-api-smoke.mjs`
- Expected commit recorded for evidence: `aec377f80`
- Scope: real remote API smoke execution and evidence archival.

## Purpose

After #1359 added the executable API smoke gate, the next step was to run it against the real 142 staging deployment and archive the result in source-controlled docs.

The goal is to turn the first part of the staging checklist into repeatable evidence before browser/manual smoke starts.

## Execution Model

The runner was executed locally against the remote 142 API:

```bash
AUTH_TOKEN="$(cat /tmp/metasheet-142-main-admin-72h.jwt)" \
API_BASE="http://142.171.239.56:8081" \
CONFIRM_WRITE=1 \
ALLOW_INSTALL=1 \
EXPECTED_COMMIT="aec377f80" \
OUTPUT_DIR="output/multitable-feishu-rc-api-smoke/142-$(date +%Y%m%d-%H%M%S)" \
node scripts/ops/multitable-feishu-rc-api-smoke.mjs
```

Safety properties:

- The token was supplied from a local file and was not printed.
- The report records only `userHash`; no bearer token or public form token is stored in docs.
- `CONFIRM_WRITE=1` was explicit because this creates real staging data.
- `ALLOW_INSTALL=1` was explicit because the smoke installs a fresh `project-tracker` template base.

## Remote Checks Covered

- Health endpoint reachability.
- Auth token validation through `/api/auth/me`.
- Integration staging descriptor endpoint.
- Template library list.
- `project-tracker` template install.
- Batch field creation for Feishu-parity field types.
- Record create with representative values.
- Record patch using `expectedVersion`.
- Conditional-formatting rule persistence through view creation.
- Public form share/context/submit path.

## Data Created

The smoke created a dedicated template base and sheet:

- Base ID: `base_b29d7ffc-1f07-4102-93ce-101c38b188c8`
- Sheet ID: `sheet_613cdb67f0e98fcbd88ce09c`
- Template ID: `project-tracker`

The created data is intentionally left on staging as audit evidence. It can be removed manually if staging data cleanup is required.

## Non-Goals

This remote API smoke does not close browser-only items:

- XLSX import/export UI.
- Formula editor UI.
- Filter builder UI.
- Gantt and hierarchy rendering.
- Visual conditional-formatting behavior.
- Automation `send_email` delivery/provider behavior.


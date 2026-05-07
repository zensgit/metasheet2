# Multitable Feishu RC XLSX UI Smoke Verification - 2026-05-06

## Summary

Result: PASS.

The existing Playwright staging smoke now covers a real XLSX UI import/export round trip. The final 142 run passed `130/130` checks with no failures.

## Local Gates

Commands:

```bash
node --check scripts/verify-multitable-live-smoke.mjs
node --test scripts/verify-multitable-live-smoke.test.mjs scripts/ops/multitable-pilot-staging.test.mjs
```

Result:

- `node --check`: pass
- `node --test`: 2/2 pass

## 142 Staging Verification

Command:

```bash
AUTH_TOKEN="$(cat /tmp/metasheet-142-main-admin-72h.jwt)" \
API_BASE="http://142.171.239.56:8081" \
WEB_BASE="http://142.171.239.56:8081" \
OUTPUT_ROOT="output/playwright/multitable-feishu-rc-142-xlsx-ui-smoke/$(date +%Y%m%d-%H%M%S)" \
HEADLESS=true \
ENSURE_PLAYWRIGHT=false \
TIMEOUT_MS=45000 \
pnpm verify:multitable-pilot:staging
```

The token value was not printed or committed.

Final report:

- Directory: `/private/tmp/ms2-rc-smoke-next-20260506/output/playwright/multitable-feishu-rc-142-xlsx-ui-smoke/20260506-171537`
- JSON: `report.json`
- Markdown: `report.md`
- Overall: PASS
- Total checks: `130`
- Failing checks: none
- Started: `2026-05-07T00:15:37.951Z`
- Finished: `2026-05-07T00:17:10.107Z`

XLSX checks:

| Check | Result | Evidence |
| --- | --- | --- |
| `ui.xlsx.import-file` | PASS | Imported row `PilotFlow-1778112942622 xlsx import` hydrated via API/search as `rec_bb60e88a-7f40-4509-90dd-e4e6b931c807`. |
| `ui.xlsx.export-download` | PASS | Downloaded `sheet_multitable_pilot_smoke.xlsx`, size `20373` bytes, parsed `2` rows, contained the imported title. |

## Runner Fixes During Verification

Two runner issues were found and fixed before the final pass:

- The runner initially clicked `Preview` immediately after `setInputFiles(...)`; XLSX file reading is asynchronous, so the button could still be disabled.
- After adding an enabled wait, the runner still timed out because XLSX files do not use the CSV Preview flow. Current UI semantics parse XLSX and navigate directly to preview/mapping. The final runner waits for the mapping preview text instead.

## Artifact Policy

The generated XLSX input, downloaded XLSX output, screenshots, and runner reports remain local artifacts under `output/playwright/...`. They are intentionally not committed.

Committed evidence is limited to:

- runner code
- this design/verification pair
- the RC TODO update

## Remaining Manual Coverage

This closes the XLSX UI import/export smoke item only. Remaining Phase 1 manual/executable coverage:

- field types: currency, percent, rating, url, email, phone, longText, multiSelect
- conditional formatting persistence and reload
- formula editor
- filter builder
- Gantt view
- Hierarchy view
- public form submit
- automation `send_email`

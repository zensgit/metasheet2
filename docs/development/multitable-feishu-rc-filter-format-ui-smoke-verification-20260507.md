# Multitable Feishu RC Filter And Formatting UI Smoke Verification - 2026-05-07

## Scope

Verify the runner-only filter builder and conditional formatting smoke coverage added to `scripts/verify-multitable-live-smoke.mjs`.

## Local Static Checks

Run from `/private/tmp/ms2-rc-filter-format-smoke-20260507`.

```bash
pnpm install --frozen-lockfile --ignore-scripts
node --check scripts/verify-multitable-live-smoke.mjs
node --test scripts/verify-multitable-live-smoke.test.mjs
```

Result:

- `node --check`: pass
- `node --test scripts/verify-multitable-live-smoke.test.mjs`: `1/1` pass

## 142 Staging Smoke

Command shape, with token redacted:

```bash
AUTH_TOKEN="<redacted>" \
API_BASE=http://142.171.239.56:8081 \
WEB_BASE=http://142.171.239.56:8081 \
OUTPUT_ROOT=output/playwright/multitable-feishu-rc-filter-format-smoke/20260506-180129 \
ENSURE_PLAYWRIGHT=false \
HEADLESS=true \
TIMEOUT_MS=45000 \
pnpm verify:multitable-pilot:staging
```

Result:

- Overall: pass
- Total checks: `140/140`
- Report JSON: `output/playwright/multitable-feishu-rc-filter-format-smoke/20260506-180129/report.json`
- Report MD: `output/playwright/multitable-feishu-rc-filter-format-smoke/20260506-180129/report.md`

New check evidence:

- `ui.filter-builder.typed-controls-replay`: pass
  - Controls covered: select, date input, number input.
  - Persisted conditions: `Status is Todo`, `Start is 2026-03-10`, `Score greater 90`.
  - Reload replay: `3` rules rehydrated and retry row remained hidden.
- `ui.conditional-formatting.reload-replay`: pass
  - Persisted rule: temporary `Score` field, `gt 90`, `#d6ebff`, apply to row.
  - Reload render: row background computed as `rgb(214, 235, 255)`.
  - Dialog reload: field/operator/value/apply-to-row state rehydrated.

Cleanup evidence:

- Temporary imported records were deleted.
- Temporary attachments were deleted.
- Temporary fields, including the `Score <run>` number field, were deleted.
- The smoke restored the original grid `filterInfo` and `config` after the focused checks.

## Runner Hardening During Verification

Three live-runner issues were found and fixed before the final pass:

- Existing people repair picker could time out when exact generated-ID search returned empty; fixed by adding a first-option fallback and using the actual selected display value in downstream assertions.
- Conditional-formatting color swatch click could be intercepted during overlay reflow; fixed by writing the hex input directly.
- Filter date/number input values did not persist reliably because the component listens on `change`; fixed by dispatching `change` after Playwright `fill()`.

## TODO Linkage

This verification closes these RC TODO items:

- `Smoke test conditional formatting persistence and reload.`
- `Smoke test filter builder typed controls and saved view behavior.`

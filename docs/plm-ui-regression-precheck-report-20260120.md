# PLM UI Regression Precheck + Failure Artifacts (2026-01-20)

## Summary
- Added PLM health precheck before running UI automation.
- Waits for product detail responses after search selection and manual load.
- Captures error screenshot + last PLM response snapshot when the regression fails.

## Changes
- `scripts/verify-plm-ui-regression.sh`
  - `check_plm_health()` verifies `/api/v1/health` (fallback `/health`).
  - `waitForProductResponse()` waits for `/api/federation/plm/products/{id}` GET.
  - Failure handling writes `plm-ui-regression-*-error.png` and `plm-ui-regression-last-response-*.json`.
  - Report includes run status + error artifact paths.

## Verification
- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 bash scripts/verify-plm-ui-full.sh`
  - Reports:
    - `docs/verification-plm-ui-regression-20260120_163900.md`
    - `docs/verification-plm-ui-full-20260120_163900.md`
  - Artifacts:
    - `artifacts/plm-ui-regression-20260120_163900.png`
    - `artifacts/plm-bom-tools-20260120_163900.json`
    - `artifacts/plm-bom-tools-20260120_163900.md`

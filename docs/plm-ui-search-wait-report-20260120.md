# PLM UI Search Wait Enhancement (2026-01-20)

## Summary
- Added a network response wait for the PLM search request to prevent reading the table before results finish loading.
- Keeps regression flow stable when the backend response is slightly delayed.

## Changes
- `scripts/verify-plm-ui-regression.sh`
  - Waits for `/api/federation/plm/query` response with `operation:"products"` before reading search rows.

## Verification
- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 bash scripts/verify-plm-ui-full.sh`
  - Reports:
    - `docs/verification-plm-ui-regression-20260120_155920.md`
    - `docs/verification-plm-ui-full-20260120_155920.md`
  - Artifacts:
    - `artifacts/plm-ui-regression-20260120_155920.png`
    - `artifacts/plm-bom-tools-20260120_155920.json`
    - `artifacts/plm-bom-tools-20260120_155920.md`

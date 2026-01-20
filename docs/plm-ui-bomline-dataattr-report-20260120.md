# PLM UI BOM Line Data Attribute (2026-01-20)

## Goal
Expose BOM line IDs in the BOM table markup so regression can read the value without relying on column order.

## Changes
- Added `data-bom-line-id` to the BOM 行 ID table cell in `PlmProductView.vue`.
- Regression fallback now reads the BOM line ID from the attribute, with header lookup as a fallback.

## Verification
- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 bash scripts/verify-plm-ui-full.sh`
- Reports:
  - `docs/verification-plm-ui-regression-20260120_120059.md`
  - `docs/verification-plm-ui-full-20260120_120059.md`

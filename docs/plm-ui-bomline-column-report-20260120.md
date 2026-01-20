# PLM UI Regression BOM Line Column Lookup (2026-01-20)

## Goal
Make BOM line fallback resilient to table column order changes by locating the "BOM 行 ID" column from the header.

## Changes
- Added helper to resolve column index by header label.
- Fallback now reads BOM line ID from the resolved column and first line of the cell.

## Verification
- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 bash scripts/verify-plm-ui-full.sh`
- Reports:
  - `docs/verification-plm-ui-regression-20260120_115453.md`
  - `docs/verification-plm-ui-full-20260120_115453.md`

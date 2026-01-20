# PLM UI Regression BOM Line Fallback (2026-01-20)

## Goal
Avoid skipping BOM line quick-pick validation when the dropdown has no options by falling back to the first BOM row line ID.

## Changes
- If the BOM line quick-pick select has no options, read the first BOM table row line ID and fill the substitutes BOM line input.
- Keep the existing quick-pick check when options are present.

## Verification
- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 bash scripts/verify-plm-ui-full.sh`
- Reports:
  - `docs/verification-plm-ui-regression-20260120_113641.md`
  - `docs/verification-plm-ui-full-20260120_113641.md`

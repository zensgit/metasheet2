# PLM UI Regression Script Fixes (2026-01-20)

## Goal
Make the PLM UI regression script resilient to BOM find_num leading zeros and cover the new quick-pick inputs.

## Changes
- Normalize BOM find_num tokens before comparison to avoid `010` vs `10` mismatches.
- Use normalized find_num when applying BOM filter in the UI regression flow.
- Add quick-pick checks:
  - Where-Used quick pick fills child ID.
  - BOM Compare left/right quick picks fill IDs.
  - Substitutes BOM line quick pick fills BOM line ID.
  - Substitutes item quick pick fills item ID.

## Verification
- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 PLM_BOM_FIND_NUM=010 bash scripts/verify-plm-ui-full.sh`
- Reports:
  - `docs/verification-plm-ui-regression-20260120_105030.md`
  - `docs/verification-plm-ui-full-20260120_105030.md`

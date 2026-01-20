# PLM UI Full Regression Auto BOM Find Num (2026-01-20)

## Goal
Eliminate manual `PLM_BOM_FIND_NUM` setup by deriving it from the BOM tools seed output.

## Changes
- `scripts/verify-plm-ui-full.sh` now derives `PLM_BOM_FIND_NUM` from the latest BOM tools JSON when unset.
- The derived value prefers the parent/child fixture match and falls back to the first available `find_num`.
- The derived value is passed into `scripts/verify-plm-ui-regression.sh` and recorded in the full regression report.

## Verification
- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 bash scripts/verify-plm-ui-full.sh`
- Reports:
  - `docs/verification-plm-ui-regression-20260120_111536.md`
  - `docs/verification-plm-ui-full-20260120_111536.md`

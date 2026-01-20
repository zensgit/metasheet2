# PLM UI Regression Network Wait Helpers (2026-01-20)

## Goal
Consolidate network wait logic for BOM/Where-Used/Compare/Substitutes into shared helpers.

## Changes
- Added `waitForPlmQueryResponse` and `waitForBomResponse` helpers in the regression script.
- Replaced inline response checks with helper calls for BOM load, where-used, BOM compare, and substitutes.

## Verification
- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 bash scripts/verify-plm-ui-full.sh`
- Reports:
  - `docs/verification-plm-ui-regression-20260120_154958.md`
  - `docs/verification-plm-ui-full-20260120_154958.md`

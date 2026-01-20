# PLM UI Regression Substitutes Network Wait (2026-01-20)

## Goal
Ensure substitutes assertions wait on the PLM API response, reducing flakiness from DOM-only waits.

## Changes
- Added response wait for `/api/federation/plm/query` with `operation=substitutes` before checking table contents.

## Verification
- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 bash scripts/verify-plm-ui-full.sh`
- Reports:
  - `docs/verification-plm-ui-regression-20260120_131712.md`
  - `docs/verification-plm-ui-full-20260120_131712.md`

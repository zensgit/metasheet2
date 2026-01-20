# PLM UI Regression Network Waits (2026-01-20)

## Goal
Make BOM/Where-Used/BOM Compare checks wait on the corresponding PLM API responses instead of only DOM rendering.

## Changes
- Added request matcher for `/api/federation/plm/query` with operation-specific payload checks.
- Where-Used and BOM Compare now wait for their API responses before asserting table content.

## Verification
- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 bash scripts/verify-plm-ui-full.sh`
- Reports:
  - `docs/verification-plm-ui-regression-20260120_122059.md`
  - `docs/verification-plm-ui-full-20260120_122059.md`

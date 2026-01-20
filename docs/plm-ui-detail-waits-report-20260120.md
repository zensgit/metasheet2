# PLM UI Detail Response Waits (2026-01-20)

## Summary
- Added response waits for document and approval queries to reduce flakiness after product detail load.
- Uses current Product ID from the detail panel to scope the waits.

## Changes
- `scripts/verify-plm-ui-regression.sh`
  - Waits for `operation: "documents"` and `operation: "approvals"` responses after clicking refresh.

## Verification
- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 bash scripts/verify-plm-ui-full.sh`
  - Reports:
    - `docs/verification-plm-ui-regression-20260120_165510.md`
    - `docs/verification-plm-ui-full-20260120_165510.md`
  - Artifacts:
    - `artifacts/plm-ui-regression-20260120_165510.png`
    - `artifacts/plm-bom-tools-20260120_165510.json`
    - `artifacts/plm-bom-tools-20260120_165510.md`

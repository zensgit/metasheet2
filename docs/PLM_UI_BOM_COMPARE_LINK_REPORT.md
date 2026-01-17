# PLM UI BOM Compare Link Report

## Scope
- Selecting a BOM compare row auto-syncs Where-Used child and Substitutes BOM line inputs.
- Adds compare row data attributes for verification.
- Provide a toggle to disable the auto-sync behavior.

## UI Updates
- Clicking a compare row populates:
  - Where-Used child input with the selected child key.
  - Substitutes BOM line input with the selected relationship/line id.
- A single status message reports the synced targets.
- "联动 Where-Used / 替代件" checkbox controls whether the auto-sync runs.

## Verification
- Script: `scripts/verify-plm-ui-regression.sh`
- Command: `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7911 scripts/verify-plm-ui-regression.sh`
- Report: `docs/verification-plm-ui-regression-20260118_004053.md`
- Artifact: `artifacts/plm-ui-regression-20260118_004053.png`

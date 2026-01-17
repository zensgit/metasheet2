# PLM UI BOM Highlight Report

## Scope
- Add tree/table row highlight for BOM selections.
- Sync selection across BOM tree and table views.

## UI Updates
- Clicking a BOM tree row highlights the row and the matching table row.
- Clicking a BOM table row highlights the row and the corresponding tree node.
- Selection resets when BOM data reloads.

## Verification
- Script: `scripts/verify-plm-ui-regression.sh`
- Command: `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7911 scripts/verify-plm-ui-regression.sh`
- Report: `docs/verification-plm-ui-regression-20260117_221425.md`
- Artifact: `artifacts/plm-ui-regression-20260117_221425.png`

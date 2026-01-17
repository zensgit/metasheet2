# PLM UI Where-Used Highlight Report

## Scope
- Add tree/table row highlight for where-used selections.
- Sync selection across tree and table views.

## UI Updates
- Clicking a where-used tree row highlights the row and the matching table rows.
- Clicking a where-used table row highlights the row and the corresponding tree node.
- Selection resets when where-used data reloads.

## Verification
- Script: `scripts/verify-plm-ui-regression.sh`
- Command: `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7911 scripts/verify-plm-ui-regression.sh`
- Report: `docs/verification-plm-ui-regression-20260117_224348.md`
- Artifact: `artifacts/plm-ui-regression-20260117_224348.png`

# PLM UI Where-Used Path IDs Report

## Scope
- Added a "路径 ID" quick-copy affordance in both where-used tree and table views.
- Added tooltips that reveal the full path ID chain for each row.

## UI Updates
- where-used tree rows show a "路径 ID" mini button under the relationship ID column.
- where-used table rows add a "路径 ID" column with copy/tooltip.
- Added a bulk copy button in the panel actions to copy all path IDs in table view.
- Added a bulk copy button in the panel actions to copy all tree path IDs.
- Hovering the button displays the full path ID chain.
- Copy action writes the full path IDs chain to the clipboard and confirms with a toast message.

## Data & Behavior
- Path IDs follow the where-used lineage using parent IDs with label fallback.
- Root nodes seed the path with the current where-used root item.
- CSV export adds `path_ids` for where-used rows.
- Filtering supports path ID tokens in table view.
- Copy success message includes the final (leaf) token to keep the toast short.

## Verification
- Script: `scripts/verify-plm-ui-regression.sh`
- Command: `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7911 scripts/verify-plm-ui-regression.sh`
- Report: `docs/verification-plm-ui-regression-20260117_211911.md`
- Artifact: `artifacts/plm-ui-regression-20260117_211911.png`

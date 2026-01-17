# PLM UI BOM Tree Path IDs Report

## Scope
- Added a per-node "路径 ID" quick-copy affordance in the BOM tree.
- Added a tooltip that reveals the full path ID chain for the node.

## UI Updates
- BOM tree rows now show a "路径 ID" mini button under the BOM line ID column.
- Hovering the button displays the full path ID chain.
- Copy action writes the full path IDs chain to the clipboard and confirms with a toast message.
- Added a bulk copy button in the panel actions to copy all tree path IDs.

## Data & Behavior
- Path IDs use the BOM tree row lineage (component ID preferred, fallback to label/key), matching the CSV export `path_ids` column.
- Root nodes seed the path with the current product ID/number.
- Copy success message includes the final (leaf) token to keep the toast short.

## Verification
- Script: `scripts/verify-plm-ui-regression.sh`
- Command: `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7911 scripts/verify-plm-ui-regression.sh`
- Report: `docs/verification-plm-ui-regression-20260117_221425.md`
- Artifact: `artifacts/plm-ui-regression-20260117_221425.png`

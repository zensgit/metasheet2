# PLM UI BOM Table Path IDs Report

## Scope
- Added a "路径 ID" column to the BOM table view.
- Added a tooltip and quick-copy action for path IDs.

## UI Updates
- BOM table rows now include a "路径 ID" column with a mini copy button.
- Hovering the button shows the full path ID chain for the BOM line.
- Copy action writes the full path IDs chain to the clipboard and confirms with a toast message.
- Added a bulk copy button in the panel actions to copy all path IDs in table view.

## Data & Behavior
- Path IDs derive from the BOM tree lineage (line ID preferred, parent/child fallback).
- CSV export (table view) adds a `path_ids` column that matches the UI path IDs.

## Verification
- Script: `scripts/verify-plm-ui-regression.sh`
- Command: `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7911 scripts/verify-plm-ui-regression.sh`
- Report: `docs/verification-plm-ui-regression-20260117_211911.md`
- Artifact: `artifacts/plm-ui-regression-20260117_211911.png`

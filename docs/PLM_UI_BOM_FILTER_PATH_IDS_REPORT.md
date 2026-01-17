# PLM UI BOM Filter Path IDs Report

## Scope
- Allow BOM filter to match path ID tokens in table view.

## UI Updates
- BOM filter now includes `path_ids` tokens in the searchable fields.

## Data & Behavior
- Path IDs are derived from the BOM tree lineage (line ID preferred, parent/child fallback).
- Filtering by the leaf token of a path ID keeps the corresponding BOM row visible.

## Verification
- Script: `scripts/verify-plm-ui-regression.sh`
- Command: `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7911 scripts/verify-plm-ui-regression.sh`
- Report: `docs/verification-plm-ui-regression-20260117_221425.md`
- Artifact: `artifacts/plm-ui-regression-20260117_221425.png`

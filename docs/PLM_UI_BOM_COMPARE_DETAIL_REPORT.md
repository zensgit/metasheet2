# PLM UI BOM Compare Detail Report

## Scope
- Add field-level compare detail for BOM Compare entries.
- Show left/right values with normalized values when they differ.
- Support copying/exporting the field-level table.
- Highlight changed fields for quick scanning.

## UI Updates
- Clicking a compare row (新增/删除/变更) opens a "字段级对照" table.
- Table lists each compare field with left/right values and per-field severity when available.
- Normalized values are shown inline when different from raw values.
- "复制字段对照" and "导出字段对照" support batch reuse.
- Selection is reset when compare data is reloaded.

## Verification
- Script: `scripts/verify-plm-ui-regression.sh`
- Command: `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7911 scripts/verify-plm-ui-regression.sh`
- Report: `docs/verification-plm-ui-regression-20260117_234818.md`
- Artifact: `artifacts/plm-ui-regression-20260117_234818.png`

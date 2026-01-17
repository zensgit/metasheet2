# PLM UI Filter Presets Report

## Scope
- Add field-level filters for BOM and Where-Used.
- Provide reusable filter presets (save/apply/delete/import/export).

## UI Updates
- BOM filter supports field selection (组件编码/ID、名称、BOM 行 ID、Find #、Refdes、路径等).
- Where-Used filter supports field selection (父件、关系 ID、路径、Find #、Refdes 等).
- Preset controls allow saving the current field + value and reapplying later.
- Presets can be exported/imported via JSON (text paste or file).
- Import mode supports merge/replace on preset load.

## Verification
- Script: `scripts/verify-plm-ui-regression.sh`
- Command: `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7911 scripts/verify-plm-ui-regression.sh`
- Report: `docs/verification-plm-ui-regression-20260118_031232.md`
- Artifact: `artifacts/plm-ui-regression-20260118_031232.png`

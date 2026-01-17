# PLM UI Multi-Select Copy Report

## Scope
- Add multi-select for BOM and Where-Used rows.
- Copy selected child/parent IDs in batch.

## UI Updates
- BOM: tree/table row clicks toggle selection; actions include "复制选中子件" and "清空选择" with selection count.
- Where-Used: tree/table row clicks toggle selection; actions include "复制选中父件" and "清空选择" with selection count.
- Selection resets when BOM/Where-Used data reloads.

## Verification
- Script: `scripts/verify-plm-ui-regression.sh`
- Command: `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7911 scripts/verify-plm-ui-regression.sh`
- Report: `docs/verification-plm-ui-regression-20260117_230222.md`
- Artifact: `artifacts/plm-ui-regression-20260117_230222.png`

# PLM Workbench Local Preset Team Takeover Management Design

## Problem

`BOM / Where-Used` 本地 preset 在成功被 team preset takeover 后，页面目前只会清掉本地 owner 的：

- `selected preset key`
- `name draft`
- `group draft`
- route query owner

但不会同步清掉本地 batch 管理态：

- `selection`
- `batch group draft`

这样会出现 owner 已经切到 team preset，但页面还显示“本地 preset 已选 N 项 / 批量分组草稿仍在”的错位。

## Design

- 把“清空本地 preset 管理态”提升成统一 helper，输出完整的 canonical cleared state：
  - `selectedPresetKey`
  - `nameDraft`
  - `groupDraft`
  - `selectionKeys`
  - `batchGroupDraft`
- `PlmProductView.vue` 的 `clearBomLocalFilterPresetIdentity()` 和 `clearWhereUsedLocalFilterPresetIdentity()` 统一消费这份 helper 输出。
- 所有成功的 team-preset takeover wrapper 继续只调用 `clearLocalOwner`，但清理语义自动扩展为完整 management cleanup，不再要求每条路径单独补齐。

## Expected Outcome

team preset 成功 takeover 本地 BOM / Where-Used preset 后，本地 selector、draft、selection、batch group 会一起被清空，页面不会再残留旧本地 preset 的批量管理状态。

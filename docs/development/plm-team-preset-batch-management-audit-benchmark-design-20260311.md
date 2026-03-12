# PLM Team Preset Batch Management Audit Benchmark Design

日期: 2026-03-11

## 背景

`PLM BOM / Where-Used team preset` 之前已经具备单条对象的 `share / duplicate / rename / default / archive / restore / delete / owner transfer` 生命周期，但协作管理仍停留在单对象按钮层。对真实团队使用来说，这会暴露两个问题：

1. 预设清理和状态治理效率偏低，尤其是 owner 有一批历史 preset 需要归档或删除时。
2. 生命周期虽然已有 URL 一致性，但批量操作还缺统一约束和可审计证据。

因此这一轮先收第一个高价值切片：`team preset batch archive / restore / delete`，并同步把服务端审计做成结构化输出。

## 范围

本轮只覆盖：

- `BOM team preset` 批量管理
- `Where-Used team preset` 批量管理
- 批量动作：`archive` / `restore` / `delete`
- owner-only 执行边界
- live backend 结构化审计日志

本轮不做：

- `duplicate / rename / share / transfer` 的批量版
- `Documents / CAD / Approvals / workbench team view` 的批量版
- 独立审计表落库

## 目标

### 1. 前端

- 在 `BOM / Where-Used` team preset 区块增加 `批量管理` 视图。
- 只允许选择 `canManage = true` 的 preset 参与批量动作。
- 批量动作之后保持已有 URL / identity 规则：
  - 批量归档或删除当前显式 preset 时，退出对应 `bomTeamPreset / whereUsedTeamPreset`。
  - 批量恢复当前显式 preset 时，把同一 preset id 再写回 URL。
  - 当前筛选状态继续保留，不做额外重置。

### 2. 后端

- 提供单一批量接口：`POST /api/plm-workbench/filter-presets/team/batch`
- 请求体：
  - `action: 'archive' | 'restore' | 'delete'`
  - `ids: string[]`
- 行为约束：
  - 非 owner 不可操作
  - 非法 id 不阻断整批，只进入 `skippedIds`
  - `archive` 仅处理未归档项
  - `restore` 仅处理已归档项
  - `delete` 仅处理 owner 可管理项

### 3. 审计

- 每次批量动作输出结构化日志：
  - `action`
  - `tenantId`
  - `ownerUserId`
  - `requestedIds`
  - `processedIds`
  - `skippedIds`
  - `processedTotal`
  - `skippedTotal`
- 审计先以 server log 交付，后续再考虑落库或管理端查询。

## 设计

### 前端模型

在 `usePlmTeamFilterPresets` 内新增：

- `showTeamPresetManager`
- `teamPresetSelection`
- `teamPresetSelectionCount`
- `selectedBatchArchivableTeamPresetIds`
- `selectedBatchRestorableTeamPresetIds`
- `selectedBatchDeletableTeamPresetIds`
- `archiveTeamPresetSelection()`
- `restoreTeamPresetSelection()`
- `deleteTeamPresetSelection()`

`PlmBomPanel.vue` 与 `PlmWhereUsedPanel.vue` 只承载视图层：

- 全选可管理
- 清空选择
- 批量归档
- 批量恢复
- 批量删除

### URL / 状态约束

- 本地 preset identity 永远优先被清掉，避免 local / team 双身份并存。
- team batch action 不会主动清空当前 `bomFilter / whereUsedFilter`。
- 只在当前显式 team preset 被处理时才同步 URL。

### 后端防御式处理

批量接口不直接把所有 `ids` 放进 SQL `in (...)`，先拆成：

- `queryableIds`
- `invalidIds`

这样可以避免历史非 UUID id 直接触发 PostgreSQL `invalid input syntax for type uuid`。

## 对标与超越目标

### 对标

- 从“单对象生命周期完整”提升到“同类型协作对象支持基础批量治理”。
- 从“前端操作成功”提升到“服务端能输出结构化审计证据”。

### 超越

- 非法 id 不再让整批失败，而是变成 `skippedIds`。
- 批量动作继续遵守前面几轮已经打通的 deep link / URL identity 一致性。
- 审计字段从一开始就按 tenant / owner / requested / processed / skipped 拆开，不做黑盒日志。

## 验证策略

1. backend unit：批量 archive / delete / skipped 行为
2. web unit：批量 archive / restore 的 identity 与状态回放
3. package gate：`test / type-check / lint / build`
4. live API：真实创建 preset，执行 batch archive / restore / delete
5. browser smoke：在 `/plm` 中真实走 `BOM batch archive -> restore` 与 `Where-Used batch delete`
6. cleanup：清掉本轮临时 preset

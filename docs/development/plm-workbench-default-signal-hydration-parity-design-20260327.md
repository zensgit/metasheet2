# PLM Workbench Default Signal Hydration Parity Design

## 背景

`PLM team view` 和 `PLM team preset` 的列表接口已经会在返回前补齐 `lastDefaultSetAt`，默认设定/取消默认的单条接口也已经做了同样的 hydration。

但其它 mutate 路径仍然存在一条真实不对称：

- `rename`
- `transfer`
- `archive`
- `restore`
- `batch archive`
- `batch restore`
- `save team preset` 的 upsert 返回

这些路径大多直接把数据库 row 交给 `mapPlmWorkbenchTeamViewRow()` / `mapPlmTeamFilterPresetRow()`，而数据库 row 本身并不带 `last_default_set_at`。

结果是：

- 默认 team view / team preset 一旦被重命名、转移、恢复
- 或默认 preset/view 出现在 batch 返回项里

前端会立刻收到一个丢了 `lastDefaultSetAt` 的对象，直到下一次 refresh 才恢复。这会让 scene/recommendation/audit 这类依赖 recent-default 信号的 UI 出现瞬时降级。

## 设计目标

1. 所有可能保留默认身份的 mutate 响应，都统一补齐 `lastDefaultSetAt`。
2. 不再区分 list/default/save 和 rename/transfer/archive/restore/batch 这两套返回语义。
3. 让 `team view` 和 `team preset` 保持同一套 hydration 合同。

## 方案

### 1. 引入统一的 hydrated row mapper

在 `packages/core-backend/src/routes/plm-workbench.ts` 中新增：

- `mapHydratedPlmTeamViewRows(...)`
- `mapHydratedPlmTeamViewRow(...)`
- `mapHydratedPlmTeamPresetRows(...)`
- `mapHydratedPlmTeamPresetRow(...)`

语义：

- 先调用已有的 `attachPlmTeamViewDefaultSignals(...)` / `attachPlmTeamPresetDefaultSignals(...)`
- 再统一走 `mapPlmWorkbenchTeamViewRow(...)` / `mapPlmTeamFilterPresetRow(...)`

这样 route 层不再手写“有些路径 hydrate、有些路径不 hydrate”的分叉。

### 2. 把 single mutate 响应统一切到 hydrated mapper

`team view` 和 `team preset` 的这些单条返回改成统一走 helper：

- rename
- duplicate
- transfer
- archive
- restore
- save / upsert
- same-owner / same-name 这类 no-op 成功返回

默认设定/取消默认和 `save default view` 这几条已经会先写审计再 attach signal；这里改成直接对 raw `saved` 调 helper，避免 route 内多做一次重复查询。

### 3. 把 batch mutate 返回项也统一切到 hydrated mapper

`batch archive / batch restore` 之前是：

- 先 `returningAll()`
- 再直接 map raw row

现在统一改成：

- 先 `returningAll()`
- 再通过 hydrated batch helper 返回 items

这样 batch 返回项里的默认历史信号也能即时保留。

## 结果

修复后：

- 默认 team view / team preset 在 rename、transfer、archive、restore 后不会丢 `lastDefaultSetAt`
- batch 返回项与 list/default/save 路径的 default signal 合同一致
- 前端的 recent-default 排序、推荐和审计提示不再依赖下一次 refresh 才恢复

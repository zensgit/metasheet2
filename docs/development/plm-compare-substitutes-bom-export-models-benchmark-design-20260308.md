# PLM Compare / Substitutes / BOM Export Typed Action Layer 对标设计

日期: 2026-03-08

## 目标

在上一轮完成共享 typed payload model 之后，本轮继续向前推进一层：

- 把 `Compare / Substitutes / BOM export` 这条 action/export 链上的剩余匿名 shape 收进共享 model
- 让导出、格式化、跨面板联动这些“最后一公里逻辑”也消费明确 contract
- 避免 `/plm` 页面继续在父页里用局部 `Record<string, any>` 解释联邦结果

## 对标判断

当前 `/plm` 的结构治理已经完成了三段：

1. 面板拆分
2. state module / composable 下沉
3. shared typed payload core

但如果 action/export 这层仍保留匿名对象，问题还会反复出现：

- 面板本身是 typed 的，导出函数却仍在猜字段
- Compare/Where-Used/Substitutes 的跨面板联动仍靠局部弱类型拼接
- 一旦联邦 payload 增字段或字段别名漂移，最先坏掉的往往是导出和辅助动作，而不是主面板展示

所以这轮的目标不是继续拆模板，而是补齐“typed payload core -> typed action/export layer”的最后一段。

## 设计决策

### 1. 扩充共享 model 到导出和动作层

在 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts) 中继续补齐：

- `CompareEffectivityEntry`
- `CompareLineProps`
- `BomLineContext`
- `SubstitutePartRecord`
- `SubstituteRelationship`
- `SubstituteEntry`
- `SubstituteMutationResult`
- `WhereUsedLineProps`
- `WhereUsedRelationship`

这样 `effectivity / substitutes / bom export / where-used relationship props` 不再是父页内部临时理解。

### 2. 优先收紧“高复用辅助函数”

本轮重点不是再新建一个 panel，而是收紧这些高复用 helper：

- [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 中的 `formatEffectivityProps`
- [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 中的 `formatEffectivity`
- [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 中的 `formatSubstituteCount`
- [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 中的 `exportSubstitutesCsv`
- [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 中的 `getWhereUsedRefdes`
- [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 中的 `getWhereUsedLineValue`

这些函数一旦 typed，下游 `Compare panel / Substitutes panel / BOM export / Where-Used state` 会一起受益。

### 3. 保留当前业务语义，不改联邦协议

本轮不改：

- `/api/federation/plm/*` 返回结构
- SDK helper 的 API surface
- 面板交互流程

只把前端内部“怎么消费这些字段”从匿名写法推进到共享 contract。

### 4. 顺手收掉 Where-Used 内部树结构的弱类型

这轮顺带把 [usePlmWhereUsedState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmWhereUsedState.ts) 里的内部树节点从 `any` 收成显式 `WhereUsedTreeNode`。原因不是为了追求类型洁癖，而是这块已经处在 `Where-Used` 的核心编排路径里，继续保留 `any` 会让后续 tree/export 联动难以维护。

## 超越目标

这轮真正想超越的不是“少几个 any”，而是把 `/plm` 从：

- typed panel
- typed state
- typed payload

继续推进到：

- typed action
- typed export
- typed cross-panel bridge

完成后，后续收益会更直接：

- Compare/Where-Used/Substitutes 的辅助动作不再各自猜字段
- 导出逻辑能和 panel model 一起演进，而不是长期游离在父页角落
- `/plm` 页面接近“父页只做编排，typed module 负责语义”的状态

## 本轮不做

- 不处理 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 里全部异常链的 `error: any`
- 不重跑完整 `/plm` UI regression 作为本轮主目标
- 不改上游 `Yuantus` 接口
- 不继续新增功能面板

本轮目标很窄：把 typed payload core 推到 typed action/export layer，给下一轮继续收父页边界打基础。

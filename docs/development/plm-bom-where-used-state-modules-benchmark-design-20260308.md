# PLM BOM / Where-Used State Modules 设计与对标

日期: 2026-03-08

## 1. 本轮目标

上一轮 [plm-bom-where-used-contract-modules-benchmark-design-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-bom-where-used-contract-modules-benchmark-design-20260308.md) 已经把 `BOM / Where-Used` 从父页内联 `panel object` 收成独立 contract/composable，但 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 仍保留了两大块本地状态：

- `BOM`: filter / preset / selection / tree visibility / path export
- `Where-Used`: filter / preset / selection / tree visibility

本轮目标不是继续拆模板，而是把这两块真正推进到 `state module` 阶段。

落地文件：

- [usePlmBomState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmBomState.ts)
- [usePlmWhereUsedState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmWhereUsedState.ts)
- [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- [usePlmBomState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmBomState.spec.ts)
- [usePlmWhereUsedState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmWhereUsedState.spec.ts)

## 2. 对标对象与超越目标

### 2.1 当前对标对象

`/plm` 这条线前面已经有四块进入了 “组件化 + composable/state module + typed contract” 形态：

- [usePlmSearchPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmSearchPanel.ts)
- [usePlmProductPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmProductPanel.ts)
- [usePlmComparePanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmComparePanel.ts)
- [usePlmSubstitutesPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmSubstitutesPanel.ts)

`BOM / Where-Used` 的 contract 虽然上一轮已经抽走，但仍然没有达到同样的状态边界。

### 2.2 本轮超越目标

本轮的超越点不是“再多拆两个组件”，而是把最复杂的局部状态真正下沉，达到和其他 panel 同层级的治理水平：

- 父页不再直接维护 `BOM / Where-Used` 的大段 filter/tree/selection/preset 计算
- `BOM / Where-Used` 的状态出口统一从 state module 暴露
- 保住现有 `path filter / path export / query sync / local storage` 行为，不因为下沉而弱化

## 3. 设计边界

### 3.1 这轮下沉什么

下沉到 state module 的范围：

- `BOM`
  - items / loading / error
  - depth / effectiveAt / table-tree view
  - preset/filter 状态
  - selected rows / selected child ids
  - tree rows / visible rows / collapsed keys
  - table/tree path id list
- `Where-Used`
  - itemId / quick pick / recursive / maxLevels / view
  - preset/filter 状态
  - payload / loading / error
  - selected entries / selected parents
  - tree visible rows / collapsed keys / path id list

### 3.2 这轮不下沉什么

仍保留在父页的能力：

- `loadBom`
- `loadWhereUsed`
- `applyProductFromBom`
- `applyWhereUsedFromBom`
- `applyProductFromWhereUsed`
- deep link / query sync
- `bomCollapsed` 的 URL/localStorage 同步

原因很明确：

- 这些逻辑本质上是跨 panel 编排
- 如果这轮连服务调用和跨域跳转一起搬走，会把 state module 做成另一个巨型 orchestrator

### 3.3 关键设计点

#### A. `BOM path` 语义不能回退

本轮不是简单把原有 `computed` 挪到别的文件。`BOM` state module 里专门补齐了两条容易丢失的语义：

- `path` 过滤字段仍然可用
- 表格路径导出仍导出真正的路径 ID，而不是退化成 `lineId`

这一点通过 [usePlmBomState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmBomState.ts) 的 `formatBomPathIds` / `formatBomTablePathIds` 注入保持。

#### B. `bomCollapsed` 的持久化仍由父页掌管

`BOM` 展开态和 URL/query/localStorage 强相关，这一层仍放在 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)：

- state module 只负责生成和切换 `collapsed` 集合
- 父页通过 `watch(bomCollapsed, ...)` 继续做 `persist + query sync`

这样可以避免 state module 直接知道 router/storage，保持职责干净。

#### C. 类型模型继续集中到 `plmPanelModels`

为了避免 `state module` 再次长出自己的临时 shape，本轮把 `WhereUsedEntry` 的 `relationship.source_id / related_id / parent_id` 明确补进了 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)。

## 4. 结构收益

完成后，父页 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 的角色更加单一：

- 负责服务调用
- 负责跨 panel 联动
- 负责 deep link / query / persistence
- 不再直接承载 `BOM / Where-Used` 的大段本地状态实现

这意味着下一轮可以继续往下做两种深化，而不会再先返工：

- `BOM / Where-Used` 更细的 capability contract
- `plmService` 逐步切到 SDK helper

## 5. 验证目标

本轮验证要覆盖三层：

1. 包级门
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

2. state module 关键语义
- `BOM path filter`
- `BOM table path export`
- `Where-Used selected parent`
- `Where-Used payload 更新后的 selection/collapse reset`

3. 真实回归
- 继续尝试 `PLM` UI regression
- 若环境阻塞，必须明确记录阻塞点，不得用旧通过结果冒充新验证

## 6. 结论

这轮是 `/plm` 结构治理里的一个实质性跃迁：

- 上一轮解决的是 `contract module`
- 这一轮解决的是 `state module`

完成后，`BOM / Where-Used` 已从“组件已拆、状态仍在父页”推进到“状态与 contract 都有独立出口”的阶段，和 `Search / Product / Compare / Substitutes` 的治理层级基本对齐。

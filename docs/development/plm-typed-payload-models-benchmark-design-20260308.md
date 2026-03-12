# PLM Typed Payload Models 对标设计

日期: 2026-03-08

## 目标

在上一轮完成 `localized client` 和剩余面板 contract 收口之后，本轮继续向前推进一层：

- 把 `Product / BOM / Compare / Where-Used` 的核心 payload 从局部 `Record<string, unknown>` 提升为共享 model
- 让父页与 composable 共同消费同一组类型，而不是各自维护一份“临时理解”
- 为后续继续拆 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 留下稳定的 typed 边界

## 对标判断

当前 `/plm` 结构治理已经走到一个关键阶段：

- 面板层已经大体组件化
- 一部分 panel 已有 typed contract
- `PlmService` 已经下沉掉 request/localization 细节

但如果 `product / bom / compare / where-used` 这四块核心 payload 还停留在局部 `Record<string, unknown>`，后续会反复遇到同一问题：

1. 父页能看懂的字段，composable 不一定知道
2. composable 建好的类型，父页还在继续用旧别名
3. 新增字段时只能靠局部 patch，而不是基于共享 model 扩展

所以这一轮的目标不是“把 any 换成 unknown”，而是把几个核心 payload 真正提升成共享语义模型。

## 设计决策

### 1. 在共享 model 中补齐核心 payload

在 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts) 新增或收紧：

- `ProductRecord`
- `ProductProperties`
- `CompareSchemaField`
- `CompareSchemaPayload`
- `ComparePayload`
- `CompareChangeEntry`
- `WhereUsedPayload`

这意味着 `product / compare schema / compare result / where-used result` 不再是局部文件里的匿名形状。

### 2. 让父页和 composable 共同依赖共享 model

本轮同步更新：

- [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- [usePlmProductPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmProductPanel.ts)
- [usePlmComparePanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmComparePanel.ts)
- [usePlmWhereUsedState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmWhereUsedState.ts)
- [usePlmSubstitutesPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmSubstitutesPanel.ts)

这样不是“父页先改、composable 以后再补”，而是一次把共享 model 用到真正消费这些 payload 的位置。

### 3. 保留现有业务语义，不动联邦协议

本轮没有去改：

- `PlmService` 的联邦调用协议
- `@metasheet/sdk/client` 的 PLM helper shape
- `/api/federation/plm/*` 的服务端契约

只收紧前端内部对 payload 的理解方式。

### 4. 以“真实字段消费”而不是“理想领域模型”建类型

本轮 model 的设计不是臆造一个完美的 PLM 域模型，而是基于当前代码真实读取的字段：

- `product.properties.*`
- `compare.before_line / after_line / line_normalized`
- `where-used.parents`
- `bom line` 的 `component_* / parent_item_id`

这样做的原因很务实：

- 改动风险低
- 能直接支撑当前页面
- 后续如果联邦返回稳定，再继续往更严格的领域模型收敛

## 超越目标

这轮真正想超越的不是“少几个 any”，而是把 `/plm` 从“组件/状态拆分”继续推进到“共享 payload model 驱动”的阶段。

完成后，后续收益是：

- 父页不再是 payload 语义的唯一真相来源
- composable 之间能共用同一套 `Product / Compare / Where-Used` 认知
- 后续继续拆 BOM/Compare 的辅助函数时，不需要再重复定义匿名 shape

## 本轮不做

- 不重写 PLM 全量领域模型
- 不清空 `PlmProductView.vue` 中所有剩余 `any`
- 不新增联邦接口字段
- 不改真实 UI 行为

本轮目标很明确：把“最核心、最常被复用的 payload”提成共享 model，给下一轮结构治理铺平路。

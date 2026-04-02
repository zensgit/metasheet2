# PLM Panel State Modules 对标、Typed Contract 与设计边界

日期: 2026-03-08

## 1. 本轮目标与范围

当前 `apps/web` 的 PLM 页面已经完成面板组件化：

- [PlmSearchPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmSearchPanel.vue)
- [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmProductPanel.vue)
- [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
- [PlmDocumentsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmDocumentsPanel.vue)
- [PlmCadPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmCadPanel.vue)
- [PlmApprovalsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmApprovalsPanel.vue)
- [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)
- [PlmComparePanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmComparePanel.vue)
- [PlmSubstitutesPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmSubstitutesPanel.vue)

但核心状态、computed、副作用和跨面板动作仍大量停留在 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)。

本轮主线不是继续“拆模板”，而是继续把 panel state 从父页下沉为 composable/state module，目标是：

- 让父页逐步从 `all-in-one view model` 收敛为 `page orchestrator`
- 让每个 panel 拥有更稳定的本地状态边界
- 把当前 `panel: any` 透传，推进到可检查的 typed panel contract

本轮范围：

- 设计 `panel state module` 的落地模式
- 设计 `typed panel contract` 的最小形态
- 约束父页、panel 组件、state module 的职责边界
- 给后续 `product / bom / compare / substitutes / documents / cad / approvals / where-used` 的状态下沉提供统一模板

本轮不做：

- 不在这一轮引入新的全局状态框架替换现有结构
- 不把整个 `/plm` 一次性重写成 Pinia/store-first 方案
- 不为追求类型完整度而同步重写所有面板实现

## 2. 对标对象与超越目标

### 2.1 当前基线

现在的 PLM 前端已经从“单个巨型模板”推进到“多 panel 组件”，这是必要的一步，但还不是终态：

- 组件已经拆开，但父页仍然集中维护大量 refs、watch、query sync、deep link、联动动作
- 各 panel 组件的输入仍主要表现为 `panel: any`
- 组件边界清晰了，状态边界还没有真正清晰

已有第一份样板是 [usePlmSearchPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmSearchPanel.ts)，说明这条路已经可行，但还没有扩展成整套约定。

### 2.2 本轮对标对象

本轮对标对象不是“继续增加组件数量”，而是更成熟的前端工作台结构：

- 父页只负责页面级编排、深链接、跨面板联动和共享依赖注入
- state module 负责 panel 自有 refs、computed、actions、局部副作用
- panel 组件只消费明确 contract，而不是吞一个 `any panel` 大包

### 2.3 超越目标

本轮要强调的超越方向是：

- 从 `巨页 + any props` 走向 `state module + typed panel contract`
- 从“能拆出去”走向“拆出去之后还能持续演进、持续验收”
- 从“父页集中写完所有逻辑”走向“父页只保留 orchestration，领域状态回到对应 panel module”

及格线：

- 每新增一个 panel module，都能减少父页中该面板的 refs/actions/watch 直接暴露面积
- 新模块的对外接口可以被 TypeScript 检查
- UI 组件不再默认承担服务调用、query sync、跨面板副作用编排

## 3. 设计边界

### 3.1 三层职责

`PlmProductView.vue` 保留：

- 路由 query 读写与 deep link 协议
- 页面级自动加载时序
- 跨 panel 联动编排
- 共享依赖注入，例如 `plmService`、复制、提示、认证态处理

`usePlmXPanel` state module 负责：

- 某一 panel 的 refs / computed / 局部 actions
- 该 panel 的请求装配与错误状态
- 该 panel 的局部 watcher
- 输出稳定的 typed contract

`PlmXPanel.vue` 组件负责：

- 模板展示
- 用户输入
- 调用 contract 中暴露的动作
- 不直接感知父页其他面板的内部状态

### 3.2 contract 形态

建议后续 panel contract 采用统一模式：

- `state`: 可直接用于模板渲染的 ref/computed
- `actions`: 面板自身动作
- `capabilities`: 由父页注入的跨面板能力或桥接动作
- `meta`: 可选的标题、空态、计数、是否可交互等展示辅助信息

最小要求不是一次把所有字段都做成复杂类型，而是先做到：

- 面板组件不再接 `panel: any`
- `usePlmXPanel` 有清晰输入类型和返回类型
- 父页与子组件之间的 contract 可以被 IDE 和 `vue-tsc` 检查

### 3.3 状态下沉顺序

建议按依赖复杂度分批推进：

1. `product`
2. `compare + substitutes`
3. `bom + where-used`
4. `documents + cad`
5. `approvals`

原因：

- `product` 是工作台入口，状态边界明确
- `compare + substitutes` 交互复杂，但已经有独立 panel，适合收口成强约束 contract
- `bom + where-used` 共享过滤、选择、联动与 deep link，适合在前两批模式稳定后再处理

### 3.4 明确不下沉的内容

以下内容默认继续留在父页或 page-level helper：

- `applyQueryState`、`scheduleQuerySync`、`syncQueryParams`
- deep link preset 与分享协议
- 跨 panel 自动联动策略
- 页面级 `authState` 触发的统一副作用

这样做是为了避免把“局部状态模块”误做成“另一个隐式总控中心”。

## 4. 验证矩阵

| 维度 | 建议命令 | 通过标准 |
| --- | --- | --- |
| Test | `pnpm --filter @metasheet/web exec vitest run --watch=false` | 现有前端测试通过，新增 state module 有覆盖其核心动作与边界 |
| Type-check | `pnpm --filter @metasheet/web type-check` | `panel contract` 与 `usePlmXPanel` 输入输出类型通过，无新增 `any` 扩散 |
| Lint | `pnpm --filter @metasheet/web lint` | 新模块与新 contract 进入现有 PLM 作用域 lint 门，无新增阻断错误 |
| Build | `pnpm --filter @metasheet/web build` | `/plm` 页面构建通过，面板拆分不引入打包回归 |
| UI regression | `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 PLM_BOM_TOOLS_JSON=artifacts/plm-bom-tools-20260308_0101.json bash scripts/verify-plm-ui-regression.sh` | 搜索、产品、BOM、Where-Used、Compare、Substitutes、Documents、CAD、Approvals 主链路均不回归 |

UI regression 关注点：

- panel 渲染顺序和空态不回归
- compare/substitutes 等强联动区域仍可跳转、复制、导出
- query/deep link 仍可还原工作台上下文
- panel state 下沉后，页面行为不出现“双写状态”或“状态不同步”

## 5. 下一步建议

- 先把 `product` 做成第二个真实 state module，验证“详情入口面板”模式是否稳定。
- 然后处理 `compare + substitutes`，重点不是只迁移 refs，而是把跨面板桥接动作从 `panel any` 中收成 typed capability。
- 补一份 `plmPanelContracts.ts` 或等价类型文件，统一定义 `Search/Product/BOM/...` 的 contract 类型，避免每个 panel 各写一套匿名结构。
- 对每次新下沉的 panel，同步补最小验证：模块单测、`vue-tsc`、PLM lint 门、整页 UI regression。
- 在 typed contract 稳定之前，不急着把所有内容推进到全局 store；先把 page-level orchestration 和 panel-level state 拆清楚，再决定是否需要更重的状态容器。

## 6. 结论

这一轮的核心不是“再拆几个组件”，而是把 PLM 工作台从组件化继续推进到状态模块化。

真正的结构升级是：

- 父页变薄
- panel contract 变清晰
- 类型边界可检查
- 验证路径可重复

只有走到 `state module + typed panel contract`，PLM 前端才算真正脱离“巨页 + any props”的阶段。

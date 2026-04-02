# PLM Compare/Substitutes State Modules 与 Typed Contract 设计

日期: 2026-03-08

## 1. 本轮范围

当前 `Compare` 和 `Substitutes` 已经进一步推进到了“组件 + state module”阶段：

- [PlmComparePanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmComparePanel.vue)
- [PlmSubstitutesPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmSubstitutesPanel.vue)
- [usePlmComparePanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmComparePanel.ts)
- [usePlmSubstitutesPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmSubstitutesPanel.ts)
- [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)

本轮前的痛点是：

- 父页 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 里内联持有 `comparePanel / substitutesPanel`
- 两个组件依赖 `panel: any`

本轮落地结果是把这两个 panel 从“父页内联对象”推进到“composable/state module + typed panel contract”：

- 把 compare 自有 refs / computed / actions 从父页下沉到独立模块
- 把 substitutes 自有 refs / computed / actions 从父页下沉到独立模块
- 收敛 `panel: any` 为明确类型 contract
- 保持 compare 与 substitutes 的联动能力不回归

本轮不做：

- 不重写整个 `/plm` 状态架构
- 不把 deep link、query sync、跨面板自动联动一起移出父页
- 不追求一步把 compare / substitutes / where-used / bom 全部合并成一个大 store

## 2. 对标与超越目标

### 2.1 当前基线

现在的结构已经从“单文件内联模板”推进到了“state module + typed panel contract”，但还有两个继续超越的点：

- compare/substitutes 仍是组合式 state module，还没进一步拆成更细的 `usePlmComparePanel` 与 `usePlmSubstitutesPanel`
- 跨面板 capability 仍主要通过父页动作函数传入，尚未收成统一的 capability contract

这意味着本轮已经解决了“巨页 + any props”的主要问题，但还没有走到最细颗粒度的领域模块化。

### 2.2 本轮对标目标

对标对象不是“再拆两个文件”，而是更像工作台领域模块的结构：

- compare/substitutes 模块继续细化为更清晰的单域 composable
- `PlmComparePanel` / `PlmSubstitutesPanel` 持续只消费 typed contract
- 父页继续收敛为 orchestration，而不是回退到手工拼 `panel` 对象

### 2.3 超越目标

这轮要强调的超越点是：

- 从 `inline panel object` 走向 `state module`
- 从 `panel: any` 走向可检查的 typed contract
- 从“父页集中维护 compare/substitutes 细节”走向“父页保留编排，模块回收领域状态”

及格线：

- compare/substitutes 相关状态继续从父页实质性减少
- 子组件不再默认依赖 `any`
- 联动 Where-Used、产品跳转、BOM Line 回填、复制/导出能力不回归

## 3. 设计边界

### 3.1 为什么这两个 panel 适合一起做

`Compare` 和 `Substitutes` 是 PLM 工作台里最典型的高联动区域：

- compare 结果会驱动 substitutes 的 `bomLineId`
- compare 结果也会驱动 where-used 的目标子件
- substitutes 又需要保留从 BOM / compare 回填 BOM Line 的能力

当前这种耦合已经体现在父页逻辑里，例如 compare 选择会联动写入 `whereUsedItemId` 和 `bomLineId`：

- [PlmProductView.vue:3673](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue#L3673)
- [PlmProductView.vue:3695](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue#L3695)

所以这两块不适合完全孤立设计，应该按“高联动的两个领域模块”一起收口。

### 3.2 父页仍保留 orchestration

即便本轮做 state module，父页仍应保留这些能力：

- query/deep link 读写
- 页面级自动加载时序
- compare 选中后同步 where-used / substitutes 的策略
- 跨 panel 的提示、复制、错误恢复和共享依赖注入

原因很简单：

- compare/substitutes 是高联动，但联动目标不只在这两个 panel 内
- 如果把 orchestration 一起塞进某个模块，只会把父页巨页问题转移成“隐式总控模块”
- 当前阶段最需要的是清晰边界，不是制造新的中心化黑盒

### 3.3 建议的 contract 形态

本轮已经采用 typed contract；下一步建议把 contract 继续稳定成统一结构：

- `state`: 面板渲染所需的 refs/computed
- `actions`: 面板本地动作，例如加载、选择、复制、导出、过滤
- `capabilities`: 父页注入的跨面板桥接能力
- `meta`: 可选的展示辅助信息

其中：

- compare contract 重点约束 diff、selection、schema、filter、export
- substitutes contract 重点约束 line context、list、mutations、filter、export
- 跨面板跳转动作不应伪装成 compare/substitutes 的纯本地状态

### 3.4 模块边界建议

下一步细化时，`usePlmComparePanel` 负责：

- compare 输入参数
- compare schema 与 compare result
- compare selection / detail rows / diff helpers
- compare panel 的导出、复制、局部错误态

下一步细化时，`usePlmSubstitutesPanel` 负责：

- `bomLineId` 驱动的替代件查询上下文
- substitutes 列表、过滤、增删动作
- substitute quick pick / context / export
- substitutes panel 的局部错误态与操作状态

父页继续负责：

- `scheduleQuerySync` / `syncQueryParams`
- `copyDeepLink`
- compare 到 where-used / substitutes 的联动编排
- 页面级 `autoload` 与 query restore

## 4. 验证矩阵

| 维度 | 建议命令 | 通过标准 |
| --- | --- | --- |
| Test | `pnpm --filter @metasheet/web exec vitest run --watch=false` | 新增 compare/substitutes state module 的核心动作和边界有测试覆盖 |
| Type-check | `pnpm --filter @metasheet/web type-check` | compare/substitutes panel contract 与 composable 输入输出类型通过，无新增 `panel: any` 依赖扩散 |
| Lint | `pnpm --filter @metasheet/web lint` | 新增模块与 contract 进入现有 PLM 作用域 lint 门，无新增阻断错误 |
| Build | `pnpm --filter @metasheet/web build` | `/plm` 页面构建通过，compare/substitutes 拆分不引入打包回归 |
| UI regression | `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 PLM_BOM_TOOLS_JSON=artifacts/plm-bom-tools-20260308_0101.json bash scripts/verify-plm-ui-regression.sh` | compare、substitutes 及其跨面板联动不回归 |

UI regression 关注点：

- compare 左右件选择、对比、字段级对照仍可用
- compare 选择条目后，对 substitutes 和 where-used 的联动仍正确
- substitutes 查询、增删、原件/替代件跳转、导出不回归
- deep link 和 query restore 不出现状态双写或错位

## 5. 下一步建议

- 已进一步细化为 [usePlmComparePanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmComparePanel.ts) 与 [usePlmSubstitutesPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmSubstitutesPanel.ts)，后续继续在此基础上收紧 capability contract。
- 以 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts) 为基础，继续把 `compare/substitutes` 的 capability contract 独立出来。
- 把跨面板联动动作单独定义成父页注入 capability，避免模块内部直接偷写其他 panel 的私有状态。
- 等 compare/substitutes 跑通后，再评估是否把 `where-used` 与 `bom` 的桥接 contract 一并标准化。
- 如果 typed contract 模式稳定，再补一份统一 `plmPanelContracts` 类型定义，避免后续每个 panel 各自演化。

## 6. 结论

这轮 compare/substitutes 的重点已经不是“继续拆 UI”，而是把最复杂、联动最强的两个 PLM panel，推进到真正可维护的状态模块边界。

本轮已经完成了“从 inline panel object + any props 走向 state module + typed contract”的第一步。下一步的超越目标，是把它进一步细化成更稳定的单域 composable 和 capability contract，同时继续让父页只保留 orchestration。

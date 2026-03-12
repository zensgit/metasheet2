# PLM BOM / Where-Used Contract Modules 设计与对标

日期: 2026-03-08

## 1. 本轮目标

在 `Search / Product / Compare / Substitutes` 已经完成 typed panel contract 后，`BOM` 和 `Where-Used` 仍然是 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 里两块最长的内联 `panel object`。

本轮目标不是一次性把这两块所有状态都下沉出去，而是先完成两件更关键的事：

- 把 `BOM / Where-Used` 的面板 contract 从父页内联对象抽成独立 composable
- 把 [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue) 和 [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue) 从 `panel: any` 收成显式类型

本轮落地文件：

- [usePlmBomPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmBomPanel.ts)
- [usePlmWhereUsedPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmWhereUsedPanel.ts)
- [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)

## 2. 对标对象与超越目标

### 2.1 当前基线

目前 `/plm` 已经不再是单模板巨页，但还有一个现实问题：

- 面板组件拆开了
- `Search / Product / Compare / Substitutes` 已有独立 contract/composable
- `BOM / Where-Used` 仍由父页直接手工拼装超长对象

这会导致两类问题：

- 父页仍承担过多 contract 组装责任
- 组件虽然被拆开，但最重的两块还没有稳定的类型边界

### 2.2 本轮超越目标

本轮超越点是“把最重的两个 panel 也纳入统一 contract/composable 体系”，而不是继续只拆模板。

及格线：

- 父页不再直接持有 `const bomPanel = { ... }` 和 `const whereUsedPanel = { ... }`
- `PlmBomPanel.vue` / `PlmWhereUsedPanel.vue` 不再使用 `panel: any`
- `BOM / Where-Used` 的 contract 有统一类型出口，可继续承接后续状态下沉

## 3. 设计边界

### 3.1 这轮做什么

这轮采用的是“先抽 contract module，再做深层 state extraction”的策略。

也就是说：

- 父页仍保留绝大多数 `BOM / Where-Used` 状态和计算逻辑
- 但面板 contract 的组装已经移到 [usePlmBomPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmBomPanel.ts) 和 [usePlmWhereUsedPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmWhereUsedPanel.ts)
- 类型定义统一沉到 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)

### 3.2 为什么这样分步

`BOM / Where-Used` 这两块状态量和 helper 数量都比 `Compare / Substitutes` 更重，直接一步把所有 refs/computed 下沉，风险更高。

先抽 contract module 的好处是：

- 先把 `panel: any` 清掉
- 先把父页里两块超长对象收走
- 给下一轮更深的 state module 拆分留出稳定入口

### 3.3 下一步的超越目标

真正的下一阶段不是继续停在“contract wrapper”，而是继续把这两块的本地状态逐步沉下去：

- `BOM`: filter/preset/selection/tree visibility
- `Where-Used`: filter/preset/selection/tree visibility

也就是从这轮的 `contract module` 继续推进到真正的 `state module`。

## 4. 验证目标

本轮至少应满足：

- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

额外关注点：

- `PlmBomPanel.vue` / `PlmWhereUsedPanel.vue` 的模板访问能通过 `vue-tsc`
- `BOM 行` / `Where-Used 行` 的数据 shape 被显式写进 panel model
- 本轮没有把真实 UI regression 问题错误归因为前端 contract 提取

## 5. 结论

这轮是 `/plm` 前端结构治理里的一个中间层升级：

- 还不是 `BOM / Where-Used` 全量状态下沉
- 但已经把两块最重面板纳入了统一的 composable + typed contract 体系

这一步完成后，下一轮继续做 `BOM / Where-Used state module` 时，不需要再先清一次 `panel: any` 和父页超长对象。

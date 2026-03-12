# PLM Preset Utils / Routing Split 对标设计

日期: 2026-03-08

## 目标

在上一轮完成 `auth / deep-link state modules` 之后，本轮继续并行推进两条尾项：

- 把 `BOM / Where-Used` 的 preset share/import/export/persist 规则抽到共享工具层，避免继续由 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 独占这套机制
- 收掉 `apps/web` 已知的 `featureFlags` 动态/静态混合导入 warning，并通过路由级懒加载把主入口 chunk 从“全站静态聚合”推进到“按页面切块”

## 对标判断

当前 `/plm` 结构治理已经进入“页面基础设施和共享规则”阶段。

如果继续把 `preset/share/import/export` 留在父页里，会有两个问题：

1. `BOM / Where-Used` 看起来是两块能力，实际却共用一套没有被显式抽象的规则
2. 未来 `ECO review` 或 `PLM workbench` 新页面如果要复用 preset 机制，只能继续复制父页代码

同时，前端构建侧还保留两个明显信号：

1. `main.ts` 对 [featureFlags.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/stores/featureFlags.ts) 采用动态导入，而其他页面又静态导入，导致构建 warning
2. 路由页全静态导入，导致主入口 chunk 承担过多页面代码

所以本轮不是继续拆业务面板，而是同时补“共享 preset 规则”和“前端入口切块”。

## 设计决策

### 1. 新增共享 preset 工具层

新增 [plmFilterPresetUtils.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmFilterPresetUtils.ts)。

收口的能力包括：

- `upsert / apply`
- `load / persist`
- `share payload encode / decode`
- `share mode resolve`
- `share url build`
- `import parse / merge`
- `confirm import`
- `file export`

这意味着 `BOM / Where-Used` 以后会共同依赖一套明确规则，而不是分别从父页复制语义。

### 2. 父页保留业务动作，移出共享规则

本轮没有把 `BOM / Where-Used` 全部动作再包成新 composable。

而是先把“共用规则”抽出，让 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 保留：

- 业务消息文案
- `ref` 状态读写
- `BOM / Where-Used` 两块各自的动作封装

这样风险最小，也便于下一轮继续把这两块动作再下沉。

### 3. `featureFlags` 改为静态接线

在 [main.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/main.ts) 中，不再对 [featureFlags.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/stores/featureFlags.ts) 进行动态导入。

原因很直接：

- 这不是“按需加载大模块”，而是路由守卫的核心依赖
- 静态接线后，构建器不再需要同时处理动态和静态依赖图

### 4. 路由页改为懒加载

[main.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/main.ts) 中各主页面已切成路由级动态导入。

这一步的目标不是“把一切拆成碎片”，而是让：

- `PLM`
- `Attendance`
- `Workflow Designer`
- `Plugin Manager`

等重页面不再进入首屏入口 chunk。

### 5. 手动 vendor 分包只做已知高收益项

[vite.config.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/vite.config.ts) 中新增了针对：

- `workflow-bpmn`
- `vendor-export`
- `vendor-element-plus`
- `vendor-vue`

的手动分包。

本轮没有继续做 `Element Plus` 组件级按需注册，因为当前仓库仍依赖全局 `app.use(ElementPlus)`，直接改会把风险拉大。

## 超越目标

这轮真正想超越的不是“少几个 warning”，而是把 `/plm` 和 `apps/web` 同时往前推一层：

- `/plm` 从“父页维护 preset 规则”推进到“共享 preset 工具层”
- `apps/web` 从“所有页面静态挂进入口”推进到“路由级切块 + vendor 分层”

完成后，后续收益是：

- `PLM` 新页面可以直接复用 preset/share/import/export 规则
- `featureFlags` 不再制造混合导入噪声
- 构建产物更接近“壳子 + 路由页面 + vendor”分层，而不是继续堆在单入口里

## 本轮不做

- 不移除全局 `ElementPlus` 注册
- 不引入新的自动按需组件插件
- 不继续拆 `BOM / Where-Used` 动作成新 composable
- 不补新的完整 `/plm` UI regression 基线

本轮目标很明确：让 preset 规则可复用，让前端入口更像真正的平台壳，而不是继续承载所有页面代码。

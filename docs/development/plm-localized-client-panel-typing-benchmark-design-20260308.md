# PLM Localized Client / Panel Typing 对标设计

日期: 2026-03-08

## 目标

本轮目标不是继续扩业务面，而是把 `/plm` 前端边界再收紧一层:

- 把 `PlmService` 中残留的 SDK 请求适配和本地化错误映射下沉
- 让 `Approvals / Documents / CAD` 三个面板彻底脱离 `panel: any`
- 让 `apps/web` 的 `lint` 真正覆盖新的 `src/services/plm/*.ts`

## 对标判断

当前 `/plm` 已完成组件化和大部分 state module 下沉，但还存在两个典型短板:

1. `PlmService` 仍同时承担:
   - 前端参数默认值
   - SDK 调用
   - 请求适配
   - 英文错误到中文提示的翻译

2. `Approvals / Documents / CAD` 三个面板虽然已拆成独立组件，但 props 仍是 `panel: any`，这会让:
   - 父页编排对象缺少静态约束
   - 面板侧字段漂移难以及时暴露
   - 新增字段时容易回到“边改边猜”的状态

对标目标不是“再堆一个更大的 service”，而是把职责切成两层:

- `localized federation client`: 负责请求适配 + 本地化 fallback
- `PlmService`: 只保留页面仍需要的参数默认值和调用别名

同时把三块面板推进到和 `Search / Product / BOM / Where-Used / Compare / Substitutes` 一致的 typed contract 层级。

## 设计决策

### 1. 下沉 localized client

新增 [plmFederationClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmFederationClient.ts):

- 统一创建 `RequestClient`
- 统一封装 `createPlmFederationClient`
- 统一维护英文 fallback -> 中文提示映射

这样 `PlmService` 不再直接持有:

- `apiGet/apiPost` request adapter
- `withLocalizedFallback`
- 每个 method 自己的 fallback 字符串

### 2. 保留 `PlmService` 的页面职责

[PlmService.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/PlmService.ts) 继续存在，但角色收窄为:

- 搜索/审批/文档分页默认值
- `getBomCompare` 这类页面友好的参数别名
- 对 `/plm` 页面保持稳定的导出 API

也就是说，本轮不是移除 `PlmService`，而是把它从“胖 service”压回“薄 service”。

### 3. 为 `Approvals / Documents / CAD` 建立显式 panel contract

在 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts) 新增:

- `DocumentEntry`
- `DocumentMetadata`
- `ApprovalEntry`
- `ApprovalHistoryEntry`
- `CadPayload`
- `CadHistoryEntry`
- `CadHistoryPayload`
- `PlmDocumentsPanelModel`
- `PlmCadPanelModel`
- `PlmApprovalsPanelModel`

这样三个面板不再接受 `panel: any`，而是直接依赖明确的 panel contract。

### 4. 父页以 `satisfies` 绑定 contract

在 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 中，`documentsPanel / cadPanel / approvalsPanel` 改为 `satisfies` 对应 model。

这比单纯给子组件 props 加类型更进一步，因为:

- 父页对象本身会在定义处暴露缺字段/错字段
- 组件侧和父页侧的 contract 在同一轮改动里一起收紧

### 5. 补齐 lint 作用域

[apps/web/package.json](/Users/huazhou/Downloads/Github/metasheet2/apps/web/package.json) 的 `lint` 已加入 `src/services/plm/*.ts`，确保本轮新增 client 不会游离在质量门之外。

## 超越目标

本轮不是只“把 `any` 改掉”，而是把 `/plm` 前端进一步推向下面这条链:

`panel component -> typed panel model -> page orchestrator -> thin PlmService -> localized SDK client -> federation`

这条链条的意义在于:

- 页面不再理解 SDK fallback 细节
- 面板不再理解父页内部实现细节
- service 不再承担过多非业务职责
- 后续继续把 `/plm` 切到更 typed 的 SDK result 时，不需要再次大拆页面

## 本轮不做

- 不改联邦协议
- 不新增 PLM 业务功能
- 不重跑完整 UI regression 作为本轮唯一证明
- 不尝试一次性清空 `PlmProductView.vue` 中其他领域的所有 `any`

这轮重点是继续收紧边界，而不是扩大开发面。

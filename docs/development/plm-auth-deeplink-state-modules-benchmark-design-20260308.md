# PLM Auth / Deep-Link State Modules 对标设计

日期: 2026-03-08

## 目标

在上一轮完成 `cross-panel actions / export modules` 之后，本轮继续把 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 从“仍保留部分页面级元状态”的阶段，推进到“认证状态和深链接状态也独立成模块”的阶段。

本轮目标:

- 把 `MetaSheet / PLM token` 状态、401 降级提示、轮询与 legacy token 识别，从父页中抽到独立认证模块
- 把 `deep-link scope / preset / import-export / drag-drop / query sync` 从父页中抽到独立深链接模块
- 让父页继续退回编排层，而不是长期承担一组和 `PLM product workbench` 本身无关的页面基础设施逻辑

## 对标判断

当前 `/plm` 的主体业务区块已经基本拆成独立 panel 与 state module，但父页里仍残留两类“跨业务、跨面板、跨交互”的基础状态：

1. 鉴权状态
2. 深链接与预设状态

这两类逻辑如果继续留在父页，会带来三个问题：

1. 业务状态和页面基础设施状态耦在一起，继续抬高 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 的维护成本
2. 后续如果要在 `PLM/ECO` 其他页复用 token 状态或 deep-link preset，就只能复制整段逻辑
3. 这类状态很难单独验证，只能依赖整页回归

所以这一轮的对标对象不是“再拆一个面板”，而是把剩余页面基础设施也模块化。

## 设计决策

### 1. 把鉴权状态抽成独立 composable

新增 [usePlmAuthStatus.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmAuthStatus.ts)。

职责限定为：

- 解析 JWT payload
- 解析 token 过期窗口并输出 `missing / invalid / expired / expiring / valid`
- 同步 `auth_token / plm_token / jwt`
- 处理 401 场景的状态回落与错误提示
- 管理轮询和 `storage` 事件监听

这部分逻辑不再由父页内联函数维护。

### 2. 把 deep-link / preset 逻辑抽成独立 composable

新增 [usePlmDeepLinkState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmDeepLinkState.ts)。

职责限定为：

- 管理 `deepLinkScope / deepLinkPreset / customPresetName / editingPresetLabel`
- 管理 query sync 防抖
- 管理 deep-link 提示消息
- 管理本地 preset 持久化
- 管理 preset 导入导出与文件拖放
- 管理 `copyDeepLink`

保留给父页的依赖只有：

- `syncQueryParams`
- `buildDeepLinkUrl`
- `formatDeepLinkTargets`
- `applyPresetParams`
- `copyText`

也就是把“业务上下文”继续留在页面，把“deep-link 机制”抽成独立模块。

### 3. 保持父页只做编排

本轮没有改 `/api/federation/plm/*` 契约，也没有调整 SDK。

变化集中在：

- 父页不再内联维护认证/深链接工具函数
- 父页只负责向 composable 提供业务上下文和消费模块输出

这让 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 更接近真正的页面编排器。

### 4. 模块必须先有单测，再谈复用

这轮不是“先抽文件，测试以后补”。

对应新增：

- [usePlmAuthStatus.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmAuthStatus.spec.ts)
- [usePlmDeepLinkState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmDeepLinkState.spec.ts)

这样后续继续在 `PLM/ECO` 其他页面复用时，不需要靠手工 UI 回归验证 token/deep-link 的基础行为。

## 超越目标

这一轮真正想超越的不是“文件拆得更碎”，而是把 `/plm` 的结构治理从“业务面板拆分”推进到“页面基础设施模块化”。

完成后带来的收益：

- token 状态不再被 `PLM` 业务逻辑绑死
- deep-link/preset 不再是父页里的隐式知识
- 后续做 `ECO review`、`approval workbench` 或 `PLM 独立壳` 时，可以直接复用 auth/deep-link 模块
- 这条线开始具备“页面骨架可复制”的条件，而不是只能维护一个巨页

## 本轮不做

- 不改联邦层协议
- 不新增真实 UI 功能
- 不处理 `featureFlags.ts` 的动态/静态混合导入 warning
- 不处理现有大 chunk warning
- 不补新的完整 `/plm` UI regression 基线

本轮目标很明确：把父页剩余的认证和深链接基础设施抽离出来，并让它们进入独立测试与质量门。

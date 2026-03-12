# PLM Panel Team View Duplicate / Rename 对标设计

日期: 2026-03-10

## 目标

上一轮已经让 `Documents / CAD / Approvals team view` 具备：

1. `save`
2. `set default`
3. `clear default`
4. `archive`
5. `restore`
6. `explicit deep link`

这组显式 identity 语义。

但三个 panel 还缺一组会直接影响协作效率的生命周期动作：

1. `duplicate`
2. `rename`

本轮目标是把这两条动作补到与 `PLM workbench team view` 同等级：

1. 允许复制当前可见的 `documents / cad / approvals` 团队视图
2. 只允许 owner 重命名自己的团队视图
3. `duplicate` 后立即切到新副本 id
4. `rename` 后保持当前副本 id，不打断 deep link

## 对标判断

对标成熟工作台产品里的“保存视角”能力，稳定规则通常只有两条：

1. `duplicate` 产生新身份
2. `rename` 只改标签，不改身份

如果 `duplicate` 后页面看起来切到了副本，但 URL 还停在 source id，就会出现：

1. 页面态和分享链接指向不同对象
2. 后续 `rename / default / delete` 会作用到错误 identity

如果 `rename` 后 URL 被重置，就会出现：

1. 当前用户继续编辑的是原对象
2. 复制出去的链接却失效

这两种都属于团队协作层面的状态裂缝。

## 当前代码判断

后端这层其实已经具备通用能力：

1. [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts) 已提供 `PATCH /views/team/:id` 与 `POST /views/team/:id/duplicate`
2. [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts) 已内置：
   - `duplicateTeamView()`
   - `renameTeamView()`
   - `requestedViewId` 同步
   - duplicate 后切副本、rename 后保留 id 的主语义

真正缺的是 panel 层的接线：

1. `PlmDocumentsPanel`
2. `PlmCadPanel`
3. `PlmApprovalsPanel`

这三块之前还没有把：

1. `duplicate`
2. `rename`
3. `canDuplicate`
4. `canRename`

透传给通用的 [PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmTeamViewsBlock.vue)。

## 设计决策

### 1. 不新做一套 panel-specific 生命周期

本轮不为 `documents / cad / approvals` 再复制一套 `duplicate / rename` 逻辑。

而是直接复用 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts) 已有语义，只做 panel model 和面板组件接线。

这样可以保证：

1. `workbench`
2. `documents`
3. `cad`
4. `approvals`

四类 team view 的 identity 规则完全一致。

### 2. duplicate 统一视为“切换当前对象”

在 panel 层，`duplicate` 的产品语义定为：

1. 新建副本
2. 当前选中项切到副本
3. URL 同步到副本 id

这意味着：

1. `documentTeamView`
2. `cadTeamView`
3. `approvalsTeamView`

在 duplicate 后都应该立刻切到新 id。

### 3. rename 统一视为“保留当前对象”

在 panel 层，`rename` 的产品语义定为：

1. 当前对象名称更新
2. 当前 id 不变化
3. URL 不清空、不切回 source

这保证浏览器地址、当前下拉选项和 live 对象始终指向同一条 identity。

### 4. 本轮不扩散到更多权限模型

本轮只补生命周期接线，不做：

1. panel team view 共享范围扩展
2. owner transfer
3. archive 默认排序策略调整
4. 审计日志

## 超越目标

这轮不是单纯把三个按钮接出来，而是把 `PLM panel team view` 的身份语义补齐到和 `workbench team view` 同级：

1. `Documents / CAD / Approvals` 不再只是“可保存”
2. 它们现在也具备“可复制、可重命名、可深链接分享”的稳定 identity
3. 这使 `PLM` 各 panel 视角真正进入“团队可协作资产”阶段

## 本轮不做

- 不做新的后端权限模型
- 不做 panel team view `delete` 语义调整
- 不做 panel team view `archive / restore` 新改造
- 不做更多面板扩展

本轮只解决一件事：

让 `Documents / CAD / Approvals team view` 也开始遵守统一的 `duplicate / rename / URL identity` 规则。

# PLM Workbench Team View URL Sync 对标设计

日期: 2026-03-10

## 目标

前一轮已经让 `PLM workbench team view` 具备：

1. `duplicate`
2. `rename`
3. `workbenchTeamView=<id>` 显式 deep link

但真实浏览器验证暴露了一个明显断层：

1. 复制后当前下拉框已经切到新副本
2. 重命名后当前选中项也已经更新
3. 地址栏里的 `workbenchTeamView` 仍然可能停留在旧 source id

这意味着：

1. 页面上的当前视图身份
2. URL 里的显式 deep link 身份

并不总是一致。

本轮目标就是补上这条一致性：

1. `duplicate` 后，URL 要立即切到新副本 id
2. `rename` 后，URL 要继续锚定当前选中视图 id
3. workbench 当前筛选状态不能在同步 URL 的过程中被破坏

## 对标判断

如果对标 `Notion database view`、`Retool saved query view`、`飞书多维表格视图链接`，一个可分享的视图系统至少要满足：

1. 当前选中的视图身份和 URL 身份一致
2. 复制后的副本不会继续复用旧视图链接
3. 用户复制链接时，分享出去的是“当前正在看的视图”，不是前一个视图

对 `PLM workbench` 来说这条尤其重要，因为 `workbenchTeamView` 已经不是普通筛选，而是跨：

1. `Documents`
2. `CAD`
3. `Approvals`

的组合工作台语义。

如果 URL 继续指向旧 source id，那么：

1. 浏览器刷新后会落回旧视图
2. 复制深链接会分享错对象
3. “副本已成为当前视图”这件事只停留在内存状态，不是持久语义

## 设计决策

### 1. duplicate / rename 改成完整 `applyView()`

本轮没有继续让 `duplicate / rename` 只做：

1. `teamViewKey = newId`
2. `syncRequestedViewId(newId)`

而是改成统一走 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts) 里的 `applyView(view)`。

原因是 `workbench` 这类视图的完整语义不止是“切换下拉框”，还包括：

1. `requestedViewId`
2. `router query`
3. `applyWorkbenchTeamViewState()`

只有走完整 apply，才能保证 URL 和 workbench 当前状态一起收敛。

### 2. 不新加专门的 URL sync 旁路

本轮没有额外引入新的 `syncUrlAfterDuplicate()` 或 `syncUrlAfterRename()` 特判函数。

因为现在真正可靠的语义应该是：

1. 任何“把某个团队视图设为当前视图”的动作
2. 都走同一条 `applyView()`

这样：

1. 行为更一致
2. workbench 与 documents/cad/approvals 仍共享同一套 hook 语义
3. 不会再出现“UI 已切换但 URL 没切换”的分叉路径

### 3. 只修 `duplicate / rename`，不顺手改 `save / set default`

本轮刻意只收前一轮真实验证里已经暴露的问题：

1. `duplicate`
2. `rename`

没有顺手扩散到：

1. `save`
2. `set default`
3. `clear default`

原因是这轮的目标是把“显式 deep link 和当前视图身份不一致”这个已知缺口闭环，而不是在同一轮重写全部团队视图动作语义。

## 超越目标

本轮想超越的不是“让 URL 看起来更顺眼”，而是把 `PLM workbench team view` 从“页面内当前选项”推进成真正的：

1. 可复制
2. 可重命名
3. 可分享
4. 可持久恢复

的统一资产。

只有当 `当前视图身份 = URL 身份` 时，`duplicate / rename / deep link / default restore` 才能算是同一套产品能力，而不是几条互相打架的局部功能。

## 本轮不做

- 不改 `save` 的 URL 策略
- 不改 `set default / clear default` 的 URL 策略
- 不做 team view history
- 不做跨面板 team view 联动跳转
- 不做分享权限细分

本轮只解决一件事：

让 `PLM workbench team view duplicate / rename` 后，显式 `workbenchTeamView` URL 与当前选中视图保持一致。

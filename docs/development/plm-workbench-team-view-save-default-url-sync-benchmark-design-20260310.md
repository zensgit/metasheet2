# PLM Workbench Team View Save / Default URL Sync 对标设计

日期: 2026-03-10

## 目标

前一轮已经补上了 `duplicate / rename` 后的 `workbenchTeamView` URL 同步，但 `save / set default` 仍保留旧语义：

1. 内部选中项会切到当前视图
2. `requestedViewId` 会被更新
3. 但没有走完整 `applyView()`

这意味着 `save / set default` 仍可能出现：

1. workbench 当前视图身份已变化
2. URL deep link 身份还在旧状态
3. 当前筛选状态和显式链接身份不完全对齐

本轮目标是把 `save / set default` 也拉到和 `duplicate / rename` 同一条语义线上：

1. `save` 后立即把 `workbenchTeamView` 写回 URL
2. `set default` 后继续保持当前视图 id，不把 URL 留在旧值
3. 当前 `Documents / CAD / Approvals` 组合状态在这个过程中保持稳定

## 对标判断

如果对标 `Retool saved views`、`Notion database saved view`、`飞书多维表格默认视图`，一个成熟的视图系统不应该把：

1. 创建新视图
2. 设为默认
3. 分享当前 URL

拆成三套不一致的身份模型。

用户在点击 `保存到团队` 后，直觉上会认为：

1. 当前正在看的就是这个新视图
2. 此时复制的链接应该就是这个新视图的链接

同样，在点击 `设为默认` 后，当前视图 identity 不应该跳回匿名状态或旧 identity。

## 设计决策

### 1. `save / set default` 统一走 `applyView(saved)`

本轮没有新增 `syncUrlAfterSave()` 或 `syncUrlAfterDefault()` 旁路，而是直接把 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts) 里的：

1. `saveTeamView()`
2. `setTeamViewDefault()`

改成与 `applyTeamView / duplicateTeamView / renameTeamView` 同样走 `applyView(saved)`。

这样可以保证：

1. `teamViewKey`
2. `requestedViewId`
3. `applyViewState`

三件事始终同步。

### 2. 不只修 workbench 特判，保持团队视图动作语义统一

虽然这轮重点验证的是 `workbench`，但 hook 级实现没有只写死在 `kind=workbench`。

这样做的好处是：

1. documents/cad/approvals 团队视图动作语义也更一致
2. 后续不用再为每个 kind 单独追 bug
3. 团队视图 hook 维持单一心智模型

### 3. 本轮不扩散到 `clear default`

`clear default` 本轮没有改成完整 apply。原因是它本身不改变“当前选中的是哪条视图”，只改变默认标志位。

当前最核心的问题是：

1. 新建视图后 URL 是否切到新视图
2. 设默认后 URL 是否继续锚定当前视图

先把这两条收住，避免同轮把生命周期全部重写。

## 超越目标

本轮想超越的不是“再补一个按钮边角”，而是让 `PLM workbench team view` 的四类主动作：

1. `apply`
2. `duplicate / rename`
3. `save`
4. `set default`

都开始围绕同一个 identity 语义运转。

这样：

1. 当前选中视图
2. URL 中的显式 deep link
3. 默认视图标记

才不会彼此打架。

## 本轮不做

- 不改 `clear default` 的 URL 策略
- 不做 team view archive
- 不做 save-as template
- 不做 workbench team view 分享权限细分

本轮只解决一件事：

让 `save / set default` 之后，`PLM workbench` 的当前视图身份和 URL 身份保持一致。

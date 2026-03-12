# PLM Team Preset Delete URL Cleanup 对标设计

日期: 2026-03-10

## 目标

前几轮已经让 `BOM / Where-Used team preset` 在以下动作后保持稳定 identity：

1. `save`
2. `set default`
3. `clear default`
4. `duplicate`
5. `rename`

但 `delete` 仍缺一个明确的退场语义：

1. 当前 team preset 被删除后，URL 里的 `bomTeamPreset / whereUsedTeamPreset` 应该立即清掉
2. 同时页面当前过滤状态不应该被一并抹掉
3. 表单里残留的团队预设名称 / 分组也不应该继续停留在已失效对象上

本轮目标就是把这条 `delete` 生命周期补齐。

## 对标判断

对标 `飞书视图删除`、`Retool saved view delete`、`Notion view delete`，成熟的视图系统在删除当前显式视图时通常遵守一条规则：

`删除的是 identity，不是当前工作状态本身。`

也就是说：

1. URL 应该退出这条已删除视图的 id
2. 当前筛选/排序/字段状态可以保留为匿名工作状态
3. 页面不应继续显示一个已经不存在的“当前团队预设名称”

如果删除后 URL 还保留旧 id，会留下失效 deep link。  
如果删除后连过滤状态也清空，则会破坏用户当前工作上下文。  
如果删除后输入框仍保留旧名称/分组，则会在 UI 上制造“对象还在”的错觉。

## 设计决策

### 1. hook 内统一做 delete 退场

在 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts) 的 `deleteTeamPreset()` 中补齐三件事：

1. 删除当前 preset 后清空 `teamPresetKey`
2. 同时清空 `teamPresetName / teamPresetGroup`
3. 如果当前 `requestedPresetId` 指向被删对象，则同步清空 URL identity

这样不需要再给 `BOM / Where-Used` 各写一套 delete 特判。

### 2. 过滤状态保持匿名，不回退到默认 preset

这轮没有在 delete 后自动重新应用默认 team preset，也没有回退到 local preset。

原因很简单：

1. 用户删除的是“当前显式 identity”
2. 不是在要求“切换到别的 preset”

所以 delete 后最稳妥的语义是：

1. 当前过滤条件继续保留
2. URL 退出 preset identity
3. 页面回到匿名工作状态

### 3. 清理 auto-apply sentinel

如果被删对象刚好是最近一次自动应用过的默认 preset，还要把内部 `lastAutoAppliedDefaultId` 清掉，避免后续自动恢复逻辑记住一个已经不存在的 id。

## 超越目标

本轮不是单纯把删除按钮点通，而是让 `team preset` 生命周期第一次形成完整闭环：

1. 进入：`save / duplicate`
2. 稳定：`rename / set default / clear default`
3. 退出：`delete`

其中 `delete` 的语义也开始和前面几轮一样遵守统一规则：

`preset identity 可以消失，但当前工作状态不应被意外抹掉。`

## 本轮不做

- 不做 delete 后自动切换到其他默认 preset
- 不做 delete 后回退到 local preset
- 不做 soft delete / archive
- 不做 preset 审计日志

本轮只解决一件事：

让当前 `BOM / Where-Used team preset` 被删除后，URL、UI 输入状态和工作态都能一致退场。

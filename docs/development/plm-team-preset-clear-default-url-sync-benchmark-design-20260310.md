# PLM Team Preset Clear Default URL Sync 对标设计

日期: 2026-03-10

## 目标

前一轮已经让 `BOM / Where-Used` 团队预设在以下动作后保持显式 URL 身份：

1. `save`
2. `set default`
3. `explicit deep link`

但 `clear default` 仍保留旧语义：

1. 只更新默认标记
2. 不重新执行完整 `applyPreset`
3. 在“当前预设是由默认自动恢复出来”的路径里，可能留下：
   - 页面仍显示当前团队预设
   - 但 `requestedPresetId` 没有重新锚定
   - URL 身份可能掉回匿名状态

本轮目标是把 `clear default` 也拉回和 `save / set default` 一致的 identity 语义：

1. `clear default` 后继续保持当前选中的 team preset
2. `clear default` 后继续保持显式：
   - `bomTeamPreset=<id>`
   - `whereUsedTeamPreset=<id>`
3. 不让页面出现“当前选中项还在，但 URL 已丢身份”的裂缝

## 对标判断

对标 `飞书多维表格视图默认切换`、`Retool saved views`、`Notion saved view default toggle`，成熟的视图系统不应该把：

1. 当前选中视图
2. 默认标记
3. URL deep link 身份

拆成互相不同步的三套状态。

用户点击 `取消默认` 的直觉是：

1. 只是不再把这条视图当默认
2. 但我当前看的仍然是这条视图
3. 此时复制的链接也仍应该是这条视图的链接

如果 `clear default` 后 URL 退回匿名状态，会直接破坏这条直觉。

## 设计决策

### 1. `clear default` 统一走 `applyPresetToTarget(saved)`

本轮没有新增单独的 `syncUrlAfterClearDefault()`，而是直接在 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts) 的 `clearTeamPresetDefault()` 中复用现有主语义：

1. 更新团队预设列表
2. 重新 `applyPresetToTarget(saved)`
3. 同步 `teamPresetKey`
4. 同步 `requestedPresetId`

这样可以保证：

1. 选中项
2. 当前过滤状态
3. URL identity

在 `clear default` 后仍然保持同一条 team preset。

### 2. 不新增 BOM / Where-Used 特判

虽然 live 验证覆盖的是 `bom` 和 `where-used`，但 hook 级实现没有加面板级分支。这样做是为了保持：

1. `save`
2. `set default`
3. `clear default`

都围绕同一套 hook 语义运转，而不是为每个动作单独打补丁。

### 3. 本轮不扩散到删除后的 URL 策略

`delete` 后 URL 是否立即清空对应 preset id，是另一条生命周期问题。

这轮只收一件事：

1. `clear default` 不该改变当前 team preset identity

删除动作仍然保持现有行为，不在本轮一并重构。

## 超越目标

本轮不是单纯补一个边角 bug，而是让 `BOM / Where-Used team preset` 的主动作：

1. `save`
2. `set default`
3. `clear default`
4. `explicit deep link restore`

都开始遵守同一条规则：

`当前选中的是哪条 team preset，URL 就应该锚定哪条 team preset。`

## 本轮不做

- 不改 `delete` 后 URL 清理策略
- 不做 team preset archive
- 不做 preset 分享权限细分
- 不做后端 preset 审计日志

本轮只解决一件事：

让 `clear default` 之后，`BOM / Where-Used` 的当前 team preset 身份和 URL 身份继续保持一致。

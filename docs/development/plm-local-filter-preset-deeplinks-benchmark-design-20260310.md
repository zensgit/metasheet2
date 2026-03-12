# PLM Local Filter Preset Deep Links 对标设计

日期: 2026-03-10

## 目标

前一轮已经让 `/plm` 支持：

1. `bomTeamPreset=<id>`
2. `whereUsedTeamPreset=<id>`

但 `BOM / Where-Used` 的本地过滤预设仍停留在“只能恢复 field/value”的层级：

1. URL 可以携带 `bomFilter / bomFilterField`
2. URL 可以携带 `whereUsedFilter / whereUsedFilterField`
3. 但不能表达“当前恢复的是哪条本地 preset”

这会导致两类不稳定行为：

1. 用户复制的是“当前过滤结果”，不是“当前本地预设身份”
2. 当同面板存在默认 team preset 时，本地显式状态没有稳定优先级

本轮目标是把本地 preset 也纳入和 team preset 同一层的 deep link 语义：

1. `/plm` 支持 `bomFilterPreset=<local-key>`
2. `/plm` 支持 `whereUsedFilterPreset=<local-key>`
3. 显式本地 preset 优先于默认 team preset
4. 同面板的本地 preset identity 与 team preset identity 保持互斥，避免 URL 同时携带两套冲突身份

## 对标判断

如果对标 `Notion database view links`、`Retool saved filters`、`飞书多维表格视图链接`，成熟系统不会只共享“当前筛选结果”，而不共享“当前用户到底落在了哪条保存视图上”。

对本地 preset 也是同一个判断：

1. 用户点击本地 preset 后复制链接，期望恢复的是这条 preset，而不是一组匿名 field/value
2. 当同面板存在默认团队 preset 时，显式 local preset 不应被默认团队规则覆盖
3. 地址栏应该能准确表达“当前是本地 preset 身份”还是“当前是团队 preset 身份”

## 设计决策

### 1. 新增显式 query contract

本轮新增两个 query key：

1. `bomFilterPreset`
2. `whereUsedFilterPreset`

它们会进入 [plmWorkbenchViewState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmWorkbenchViewState.ts)，因此：

1. workbench deep link snapshot 可以持久化本地 preset identity
2. `hasExplicitWorkbenchQueryState()` 也会把本地 preset 视为真正的显式状态

### 2. 优先级顺序显式化

当前 `/plm` 单面板状态恢复顺序，收敛为：

1. 显式 local preset id
2. 显式 team preset id
3. 默认 team preset
4. 原始 `field/value`

这里最关键的是：

1. `field/value` 仍会保留在 URL 中，用于复制当前过滤结果
2. 但最终身份优先级由 preset id 决定
3. local preset 的应用时机放在 team preset refresh 之后，因此显式 local preset 会覆盖默认 team preset

### 3. 同面板 identity 互斥

本轮不允许同一面板长期同时保留：

1. `bomFilterPreset`
2. `bomTeamPreset`

或：

1. `whereUsedFilterPreset`
2. `whereUsedTeamPreset`

所以新增了两条规则：

1. 应用/保存 local preset 时，清掉同面板的 team preset identity
2. 应用/保存/设默认 team preset 时，清掉同面板的 local preset identity

这样可以避免 reopen `/plm` 时出现“URL 同时带两条身份，但最后恢复哪条不明确”的问题。

### 4. stale identity 自清理

本地 preset 和 team preset 不一样，资源不在后端，而在浏览器本地存储里，因此本轮补了一条 defensive 规则：

1. 如果 URL 指向的 local preset id 在 localStorage 已不存在
2. 页面会清掉无效 query，而不是保留一条悬空 identity

## 实现范围

本轮实现集中在前端：

1. [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
2. [plmWorkbenchViewState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmWorkbenchViewState.ts)
3. [plmFilterPresetUtils.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmFilterPresetUtils.ts)
4. [plmWorkbenchViewState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchViewState.spec.ts)
5. [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)

后端不新增协议，也不扩展 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)。

## 超越目标

这轮想超越的不是“再多两个 query 参数”，而是让 `/plm` 的 preset identity 真正进入统一协议层：

1. workbench team view
2. panel team view
3. team filter preset
4. local filter preset

这样后续做：

1. preset share
2. preset duplicate / rename
3. preset import / export
4. saved workbench snapshot

都能围绕同一套 identity / precedence 规则推进，而不是继续靠匿名 filter state 拼接。

## 风险与边界

### 1. local preset 天生依赖 localStorage

这轮 deep link 只能在“同一浏览器存储中已存在这条 local preset”时完整恢复。

所以它解决的是：

1. 当前用户重进页面
2. 同浏览器会话恢复
3. 本地 preset 与 team preset 的优先级稳定

它不解决跨设备分享，这是 team preset / team view 的职责。

### 2. query 会继续保留 field/value

本轮没有把 URL 精简成“只留 preset id”。保留 field/value 是有意的：

1. 兼容旧链接
2. 兼容不带 preset id 的链接
3. 让恢复后的 URL 仍能直观看到当前过滤值

### 3. 本轮不做

- 不把 local preset 提升成后端资源
- 不做 local preset rename / duplicate
- 不做 cross-user local preset sharing
- 不处理 `clear default` 的 URL 一致性

本轮只解决一件事：

让 `BOM / Where-Used local filter preset` 具备稳定的显式 deep link identity，并与 team preset 进入同一优先级体系。

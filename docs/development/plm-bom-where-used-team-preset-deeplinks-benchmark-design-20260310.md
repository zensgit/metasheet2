# PLM BOM / Where-Used Team Preset Deep Links 对标设计

日期: 2026-03-10

## 目标

前一轮已经让 `Documents / CAD / Approvals / Workbench` 具备了显式 team view deep link，但 `BOM / Where-Used` 仍停留在“只恢复过滤字段和值”的状态：

1. URL 可以携带 `bomFilter / bomFilterField`
2. URL 可以携带 `whereUsedFilter / whereUsedFilterField`
3. 但不能表达“当前恢复的是哪条团队预设”

这会带来两个问题：

1. 显式链接无法锚定到具体 team preset identity
2. 当默认团队预设存在时，显式恢复和默认恢复之间没有稳定优先级

本轮目标是把 `BOM / Where-Used` 拉到和 `team view` 同一条语义线上：

1. `/plm` 支持 `bomTeamPreset=<id>`
2. `/plm` 支持 `whereUsedTeamPreset=<id>`
3. 显式 preset id 优先于默认团队预设
4. 显式 preset id 应用后，URL 会继续保留 preset identity，并回写对应 `field/value`

## 对标判断

如果对标 `Retool saved filters`、`Notion database view links`、`飞书多维表格筛选视图`，成熟系统不会只分享“筛选结果”，而不分享“筛选身份”。

用户复制一个 `BOM / Where-Used` 团队预设链接时，直觉上会认为：

1. 接收者打开后看到的是同一条团队预设
2. 即便存在默认预设，显式链接也不该被默认值覆盖
3. 地址栏应该能表达当前恢复的是哪条团队预设

## 设计决策

### 1. 新增显式 query contract

本轮新增两个 query key：

1. `bomTeamPreset`
2. `whereUsedTeamPreset`

它们会被纳入 [plmWorkbenchViewState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmWorkbenchViewState.ts)，因此：

1. workbench deep link snapshot 能保留 preset identity
2. `hasExplicitWorkbenchQueryState()` 也会把这两类显式 preset 视为真正的显式状态

### 2. `usePlmTeamFilterPresets` 增加 requested identity

本轮没有在 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 里继续堆 `if/else`，而是把团队预设 hook 提升到和 `usePlmTeamViews` 同一层级：

1. `requestedPresetId`
2. `syncRequestedPresetId`

这样 `apply / save / set default / delete / refresh` 都围绕同一条 preset identity 语义运转。

### 3. 优先级规则明确化

本轮约定：

1. 显式 `bomTeamPreset / whereUsedTeamPreset`
2. 默认团队预设
3. 原始 `field/value`

其中最关键的是：

1. 当显式 preset id 存在且可解析时，它优先于默认团队预设
2. 当显式 preset id 不存在或已失效时，会清掉无效 id，再回退默认策略
3. 原始 `field/value` 仍会保留在 URL 中，用于分享当前过滤状态，但最终以显式 preset identity 为准

### 4. 不新增后端协议

这轮不改 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)。

原因是：

1. 后端已经提供 `list / save / set default / clear default / delete`
2. 缺口不在资源模型，而在前端 query 协议和 identity 应用顺序

## 超越目标

这轮想超越的不是“再多两个 query key”，而是把 `BOM / Where-Used` 从“只能分享筛选结果”推进到“可以分享团队预设身份”。

这样：

1. 团队默认预设
2. 显式 deep link
3. workbench snapshot

三者才会进入同一套可预测的优先级体系。

## 本轮不做

- 不扩展到本地 filter preset
- 不做 preset `duplicate / rename`
- 不做 preset share permission 细分
- 不做后端 preset archive

本轮只解决一件事：

让 `BOM / Where-Used team preset` 具备和 `team view` 一致的显式 deep link identity。

# PLM Local Preset Promote to Team 对标设计

日期: 2026-03-10

## 目标

前一轮已经让 `/plm` 的本地 `BOM / Where-Used` 过滤预设具备：

1. 显式 deep link identity
2. `duplicate / rename`
3. 与 team preset 的优先级互斥

但它仍停留在“只能本地使用”的层级。当前用户如果想把已经验证过的本地过滤视角提升为团队资产，还需要重新走一次：

1. 手工复制 field
2. 手工复制 value
3. 再单独保存团队预设

这会带来两类问题：

1. 本地 preset 到团队 preset 的迁移成本高，容易手工出错
2. URL identity 会停留在 local key，不能自然切到可分享的 team id

本轮目标是补齐这条“本地沉淀 -> 团队共享”的桥：

1. `BOM / Where-Used local preset` 支持一键 `升团队`
2. 升团队后直接复用现有 team preset API
3. URL 身份从 `bomFilterPreset / whereUsedFilterPreset` 自动切到 `bomTeamPreset / whereUsedTeamPreset`
4. 同面板 local identity 在成功提升后自动清掉，避免 URL 双重身份冲突

## 对标判断

如果对标 `Notion saved views`、`Retool filters`、`飞书多维表格个人视图 -> 协作视图`，成熟产品不会要求用户把一个已经存在的个人视角再手工录入一遍才能共享给团队。

更合理的路径是：

1. 先在个人空间里迭代过滤视角
2. 视角稳定后直接提升为团队资源
3. 系统自动把当前链接身份切到可分享的团队对象

`/plm` 当前已经有：

1. local preset identity
2. team preset identity
3. 两者之间的 URL precedence

所以继续让用户“另存一遍”已经不合理，应该直接补 promotion path。

## 设计决策

### 1. 不新增后端协议，直接复用 team preset 保存接口

本轮不扩展新 route，而是让 local preset promotion 直接落到已有：

1. `POST /api/plm-workbench/filter-presets/team`

这样可以保持：

1. 后端权限语义不变
2. team preset 数据模型不变
3. 前端 promotion 只是已有保存流程的上层快捷入口

### 2. promotion 输入就是当前 local preset 的稳定 state

提升团队时，只带 local preset 已经固化的：

1. `field`
2. `value`
3. `group`

不使用当前页面临时输入框状态，避免出现：

1. local preset A 被选中
2. 输入框又被手工改成状态 B
3. 升团队时落成不属于 A 的混合状态

promotion 的源只能是“当前选中的 local preset 对象”。

### 3. URL identity 成功后必须切换

提升成功后，同面板 URL 身份切换规则固定为：

1. 清掉 `bomFilterPreset`
2. 写入 `bomTeamPreset=<id>`

或：

1. 清掉 `whereUsedFilterPreset`
2. 写入 `whereUsedTeamPreset=<id>`

这里的关键不是“还能不能恢复 field/value”，而是：

1. 当前工作状态已经从 local asset 升级成了 team asset
2. 地址栏必须反映新的所有权语义

### 4. 同名冲突做安全重命名

团队列表中如果已经存在同名 preset，本轮不覆盖旧资源，而是生成安全名称：

1. 先尝试原名
2. 再尝试 `原名 团队`
3. 再尝试 `原名 团队 2`
4. 依次递增

这样可以避免：

1. live 团队资产被静默覆盖
2. 用户因为 promotion 失败而中断主路径

### 5. promotion 成功才清 local identity

如果团队保存失败：

1. local preset 仍保留
2. URL 仍保持 local preset identity
3. 用户不会丢失当前本地工作成果

只有当团队保存真正返回成功对象后，才切换 URL 身份并清空 local key。

## 实现范围

本轮实现集中在前端：

1. [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
2. [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
3. [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
4. [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)
5. [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
6. [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)

后端不新增 migration，也不新增 route。

## 超越目标

这轮想超越的不是“再加一个按钮”，而是让 `/plm` 的视角生命周期更完整：

1. local preset 可以沉淀
2. local preset 可以复制/重命名
3. local preset 可以显式 deep link
4. local preset 可以提升为 team preset
5. 提升后 URL 身份自动完成所有权切换

这样后续再做：

1. `promote to team default`
2. `team preset duplicate / rename`
3. `preset share`
4. `cross-panel preset promotion`

都能继续沿用同一套 identity 规则。

## 风险与边界

### 1. 本轮不保留 local/team 双身份

promotion 成功后，不会在 URL 同时保留：

1. `bomFilterPreset`
2. `bomTeamPreset`

或：

1. `whereUsedFilterPreset`
2. `whereUsedTeamPreset`

这是有意约束，避免 reopen `/plm` 时恢复路径不明确。

### 2. 本轮不做 local preset 自动删除

promotion 只会：

1. 创建 team preset
2. 切换 URL identity

不会自动删除原 local preset。这样用户仍能保留本地版本继续演化。

### 3. 本轮不做跨面板批量 promotion

本轮只覆盖两条面板：

1. `BOM`
2. `Where-Used`

不把 `Documents / CAD / Approvals / Workbench` 一起卷进来，避免把本地过滤预设和团队工作台视图混成一层协议。

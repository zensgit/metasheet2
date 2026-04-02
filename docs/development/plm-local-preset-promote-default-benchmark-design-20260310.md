# PLM Local Preset Promote to Team Default 对标设计

日期: 2026-03-10

## 目标

前一轮已经让 `/plm` 的本地 `BOM / Where-Used` 过滤预设具备一键 `升团队`：

1. local preset 可以直接创建 team preset
2. URL identity 会从 local key 自动切到 team id
3. live/brower path 已闭环

但它还差最后一步: 用户如果已经确认某个本地视角就是团队默认工作视角，仍然需要再多点一次:

1. 先 `升团队`
2. 再到团队预设区域点 `设为默认`

这会带来两个问题:

1. 视角晋升路径被拆成两步，live 使用时容易遗漏第二步
2. URL 虽然已经切到 team id，但默认态要靠后续手工补齐，工作台 reopen 时不一定恢复到预期默认视角

本轮目标是补齐这条“本地稳定视角 -> 团队默认视角”的最终快捷路径:

1. `BOM / Where-Used local preset` 支持一键 `升默认`
2. 成功后直接创建 team preset 并设为默认
3. URL identity 直接写入 `bomTeamPreset / whereUsedTeamPreset`
4. 原 local identity 自动清理，避免 local/team 双身份并存

## 对标判断

对标成熟协作产品时，真正高频的不是“个人视图转团队视图”，而是“个人验证通过的视图直接升成团队默认视图”。

更合理的用户路径应该是:

1. 先在本地反复调试过滤条件
2. 一旦确认这就是团队默认工作视角，直接一步升为默认团队预设
3. 系统自动把链接、默认态和团队资源一起落好

如果仍要求用户:

1. 升团队
2. 再手工设默认

那 `/plm` 在工作流上仍然停留在“功能上能做”，还没到“产品上顺手”。

## 设计决策

### 1. 不新增后端新协议，复用现有 team save + set default

本轮不新增新的“promote default” route，而是复用现有链路:

1. `savePlmTeamFilterPreset(...)`
2. `setPlmTeamFilterPresetDefault(id)`

这样可以保持:

1. 权限模型不变
2. 数据模型不变
3. 前端只是在已有协议之上加一条组合快捷路径

### 2. 默认态必须在成功创建 team preset 后立刻落库

执行顺序固定为:

1. 从当前选中的 local preset 提取稳定 state
2. 创建 team preset
3. 立即把新对象设为默认
4. 更新本地列表与当前选择
5. 清掉 local identity
6. 把 URL 切到新 team id

不允许出现“先切 URL，再尝试设默认”的半成功状态。

### 3. promotion source 仍然只能来自当前 local preset 对象

和前一轮一样，本轮 `升默认` 不读当前临时输入框，而是只读当前已选中的 local preset:

1. `field`
2. `value`
3. `group`

这样可以避免:

1. local preset A 被选中
2. 输入框临时又被改成状态 B
3. 最终默认团队视角落成一个不属于 A 的混合态

### 4. 成功后 URL 只能保留 team identity

`升默认` 成功后，同面板 URL 必须切到:

1. `bomTeamPreset=<id>`
2. `whereUsedTeamPreset=<id>`

并清理:

1. `bomFilterPreset`
2. `whereUsedFilterPreset`

这里的关键不是字段值还能不能恢复，而是地址栏必须明确反映“当前视角已经是团队默认资源”，而不是旧的 local 草稿。

### 5. local preset 不自动删除

本轮只切换 identity，不自动删 local preset。

原因:

1. 用户可能还想保留个人版继续试验
2. 团队默认视角和个人实验视角并不一定生命周期一致
3. promotion 的目标是沉淀团队资产，不是强制消灭本地迭代空间

## 实现范围

本轮实现集中在前端:

1. [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
2. [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
3. [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
4. [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)
5. [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
6. [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)

后端不新增 route，不新增 migration。

## 超越目标

这轮想超越的不是“再加一个按钮”，而是把 `/plm` 的过滤视角生命周期补成完整闭环:

1. local preset 可沉淀
2. local preset 可 duplicate / rename
3. local preset 可显式 deep link
4. local preset 可升团队
5. local preset 可直接升默认团队预设

这样下一步再做:

1. `clear default` 的 URL 一致性
2. 团队预设的 `duplicate / rename`
3. 多面板工作台级默认策略

都能继续沿用同一套 identity 和默认态规则。

## 风险与边界

### 1. 本轮仍不保留 local / team 双 identity

成功后不会同时保留:

1. `bomFilterPreset` 和 `bomTeamPreset`
2. `whereUsedFilterPreset` 和 `whereUsedTeamPreset`

这是有意约束，避免 `/plm` reopen 时恢复顺序再次变得含混。

### 2. 本轮不做团队预设自动重命名交互

同名冲突仍由后端安全命名策略托底，不额外弹窗让用户决定名称。当前目标是把主路径做顺，而不是再引入交互分支。

### 3. 本轮只覆盖 BOM / Where-Used

不把 `Documents / CAD / Approvals / Workbench` 一起卷进来，避免把“过滤预设”与“工作台团队视图”两套模型混成一层。

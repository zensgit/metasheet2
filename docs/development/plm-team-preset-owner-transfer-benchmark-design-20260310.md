# PLM Team Preset Owner Transfer 对标设计

日期: 2026-03-10

## 目标

上一轮已经把 `BOM / Where-Used team preset` 的生命周期补到了可协作状态：

1. `save`
2. `set default`
3. `clear default`
4. `delete`
5. `archive`
6. `restore`
7. `duplicate`
8. `rename`
9. `explicit deep link`

但这组对象还缺最后一条真正面向团队交接的治理动作：

1. `owner transfer`

本轮目标是把这条动作补上，并保持与现有 `team preset` identity 规则一致：

1. 允许当前 owner 把 `BOM / Where-Used team preset` 转给另一个用户
2. 转移后继续保留同一个 preset id
3. URL 继续保持当前 `bomTeamPreset / whereUsedTeamPreset`
4. 当前用户立即失去管理权限

## 对标判断

成熟协作产品里，“共享预设”如果支持转移 owner，通常都遵守同一条硬规则：

1. `ownership` 可以变化
2. `identity` 不应该变化

如果转移后 URL 被替换成另一个对象，或页面 silently 退回本地 preset，会产生两类裂缝：

1. 分享出去的 deep link 失效
2. 页面展示的是新 owner，地址栏却仍指向旧对象

这会直接破坏“链接即对象”的协作语义。

## 当前代码判断

当前 `BOM / Where-Used team preset` 的前端编排已经收口在：

1. [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
2. [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
3. [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)

因此真正缺的不是 panel-specific 逻辑，而是：

1. 后端缺 `team preset owner transfer` route
2. client 缺对应 API helper
3. 通用 hook 缺：
   - 目标 owner 输入状态
   - `canTransfer`
   - `transferTeamPreset()`
4. `BOM / Where-Used` 面板缺转移接线

## 设计决策

### 1. 只做 team preset，不扩散到 local preset

本轮只处理：

1. `bom team preset`
2. `where-used team preset`

不把 owner transfer 扩散到：

1. local preset
2. workbench team view
3. documents / cad / approvals team view

### 2. transfer 后保留原 id

owner transfer 的语义定为：

1. 更新 `owner_user_id`
2. 保持同一条 resource identity
3. 页面继续停在当前 `bomTeamPreset / whereUsedTeamPreset`

这保证：

1. deep link 不失效
2. 当前页面不需要重新选择对象
3. 当前显式 URL 不会悄悄回落成默认 preset

### 3. transfer 后立即收回当前用户的管理权限

当前用户一旦完成 transfer，就不应该还能继续：

1. `delete`
2. `archive`
3. `set default`
4. `transfer`

因此后端返回值必须重新计算 `canManage`，前端要立即替换当前列表项，而不是等下一次刷新。

### 4. 目标用户必须显式存在且可用

本轮不做“邀请不存在用户”或“按邮箱自动建用户”。后端只接受：

1. 已存在
2. `is_active = true`

的目标用户。

### 5. 不允许制造目标 owner 侧的重名冲突

如果目标 owner 在同租户、同 scope、同 kind 下已经有同 `name_key` 的预设，就直接拒绝转移，避免一转移就制造不可区分的重复名对象。

## 超越目标

这轮不是单纯多一个按钮，而是把 `PLM BOM / Where-Used team preset` 从“个人可管理的团队对象”推进到“可移交的团队资产”：

1. `ownership` 可以变化
2. `identity` 保持稳定
3. URL、当前页、数据库 owner 三者保持一致
4. transfer 后权限即时收口

这样 `BOM / Where-Used team preset` 才开始具备真正可交接的团队资产语义。

## 本轮不做

- 不做批量 owner transfer
- 不做跨租户 transfer
- 不做 share policy 扩展
- 不做通知或审计日志
- 不做 local preset owner transfer

本轮只解决一件事：

让 `PLM BOM / Where-Used team preset` 支持稳定的 `owner transfer + deep link identity`。

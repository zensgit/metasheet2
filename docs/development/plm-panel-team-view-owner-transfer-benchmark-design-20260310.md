# PLM Panel Team View Owner Transfer 对标设计

日期: 2026-03-10

## 目标

上一轮已经把 `Documents / CAD / Approvals team view` 的这组生命周期补齐到了可协作状态：

1. `save`
2. `set default`
3. `clear default`
4. `archive`
5. `restore`
6. `duplicate`
7. `rename`
8. `explicit deep link`

但它们还缺最后一条真正面向团队协作的治理动作：

1. `owner transfer`

本轮目标是把这条动作补上，并且保持与现有 deep link identity 规则一致：

1. 允许当前 owner 把 `documents / cad / approvals team view` 转给另一个用户
2. 转移后仍保留同一个 team view id
3. URL 不切换、不失效
4. 当前用户立即失去管理权限

## 对标判断

成熟工作台产品里的“共享视角”如果支持转移所有者，通常遵守两条硬规则：

1. `ownership` 可以变化
2. `identity` 不应该变化

如果转移后 URL 被重置，或页面偷偷切到另一个对象，会产生两类裂缝：

1. 分享出去的链接不再指向刚刚转移的对象
2. 当前页面看到的是新 owner，地址栏却还指向旧对象

这会直接破坏团队协作里的“链接即对象”语义。

## 当前代码判断

当前 `PLM panel team view` 的前端编排已经走到通用 hook 上：

1. [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
2. [PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmTeamViewsBlock.vue)

因此真正缺的不是 panel-specific 逻辑，而是：

1. 后端缺 `owner transfer` route
2. client 缺对应 API helper
3. 通用 hook 缺：
   - 目标 owner 输入状态
   - `canTransfer`
   - `transferTeamView()`
4. `Documents / CAD / Approvals` 面板缺转移接线

## 设计决策

### 1. 只做 team view，不扩展到 local preset

本轮只处理：

1. `documents team view`
2. `cad team view`
3. `approvals team view`
4. `workbench team view` 的通用能力复用

不把 owner transfer 扩散到：

1. local preset
2. team preset
3. 其他非 team 资源

### 2. 转移后保留原 id

owner transfer 的语义定为：

1. 更新 `owner_user_id`
2. 保持同一条 resource identity
3. 页面继续停在当前 `documentTeamView / cadTeamView / approvalsTeamView`

这保证：

1. deep link 不失效
2. 当前页面不需要重新选择对象
3. live shared URL 不发生漂移

### 3. 转移后立即收回当前用户的管理权限

当前用户一旦完成 transfer，就不应该还能继续：

1. `delete`
2. `archive`
3. `set default`
4. `transfer`

因此后端返回值要重新计算 `canManage`，前端要立即替换当前列表项，而不是等下次刷新。

### 4. 目标用户必须显式存在且可用

本轮不做“邀请不存在用户”或“按邮箱自动建用户”。后端只接受：

1. 已存在
2. `is_active = true`

的目标用户。

### 5. 不允许制造 owner 侧重名冲突

如果目标 owner 在同租户、同 scope、同 kind 下已经有同 `name_key` 的资源，就直接拒绝转移，避免一转移就制造不可区分的重复名对象。

## 超越目标

这轮不是单纯多一个按钮，而是把 `PLM panel team view` 从“个人可管理的团队对象”推进到“可移交的团队资产”：

1. `ownership` 可以变化
2. `identity` 保持稳定
3. URL、当前页、数据库 owner 三者保持一致
4. 转移后权限即时收口

这使 `PLM Documents / CAD / Approvals` 视角开始具备真正可交接的团队资产语义。

## 本轮不做

- 不做批量 owner transfer
- 不做跨租户 transfer
- 不做 team preset owner transfer
- 不做 share policy 扩展
- 不做通知或审计日志

本轮只解决一件事：

让 `PLM panel team view` 支持稳定的 `owner transfer + deep link identity`。

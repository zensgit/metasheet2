# PLM Team Preset Share 设计记录

日期: 2026-03-11

## 目标

为 `BOM / Where-Used team preset` 增加显式分享能力，让协作方拿到的是稳定的团队预设 identity，而不是一次性 local state。

本轮目标有三条：

1. `分享` 复制的链接必须显式带上：
   - `bomTeamPreset=<id>` 或 `whereUsedTeamPreset=<id>`
2. 分享链接必须保留当前筛选上下文：
   - `bomFilter / bomFilterField`
   - `whereUsedFilter / whereUsedFilterField`
3. fresh `/plm` 打开分享链接时，必须优先恢复显式 team preset，而不是被默认 preset 或本地 preset 覆盖

## 对标基线

当前 `/plm` 已经具备三类 identity：

1. local preset identity
2. team preset identity
3. workbench team view identity

其中 `team preset` 已支持：

- `default`
- `duplicate / rename`
- `delete / archive / restore`
- `owner transfer`

但还缺一条真正的协作闭环：把当前选中的 team preset 直接转成可复用 deep link。

这条能力的设计要求比本地 preset 更严格，因为：

- 分享出去的是协作对象，不是临时导出状态
- URL 恢复时必须继续保持 team identity，不允许 silently 回退成 local preset
- 后续 owner / archive / restore / default 生命周期都要围绕同一个 id 运转

## 方案

### 1. URL 模型

新增显式分享 URL 生成器：

- `buildTeamFilterPresetShareUrl('bom', preset, basePath, 'bom')`
- `buildTeamFilterPresetShareUrl('where-used', preset, basePath, 'where-used')`

生成结果：

- BOM:
  - `panel=bom`
  - `bomTeamPreset=<id>`
  - `bomFilter=<value>`
  - `bomFilterField=<field>`
- Where-Used:
  - `panel=where-used`
  - `whereUsedTeamPreset=<id>`
  - `whereUsedFilter=<value>`
  - `whereUsedFilterField=<field>`

其中 `field=all` 时不额外回写 field 参数，其他字段显式带出。

### 2. Hook 职责

在 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts) 中新增：

- `buildShareUrl`
- `copyShareUrl`
- `canShareTeamPreset`
- `shareTeamPreset`

约束：

1. 仅当前选中项存在且未归档时允许分享
2. 分享不改变当前选中 preset，也不改变 URL
3. 分享失败只走消息反馈，不修改当前 panel state

### 3. Panel 接线

在 `BOM / Where-Used` 两个 team preset action row 中新增 `分享` 按钮：

- [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
- [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)

由 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 透传：

- `shareBomTeamPreset / canShareBomTeamPreset`
- `shareWhereUsedTeamPreset / canShareWhereUsedTeamPreset`

## 超越目标

这轮不只做“复制 URL”。

真正要超过普通分享按钮的点有三条：

1. 分享链接带的是 team identity，本质上可继续承接后续 owner/default/archive 生命周期
2. 分享链接打开后恢复的是完整协作状态，而不是只恢复一个 filter 文本
3. live smoke 中显式识别了无效 seeded data 边界：
   - `parent_id` 不在当前 Where-Used UI field options 内
   - 最终验证改用 `parent_number` 作为有效协作字段

## 非目标

本轮不做：

1. team preset 权限收敛升级
2. share token / public link
3. preset 跨租户分享
4. panel team view / workbench view 的 share 统一入口

## 验证计划

代码级：

- `plmFilterPresetUtils.spec.ts`
- `usePlmTeamFilterPresets.spec.ts`
- `apps/web` package 级 `test / type-check / lint / build`
- 根级 `pnpm lint`

live/browser：

1. 创建 1 条 BOM team preset
2. 创建 1 条有效 Where-Used team preset
3. 分别点击 `分享`
4. 捕获复制出来的 URL
5. fresh `/plm` 打开链接
6. 验证：
   - preset id 恢复
   - filter value 恢复
   - filter field 恢复
   - 页面仍保持 team identity

cleanup：

删除本轮临时 preset，确认 live 列表回到空状态。

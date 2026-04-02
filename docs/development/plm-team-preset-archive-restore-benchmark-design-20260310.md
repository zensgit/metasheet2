# PLM Team Preset Archive / Restore 对标设计

日期: 2026-03-10

## 目标

前几轮已经把 `BOM / Where-Used team preset` 的主要显式 identity 语义补齐：

1. `save`
2. `set default`
3. `clear default`
4. `duplicate`
5. `rename`
6. `delete`
7. 显式 `bomTeamPreset=<id>` / `whereUsedTeamPreset=<id>` deep link

但还缺一条成熟视图系统常见的“软退出”路径：

1. 团队预设不想直接删掉时，应该支持 `archive`
2. 当前预设被归档后，URL 里的 team preset identity 应立即退出
3. 当前过滤状态应保留成匿名工作态
4. 被归档的预设应可以 `restore`
5. `restore` 后应重新回到同一个 preset id

本轮目标就是把这段 `archive / restore` 生命周期补齐到 `BOM / Where-Used team preset`。

## 对标判断

对标 `Notion archived database view`、`Retool saved view archive`、`Linear archived preset`，成熟系统通常遵守一条共同规则：

`archive 是 identity 退场，不是当前工作态丢失。`

也就是说：

1. 归档后，显式 `bomTeamPreset / whereUsedTeamPreset` 应从 URL 退出
2. 当前 `bomFilter / whereUsedFilter` 以及字段选择仍应保留
3. 归档对象仍可在目录中看到，但不能继续作为当前可应用 preset 使用
4. 恢复后，同一个 preset id 应重新回到 URL

如果归档后 URL 还残留旧 id，会形成失效 deep link。  
如果归档时把当前过滤状态一并清空，用户会丢失正在工作的视角。  
如果恢复后换了新 id，之前分享出去的链接就断了。

## 设计决策

### 1. team preset 改为支持 soft archive

在 [plmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmTeamFilterPresets.ts) 和 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts) 中引入：

1. `archived_at`
2. `isArchived`
3. `archivedAt`

同时新增两个动作：

1. `POST /api/plm-workbench/filter-presets/team/:id/archive`
2. `POST /api/plm-workbench/filter-presets/team/:id/restore`

约束：

1. 归档 preset 不可设为默认
2. 归档 preset 不可继续 `apply`
3. `save` 或 `duplicate` 都会显式写回 `archived_at: null`
4. `rename / set default / clear default` 对归档项直接阻断

### 2. 前端归档后退出 identity，但保留当前过滤状态

在 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts) 中，`archiveTeamPreset()` 会统一做几件事：

1. 把当前 preset 标记成 `isArchived`
2. 清空 `teamPresetKey`
3. 清空 `teamPresetName / teamPresetGroup`
4. 如果当前 `requestedPresetId` 指向该 preset，则同步 `syncRequestedPresetId(undefined)`
5. 保留当前 `filter value / field / group` 工作状态

也就是从“显式团队 preset”退回“匿名过滤工作态”。

### 3. 恢复后用原 id 重新占住 URL

`restoreTeamPreset()` 的行为不是只改列表项，而是：

1. 后端清掉 `archived_at`
2. 前端替换当前 preset 行
3. 通过 `applyPresetToTarget(saved)` 重新同步 `requestedPresetId`
4. URL 恢复同一个：
   - `bomTeamPreset=<same-id>`
   - `whereUsedTeamPreset=<same-id>`

这样 `archive -> restore` 的 identity 是闭环的，不会生成新 id。

### 4. 目录层显式暴露归档态

`BOM / Where-Used` 团队预设下拉不再把归档对象完全隐藏，而是显式标注：

`· 已归档`

同时：

1. 归档项不可 `apply`
2. 归档项不可 `set default`
3. 归档项可 `restore`
4. 当前下拉与动作按钮能力由：
   - `canApplyTeamPreset`
   - `canArchiveTeamPreset`
   - `canRestoreTeamPreset`

统一控制

## 超越目标

本轮不是只补两个按钮，而是让 `BOM / Where-Used team preset` 第一次具备完整生命周期层级：

1. `save / duplicate` 进入
2. `rename / default / deep link` 稳定
3. `archive / restore` 软退出与回归
4. `delete` 硬退出

这意味着 `PLM team preset` 已经从“可保存的团队过滤快照”，推进到更接近真正“团队过滤资源”的行为模型。

## 本轮不做

- 不做 team preset 独立归档列表分页
- 不做 archive 审计日志
- 不做 restore 后自动设为默认
- 不做 team preset 权限细分

本轮只解决一件事：

让 `BOM / Where-Used team preset` 在 `archive / restore` 后，URL identity、当前过滤工作态和目录可见性保持一致。

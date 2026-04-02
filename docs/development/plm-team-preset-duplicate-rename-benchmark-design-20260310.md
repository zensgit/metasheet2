# PLM Team Preset Duplicate / Rename 对标设计

日期: 2026-03-10

## 目标

前一轮已经让 `BOM / Where-Used` 团队预设具备了：

1. `save`
2. `set default`
3. `clear default`
4. `explicit deep link`

这几条显式 identity 语义。

但团队预设自身还缺一组会直接影响日常协作的生命周期动作：

1. `duplicate`
2. `rename`

本轮目标是把这两条动作补到和 `PLM workbench team view` 同等级：

1. 允许用户复制任意可见团队预设，生成自己的副本
2. 只允许 owner 重命名自己拥有的团队预设
3. `duplicate` 后立即切换到新副本 id
4. `rename` 后继续保持当前 id，不打断当前 deep link

## 对标判断

对标 `飞书多维表格视图复制`、`Retool saved views duplicate`、`Notion database view rename`，成熟的视图系统通常遵守两条规则：

1. `duplicate` 是“新身份”
2. `rename` 是“同身份改标签”

也就是说：

1. 复制后，URL 和当前选中项都应该切到新副本
2. 重命名后，URL 不应该跳回 source，也不应该丢掉当前 id

如果 `duplicate` 后 URL 还停留在旧 preset id，就会出现：

1. 页面看起来已经切到新副本
2. 复制出去的链接却仍指向旧对象

如果 `rename` 后 URL 被重置，就会出现：

1. 当前团队预设名称变了
2. 但显式 deep link 身份断了

这两种都属于协作级别的状态裂缝。

## 设计决策

### 1. 后端补齐 team preset `duplicate / rename`

在 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts) 新增：

1. `PATCH /api/plm-workbench/filter-presets/team/:id`
2. `POST /api/plm-workbench/filter-presets/team/:id/duplicate`

约束：

1. `rename` 为 owner-only
2. `duplicate` 允许复制当前用户可见的团队预设，但新副本 owner 固定为当前用户
3. `duplicate` 默认使用安全副本命名，不覆盖同租户现有名称
4. duplicate 出来的对象默认 `is_default = false`

命名规则下沉到 [plmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmTeamFilterPresets.ts)，避免 route 内散落字符串拼装。

### 2. 前端统一把 duplicate 视为“切换身份”

在 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts) 中：

1. `duplicateTeamPreset()` 成功后会把新副本插回当前列表
2. 立即 `applyPresetToTarget(duplicated)`
3. 通过已有 `syncRequestedPresetId` 语义，把 URL identity 切到新的 team preset id

这样做的好处是：

1. 不需要新增单独的 `syncUrlAfterDuplicate()`
2. `duplicate / save / set default / clear default` 继续共用一条主语义

### 3. 前端统一把 rename 视为“保留身份”

`renameTeamPreset()` 的行为设计为：

1. 就地替换列表中的当前 preset
2. 继续 `applyPresetToTarget(renamed)`
3. 不生成新 id
4. 不清空当前 deep link

这样可以保证：

1. 当前页仍然锚定同一条 preset
2. 复制出去的链接仍然是当前这条 preset 的链接

### 4. 本轮不改 team preset 权限模型

本轮只做生命周期语义补齐，不扩散到：

1. team preset 共享权限细分
2. archive / restore
3. 审计日志
4. 团队 preset 版本历史

## 超越目标

本轮不是只补 `BOM / Where-Used` 的两个按钮，而是让团队预设开始满足更高一级的协作语义：

1. `duplicate` 会形成新的、可分享的显式 identity
2. `rename` 不会破坏当前 deep link
3. `BOM / Where-Used team preset` 的身份语义已和 `PLM workbench team view` 对齐

也就是说，这条线已经从“能保存团队预设”推进到“团队预设可以稳定复制、重命名、深链接分享”。

## 本轮不做

- 不做 team preset `archive`
- 不做 team preset `restore`
- 不做更细的协作权限
- 不做 `delete` 后 URL 清理策略调整

本轮只解决一件事：

让 `duplicate / rename` 两个生命周期动作，也开始遵守统一的 URL identity 语义。

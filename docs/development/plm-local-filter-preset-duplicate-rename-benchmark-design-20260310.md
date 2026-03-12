# PLM Local Filter Preset Duplicate / Rename 对标设计

日期: 2026-03-10

## 目标

上一轮已经让 `/plm` 支持：

1. `bomFilterPreset=<local-key>`
2. `whereUsedFilterPreset=<local-key>`

但本地 preset 还缺两类真正可用的“视图级”操作：

1. 复制当前 preset，快速派生一条近似过滤视角
2. 重命名当前 preset，同时保持当前 deep link identity 稳定

本轮目标是让 `BOM / Where-Used` 本地过滤预设具备和 workbench/team view 类似的基础生命周期：

1. `duplicate`
2. `rename`
3. duplicate 后 URL 自动切到新副本 key
4. rename 后 URL 保持当前 key，不发生 identity 漂移

## 对标判断

如果对标 `Notion saved view duplicate`、`Retool saved filter copy`、`飞书多维表格视图另存为`，成熟产品不会只支持：

1. 新建
2. 删除

而缺少：

1. 复制副本
2. 重命名

因为真实工作场景里，用户更常见的路径是：

1. 基于已有 preset 派生一个相近版本
2. 对副本做小改动
3. 再把它稳定分享或收藏

所以本地 preset 的下一步不是“继续堆 field/value”，而是让 preset 本身具备最基本的对象操作。

## 设计决策

### 1. duplicate 必须生成新 key

复制不是“复用原 preset 再改名”，而是生成：

1. 新 key
2. 新 label
3. 同内容副本

这样 duplicate 后，地址栏里的：

1. `bomFilterPreset`
2. `whereUsedFilterPreset`

才会切到真正的新身份，而不是仍然指向原 preset。

### 2. rename 必须保持 key 不变

重命名的职责只改：

1. label

不改：

1. key
2. 当前 URL identity

否则 rename 会把“可读名称修改”升级成“资源身份漂移”，不利于深链接稳定。

### 3. duplicate label 采用可预测命名规则

为避免副本命名冲突，本轮 duplicate label 规则为：

1. `原标签 副本`
2. 如已存在，再递增为 `原标签 副本 2`
3. 继续递增

这样用户可以在无需额外输入的情况下直接得到可用副本。

### 4. rename 必须做本地冲突防御

本轮 rename 不允许：

1. 空名称
2. 与同面板现有 preset label 冲突

冲突防御只在同一 preset 集合内生效，不跨 `BOM` / `Where-Used` 面板。

### 5. UI 保持最小侵入

本轮没有再增加新的 preset 管理页，而是直接在两个面板当前的 preset action 区补：

1. `复制`
2. `重命名`

这样不引入额外导航，也不破坏当前工作流。

## 实现范围

本轮实现集中在前端：

1. [plmFilterPresetUtils.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmFilterPresetUtils.ts)
2. [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
3. [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
4. [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)
5. [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
6. [plmFilterPresetUtils.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmFilterPresetUtils.spec.ts)

后端不新增资源，也不修改 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)。

## 超越目标

本轮想超越的不是“再加两个按钮”，而是让本地 preset identity 的行为和其他已完成能力保持一致：

1. duplicate 会显式切换 identity
2. rename 会显式保持 identity
3. URL 和本地状态不会再分叉

这样后续如果继续推进：

1. local preset share
2. local preset batch manage
3. local preset promote to team preset

都可以复用这套 identity 规则，而不是继续靠匿名 filter state 勉强拼接。

## 风险与边界

### 1. rename 仍使用浏览器 prompt

本轮优先验证语义闭环，没有引入自定义弹窗状态机。后续如果要继续产品化，可以再把 rename 升级成更一致的内置对话框。

### 2. duplicate / rename 仅作用于本地 preset

本轮不扩展到：

1. team preset
2. team view
3. workbench view

它只解决 `BOM / Where-Used local preset` 这条线的对象操作一致性。

### 3. 本轮不做

- 不增加后端接口
- 不做跨浏览器同步
- 不做 local preset 权限模型
- 不做批量 duplicate / batch rename

本轮只解决一件事：

让 `PLM local filter preset` 在 duplicate / rename 后，保持稳定且可解释的 URL identity。

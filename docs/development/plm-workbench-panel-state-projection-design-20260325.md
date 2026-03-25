# PLM Workbench Panel State Projection Design

## 背景

[PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue) 会在 `documents / cad / approvals` 三块 panel 上比较当前本地查询状态和 route owner 对应的 team view state，来决定是否继续保留 `documentTeamView / cadTeamView / approvalsTeamView`。

之前这层比较有一半已经是“显式字段”，另一半还是直接拿 `activeView.state` 整对象比：

- documents / approvals 会先展开 `activeView.state`
- cad 直接比较 `activeView.state`

这意味着一旦持久化 state 将来多存一个无关字段，route owner 就会被误判成 drift。

## 问题

这类误判不是当前数据就会爆，但属于明显的前向兼容缺口：

1. 已保存的 panel team view state 将来增加新字段
2. 当前页面并不消费这个字段
3. watcher 仍然拿整对象比较
4. route owner 被错误清掉

结果会让用户在没有手动改筛选的情况下丢失 canonical team-view owner。

## 设计

把 panel route-owner 比较统一收成“显式字段投影”：

1. 在 [plmTeamViewStateMatch.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmTeamViewStateMatch.ts) 新增 `pickPlmTeamViewStateKeys(value, keys)`
2. `documents` watcher 只比较：
   - `role`
   - `filter`
   - `sortKey`
   - `sortDir`
   - `columns`
3. `cad` watcher 只比较：
   - `fileId`
   - `otherFileId`
   - `reviewState`
   - `reviewNote`
4. `approvals` watcher 只比较：
   - `status`
   - `filter`
   - `comment`
   - `sortKey`
   - `sortDir`
   - `columns`

## 结果

- panel route owner 的存活条件只跟当前 panel 真正使用的字段有关
- 后续给 team view state 增加新字段时，不会误触发 route owner cleanup
- documents / cad / approvals 三条 watcher 合同统一

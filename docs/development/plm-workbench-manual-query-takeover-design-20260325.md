# PLM Workbench Manual Query Takeover Design

## 背景

workbench team-view 的 canonical route owner 由 `workbenchTeamView` query 承载，但产品页允许用户继续手动改动 workbench query 相关字段。

旧实现里：

- `Apply` team view 会写入 `workbenchTeamView`
- 后续手动修改 query 时，不会自动消费这条 canonical owner

结果是 route 仍然看起来像“正在应用 team view A”，但本地查询已经偏离了 A 的 snapshot。

## 问题

这会带来两类错位：

1. URL 继续保留 `workbenchTeamView`
2. 后续 share/deeplink/route 恢复会把一个已经失效的 owner 当成当前 canonical state

## 设计

引入一条 shared 判断规则：

- `matchPlmWorkbenchQuerySnapshot(left, right)`
  - 对 workbench query 做 normalize
  - 显式忽略 `workbenchTeamView` 身份键
  - 只比较真正代表 state 的其余 query 字段

然后在 `PlmProductView.vue` 增加 workbench route-owner watcher：

1. 找到当前 `workbenchTeamViewQuery` 对应的 team view
2. 比较该 view 保存的 snapshot 与当前本地 workbench query
3. 如果发生 drift：
   - 清空 `workbenchTeamViewQuery`
   - `scheduleQuerySync({ workbenchTeamView: undefined })`

本地 selector 不清空，用户仍可以通过 `Apply` 重新回到该 team view。

## 结果

- 手动 query drift 后，canonical route owner 会被及时消费
- selector 仍保留，用户可一键重新应用原 team view
- 后续 share/deeplink/refresh 路径拿到的是更可信的 canonical state，而不是陈旧 identity

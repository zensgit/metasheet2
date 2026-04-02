# PLM Workbench Panel Route Takeover Design

## 背景

`workbench` 主面板已经支持在手动修改 query 后消费陈旧的 `workbenchTeamView` route owner，但 `documents / cad / approvals` 三条 team-view 面板仍保留旧行为：

- `Apply` team view 后会写入 `documentTeamView / cadTeamView / approvalsTeamView`
- 用户继续手动修改面板状态后，旧 route owner 不会自动失效

## 问题

这会让 URL 和真实面板状态脱节：

- route 仍像是在“应用 team view A”
- 本地筛选、字段、排序、review 输入其实已经偏离 A 的 snapshot

后续 deep link/share/refresh 都会继续消费这个陈旧 owner。

## 设计

引入 shared matcher：

- `matchPlmTeamViewStateSnapshot(left, right)`
  - 对 team-view state 做递归 normalize
  - 对对象键排序后再比较
  - 适用于 documents/cad/approvals 这类结构化 panel state

然后在 `PlmProductView.vue` 为三条 panel route owner 各自加 watcher：

1. 找到当前 route owner 对应的 team view
2. 将该 view 的 `state` 与当前面板本地 state 比较
3. 一旦 drift：
   - 清空对应 `*TeamViewQuery`
   - `scheduleQuerySync({ ...TeamView: undefined })`

## 范围

本轮覆盖：

- `documentTeamView`
- `cadTeamView`
- `approvalsTeamView`

`workbenchTeamView` 继续沿用上一轮的专用 matcher，因为它本质上比较的是 normalized route query snapshot。

## 结果

- 手动改动 panel state 后，旧 route owner 会及时失效
- selector 仍保留，用户仍可重新 `Apply`
- panel route owner 与真实当前状态重新一致，不再保留陈旧 identity

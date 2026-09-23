# 员工总览 section id 归位（#5966）

> 设计说明，对应 issue #5966。基准 `main` @ `cd42eaf74`。不合并。不依赖未合并的 #6004–#6007。

## 问题

员工总览上两张卡的 section id 对调了：

- 「异常」列表绑的是 `attendance-overview-request-report`。
- 「补卡申请」折叠卡绑的是 `attendance-overview-anomalies`。
- 真正的「申请报表」只在 `mode=reports` 渲染，总览上不存在。

因此「打开申请报表 / 查看申请历史」以及管理中心任务首页「异常」深链都落到错误卡片。异常行「创建申请」只写入日期和 `suggestedRequestType`，再滚到被占用的 anomalies id（补卡折叠卡），不会打开上屏专用补卡卡，也不带建议时间。

## 决定

1. **Id 归位。** 总览「异常」卡片绑 `attendance-overview-anomalies`。「申请报表」继续只在 reports 模式绑 `attendance-overview-request-report`。「补卡申请」折叠卡不再占用任何 overview section id（仍用 `data-attendance-request-tools`）。
2. **深链不再误开补卡折叠卡。** `shouldRevealOverviewRequestTools` 只对「我的申请」section（`attendance-overview-requests`）和带 `requestId` 的入口打开折叠卡。anomalies 与 request-report 不再打开它。任务首页「异常」href 保持 `/attendance?tab=overview&section=attendance-overview-anomalies`，落点改为异常列表。总览卡片在 `pluginLoading` 期间不挂载，section 聚焦在插件门禁结束后再跑一次，否则第一次 `getElementById` 找不到异常卡。
3. **总览跟进不再自称申请报表。** 总览没有申请报表卡。pending / rejected / approved 跟进动作改为 `my-requests`：滚到并打开「我的申请」折叠卡里的申请明细。pending / approved 按钮文案为「查看我的申请」；rejected 仍为「查看申请历史」。关注条同一优先级的 action 同步改为 `my-requests`。overview 上若仍有人发出 `request-report`，同样落到「我的申请」，而不是空的报表 id。reports 模式的 `request-report` 仍滚到申请报表卡。
4. **异常行「创建申请」走专用补卡卡。** 与关注条「处理缺卡」同一函数 `openDedicatedMakeupRequestCard`，并钉住被点的那一行。建议时间只填卡片上可见的那一个时间字段：
   - `missed_check_in` / `missed_check_out`：优先用 `rules/me` 的同日班次边界（`workStartTime` / `workEndTime`，且 `end > start`）；没有班次时，若该侧已有打卡且日期前缀等于工作日，再用该打卡的墙上时间。
   - `time_correction`（以及其它非下班缺卡类型，卡片可见字段是上班时间）：优先已有上班打卡，否则同日班次上班时间。
   - 没有可用时间就留空，不猜默认值。不改 `suggestedRequestType` 的计算。
5. **测试按正确语义改。** `attendance-selfservice-dashboard.spec.ts` 里把 `#attendance-overview-request-report` 当成异常卡的断言改为 anomalies id；总览上不再要求 request-report 节点存在。

## 非目标

- 不改异常计算，不改 `suggestedRequestType` 语义。
- 不改 #5963 的 setup-hint 门禁。
- 不把管理员「修改结果 / 批量处理」扩到新的权限面；这些按钮留在异常卡上，只是跟着卡片换 id。
- 不新增后端字段，不新增路由。

## 开放问题

- 专用补卡卡只有一个时间框。`time_correction` 的下班时间即使记录里有，也不会写进隐藏的 `requestedOutAt`，避免用户看不见却被提交。
- 跨日 / 倒序班次（`workEndTime <= workStartTime`）不生成建议时间，与请假半天预填同一条「不猜过夜班」规则。
- 打卡时间只取 ISO 字符串里的日期与时分前缀，不做时区换算。前缀日期与工作日不一致时视为不可用。

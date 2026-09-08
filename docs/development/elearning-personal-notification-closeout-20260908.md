# 云课堂个人通知最小收尾

Owner request: 完成云课堂收尾并接入通知系统（2026-09-08）。本文件仅约束个人通知增量，不扩大为完整 LMS，也不是部署或生产验收证明。

## 范围

- 复用现有 `elearning_notification_deliveries`、plugin worker 和钉钉工作通知 API，不创建群机器人或第二套收件箱。
- 指派/报名形成培训可开始提醒；服务端考试正式判分形成成绩公布提醒；保留既有催学投递入口。
- 通知正文为固定提示，引导本人登录学习中心。分数、是否通过、答案、评语、学习轨迹不进入外部消息。
- 学习时长在原学习页面展示，不逐次推送。这里不新增固定时刻开考调度、主管升级链或批量营销。
- `ELEARNING_NOTIFICATIONS_ENABLED` 默认 OFF、仅字面 `true` 开启，另外要求 master+CONTENT。各事件遵守原 assignment/enrollment/assessment 门。
- 自动事件要求部署方显式设置 canonical UTC `ELEARNING_NOTIFICATIONS_SINCE`；缺失拒绝采集，防止历史消息风暴。重启不改起点，不使用启动时刻冒充业务事件时间。

## 权威与发送

源事件、组织、接收者、业务防重键均来自数据库；仅允许同组织有效成员、有效目录关联与当前可访问课程。配置绑定同一目录集成，不用全局凭据偷偷替代另一组织的应用。身份不唯一拒绝发送。

发送前再次确认资格。外部副作用前，先提交 delivery 的不可逆 `dispatch_state=claimed`。竞争 worker 或进程重启看到已 claim 不能重新发送；成功记 sent、明确拒绝记 failed。超时、未知响应和最终状态写入失败保留 outcome_unknown，不能解释成“安全重试”。因此承诺防止自动重复调用，不虚称第三方恰好一次送达；极端进程退出可能留下待人工核查的未送达消息。

配置/取 token 等发送前失败可安全重试。`sent` 仅代表钉钉 API 接受发送任务并返回 taskId，不代表实际送达或已读；平台页面展示或单元测试不算真实收信证明。外部用户通知与服务端消息载荷均不包含敏感值。显式 cutoff 同时约束新事件采集和已有投递的 due_at，早于起点的待发送历史消息不能触发外部调用。

## 验收门

1. flags OFF：零新 SQL/发送；仅合法 exact flags 可运行；不同事件门不混淆。
2. 同组织/接收者/唯一目录绑定；跨组织、停用、关联歧义负控。
3. 同事件重复采集只有一条投递；异组织身份不合并。
4. 正式判分后才有成绩通知；通知载荷没有分数/答案/个人轨迹。
5. 两连接竞争、未知发送、重领、finalize 故障不可重复发；中和 fence 必须 RED。
6. 新迁移 apply/replay、空表 down/reapply、已有副作用禁止 down、trigger/default drift 必须 RED。
7. 专属 unit、既有 plugin 链和真库 whole-file 接线；共享 selector 保持 UNION，官方重算 provenance。
8. staging 使用专用测试组织/账号验证实际送达，记录渠道配置和权限就绪状态。不得向真实员工试发，不触及 production。

## 状态边界

本地实现与验证完成后提交，尚未部署或启用通知。仓内测试、远端 CI、合并、staging 部署、真实送达是五项独立证据；未取得后续证据前不标记整个云课堂最终完成。可选视频存储与 staging 完整培训流程另行验收，不由本通知报告替代。

## 本地验证记录

基线 `fd7cd2b2840b7c1e40ce8e2595229b595a4bc134`，独立分支 `codex/elearning-staging-closeout-20260908`。实现由 Sol 协助，Codex 集成与真库修复，Astra 只读反证复审；审阅指出的身份重绑、事件开关二次检查、发送前失败重试与历史积压 cutoff 已补对应负控。

- 六个 focused/neighbor unit 文件：notification delivery/dispatch/dingtalk/events、assignment reminder、port scoping；共 59 项（最后一次 cutoff 状态顺序修订由专属 15 项复验，再跑六文件组合）。
- 专用 PostgreSQL：按 CI `MIGRATION_EXCLUDE` 执行完整 395 个迁移与第二次重放；delivery 7/7 + worker 10/10，共 17/17。覆盖 schema/default/函数/trigger/FK 漂移、空表 down/reapply、有副作用禁止 down、两连接竞争及租约重领后的 sent/unknown 防重。
- 判别：中和 claim 返回行守卫，双执行发生重复发送，测试 RED；中和发送 cutoff，历史 pending 返回 sent，测试 RED；恢复后 GREEN。身份重绑、finalize 失败、正式判分才采集以及载荷不含成绩均有专属负控。
- plugin-elearning 全部 13 个 suite；e-learning wiring 15/15、notification delivery 4/4、worker 6/6、flag manifest 30/30；core typecheck/source ESLint/diff-check。
- 三个新增 unit whole-file 已纳入现有 workflow，只有新增行，原测试路径零删除；原 real-DB whole-file 接线复用。官方 provenance 重算唯一变化为 `evidenceFiles.pluginTestsWorkflow`；旧 pin RED、新 pin GREEN，完整 S5 chain 通过。
- 本机首次 S5 遇到依赖解析缺失，使用现有 backend 依赖路径重跑通过；最初真库发现的参数类型、目录数组类型和函数首尾空白兼容问题已修复并由最终 fresh/replay 覆盖，不以旧失败充当通过。
- 隔离测试数据库已 DROP；数据库名称前缀匹配残留 0，残留 backend 0，测试投递行 0。DB window released。Astra 最终只读复核：已审范围 P1/P2/P3 = 0/0/0，不替代真实渠道验收。

复验命令：

```sh
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/elearning-notification-dispatch.test.ts tests/unit/elearning-notification-dingtalk.test.ts tests/unit/elearning-notification-events.test.ts tests/unit/elearning-notification-delivery.test.ts tests/unit/elearning-assignment-reminder.test.ts tests/unit/elearning-reminder-port-scoping.test.ts
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm --dir plugins/plugin-elearning test
node --test scripts/ops/elearning-media-ci-wiring.test.mjs scripts/ops/elearning-notification-delivery-ci-wiring.test.mjs scripts/ops/elearning-notification-worker-ci-wiring.test.mjs scripts/ops/global-history-flag-manifest.test.mjs
pnpm --dir plugins/plugin-integration-core test:sealed-export-s5
# 仅指向唯一隔离测试库，先执行完整 migrate 及 replay：
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/elearning-notification-delivery.db.test.ts tests/integration/elearning-notification-worker.db.test.ts
```

上线剩余：合并后部署到 staging，配置专用测试组织个人钉钉映射与明确 cutoff，确认应用权限及测试接收者后再启发送门；执行一次培训通知/正式成绩通知/重复执行不重复通知的实际收信验收。不得直接启用全量真实员工通知。此处不包含邮件、群机器人、固定时刻开考推送或生产对象存储搭建。

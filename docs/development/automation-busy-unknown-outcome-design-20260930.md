# SA-06A1：先修既有投递 busy 与未知结果，不冒充完整运行端口

日期：2026-09-30。限定本地实施合同；基线 `b35d4cd1` 加当前 SA 累积变更。T 层既有行为修补，不新增端点、action、权限、消费者、DDL 或 flag，不改已有开关默认值；不访问客户、发送、发布或部署。

## 1. 真正依赖与本刀范围

SA-06 需要复用现有 Automation。但读码确认不能只传 AbortSignal：activation 丢 dispatch context，Service 吞 busy/失败，自动重领生成新执行根，人工 retry 又以历史 execution.id 恢复根；部分 sink 无幂等账本。完整取消、稳定身份和恢复需要共同合同，不能在本刀声称成立，也不新造 scheduler。

本刀只闭合两个可独立、安全修复的真实断点：

1. `automation-service.ts` 的 record/task/completion trigger 外层吞 `DurableSinkBusyError`。此错误来自真实 lease “另一执行者仍持有”，意味着本次不能执行也不能 ACK；吞掉后 registry 返回 success，outbox 会永久完成而丢工作。
2. `automation-executor.ts` 的 webhook/email Class-B 将 `skip_unknown` 与 `skip_sent` 一同返回 success/alreadyApplied。后续串行动作因此执行，原来“可能发送”的结果被改写成成功。已有 ledger 明确区分两者，不需要改变授权或建新表才能修复。

## 2. A：busy 必须真实到达现有 dispatcher

- 仅 durable flag 已开启时，三种 trigger 捕获真实 `DurableSinkBusyError` 后记住第一个，按现有行为继续处理其余独立匹配规则，循环结束后重新抛出它。
- 不用 error.message/name 字符串识别；普通错误不被本刀重新分类。现有 approval completion 的 FWB 可重试分支保留。
- 此 busy 经实际 registry 变成既有 retryable adapter_error，真实 dispatcher reschedule 而不是 complete。仍由既有 fence-CAS/backoff/lease 限制，不立即自旋重试。
- busy 所属规则不执行、不 markEventFiresDone；已经由其他规则完成的动作不撤销，再投递由各自既有 dedup 处理。done/no-match 正控制仍正常 ACK；flag OFF 兼容不变。
- 不在本刀把任意 failed execution 变成 throw/retry，不修 markDone false，不承诺所有 sink 的安全重放；那会涉及结果和持久身份的另一项合同。

## 3. B：未知不能通过重试变成成功

- 只改既有 Class-B webhook/email 两个实际执行消费者。`skip_sent` 保持 success + alreadyApplied、零二次发送。
- `skip_unknown` 固定 failed-shaped step，`output.outcome = 'outcome_unknown'`，固定 values-free reason/error，不能标 alreadyApplied=true，不能发送或覆盖原有 intent 状态。
- 必须覆盖 claimOutboundIntent 的三种 skip_unknown 来源：原有 unknown、原有 pending 在恢复时变 unknown、查不到行的保守拒绝。后两者也不能被当作成功。
- 使用现有 executor 失败控制流：普通串行尾动作及当前条件分支尾动作停止。当前 `PARALLEL_BRANCH_RUNTIME_ACTION_TYPES` 只允许 `update_record/send_notification`，webhook/email 作为 parallel 子动作会在执行前被拒；不得用伪造并行执行来证明未知结果处理。本刀保留此拒绝负控，不扩大并行 allowlist、不改变独立分支语义、不撤销已完成动作。
- 明确失败的 webhook pre-dispatch non-delivery 仍按已有 retry_failed 正控制处理；flag OFF、无 identity 的旧路径不变。不把没有真实远端回执的未知强改 sent，也不自动查外部系统。
- DingTalk card/person/group 仍有各自未知恢复逻辑，不在这两类发送消费者范围内；也不修跨 outbox 新 root 导致的另一重放问题。不得称“所有 Automation 动作可靠一次”或 SA-06 完成。

## 4. 验证与责任

先证明真实路径，再做单点变异。两名作者分 service 与 executor，不共写；第三人独立真链/反驳；主审串行掌管共享 test 配置、CI、pin、隔离 PG runner 与文档。

- A：三种真实 service handler 负例；registry→handler→service→真实 lease 的 busy，不用假 executor 或只测私有 runWithEventDedup 代替外层。独立匹配规则正控、done/flagOFF/no-match；至少一条新建临时 PG 的实际 dispatcher reschedule/不complete/持有者完成后新投递正常收敛，零跳过。数据库只能为本任务 disposable 实例，环境不读.env且禁止其他连接。
- B：真实 executor 两步/分支链，实际 intent primitive 与内存或临时 PG 边界；第一步 unknown 后相关尾动作零调用，重放不发送，sent 正控继续。已有 author suite 先取得行为 RED，不能只是修改 snapshot 让测试绿。
- 独立删除 A 三个传播点、B 两个未知分支，各自必须使对应真实用例失败。声明尚不能检出的降级与边界，不拿此结果证明取消/跨根幂等。
- 复跑相关 core 单元、真实 DB suite、类型/lint、实际 provenance 清单。本刀若只扩已登记 suite，不改 workflow；确需新增必跑文件才由主审处理实际登记和 pin。

## 5. 交付与继续工作

这是一批现有引擎的可靠性前置，不是新 IntegrationRunPort。后续仍需稳定根跨自动/人工 retry/resume 的持久合同、正确的失败/未知持久终态、可证明的取消与 sink fencing，再接具名受审只读动作。SA-02 在线管理权限裁决、宜搭可信权限/发送授权不因本刀自动获得。

回滚代码会恢复 busy 被 ACK、未知重放假成功的旧缺陷；不建议借回滚或改 flag 恢复未知外发。运行授权、配置默认值和历史 ledger 不被本刀清理/回填。

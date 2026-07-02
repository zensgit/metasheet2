# Approval & Process-Automation — first-batch per-rung decision ballot (2026-07-01)

> **Status: RATIFIED + SHIPPED as first-batch runtime.** The ballot is no longer awaiting votes. All four
> rungs were built and merged on the proposed defaults: T1-3 approval.completed trigger `#3467`
> (`f4451c945`), T1-1 slice-2 timeout transfer/jump `#3468` (`593df00e3`), T3-4 W7 non-approved
> resultWriteback `#3474` (`bceb9ab11`), and T0-3 delete_record editor exposure `#3477`
> (`264cac7fb`). The tables below are retained as the decision record; the `票` column now records the
> shipped disposition, not an open request for approval.

> **Per-rung ballot** (NOT blanket approval) for the four first-batch rungs picked by unblock-value:
> T1-3 · T3-4 · T0-3 (Lane C, sequential — same hot file) ∥ T1-1 slice-2 (Lane B). Each line = one open
> decision + the proposed default. **Vote per item:** ✅ adopt default · ✏️ override (state the change) ·
> ⏸ hold. A rung with all items ✅/✏️ is GO — build starts on the ratified defaults, fail-first + real-DB,
> PR-for-review. An un-voted rung stays gated. Full decision text + code anchors live in
> `approval-automation-decision-register-20260629.md`; this ballot **amends 3 defaults** with
> post-register facts (marked **AMENDED**, with the reason). Sizing figures are optimistic build-effort,
> **not calendar commitments** — review rounds on security/permission surfaces may dominate.

## T1-3 — `approval.*` automation trigger · M (~2–3pd) · Lane C first

| # | 决策 | 建议默认 | 票 |
|---|---|---|---|
| Q1 | 路由/范围键 | `config.templateId` **REQUIRED**;`loadEnabledApprovalRules(templateId)` 跨 sheet 查询,v1 无迁移/索引。**AMENDED:** register 原 default 声称 templateId 恒非空 —— 已被 register 自己的 reviewer note 证伪(`ApprovalInstanceRow.template_id` 是 `string\|null`,经 `nullableString()` → null)。修正:templateId 仍为唯一路由键;**null-template completion 显式声明 v1 out-of-contract**(永不匹配任何规则;fire 时若存在 enabled approval 规则则记 debug 日志),真实 null-template 消费者出现时立具名 follow-up | ✅ SHIPPED #3467 |
| Q2 | 跨租户授权 | create/update 时要求规则 createdBy 对配置的 templateId 持 `approvals:read`/模板可见性,fire 时复查;否则 deny+skip(复用 bridge 的 permission-code 查询) | ✅ SHIPPED #3467 |
| Q3 | record-less + action 白名单 | v1 无记录上下文(synthetic payload,`recordId=''`,审批事件挂 `triggerEvent`);action 仅允许 send_notification / send_webhook / send_email / send_dingtalk_*;含 record-targeting 或 start_approval 的规则在保存时拒绝 | ✅ SHIPPED #3467 |
| Q4 | 循环/深度防护 | (a) 结构性断环:禁 start_approval + record-writing(随 Q3);(b) synthetic 执行播种 `_automationDepth = (bridge 深度 ?? 0)+1`;(c) eventId 硬去重(见 Q5) | ✅ SHIPPED #3467 |
| Q5 | 幂等/重投递 | **AMENDED:** register 原 default 是"新建小 ledger"——T2-6 已落(#3450),改为**复用 `meta_automation_event_fires` claim-before-execute**,dedupKey = `approval.completed:{event.eventId}`(eventId 已含 `instanceId:toVersion:eventType`,天然唯一);**无新迁移**(同时消解 register 里 no-migration non-goal 与 Q5 的内部矛盾) | ✅ SHIPPED #3467 |
| Q6 | 触发器形状 | 单一 trigger type `approval.completed` + 可选 `config.outcomes?: ('approved'\|'rejected'\|'revoked'\|'cancelled')[]`(默认 approved-only) | ✅ SHIPPED #3467 |
| Q7 | 与 W6 bridge 的关系 | 互不抑制:bridge resume 与 fresh trigger 是不同消费者,所有 completion 事件都 fire fresh 规则(文档写明 X 启动的审批可触发自动化 Y) | ✅ SHIPPED #3467 |
| Q8 | conditions | v1 非目标:该触发器带非空 ConditionGroup 的规则保存时拒绝;审批字段条件词表是具名 follow-up | ✅ SHIPPED #3467 |

## T3-4 — W7 rejection backwrite · S-M (~1–2pd) · Lane C after T1-3

| # | 决策 | 建议默认 | 票 |
|---|---|---|---|
| D1 | 尾部语义 | **WRITE-BACK-THEN-FAIL**:非 approved 终态时先回写记录,run 仍按今日契约 terminal-failed、tail 跳过("拒绝时通知"的诉求由 T1-3 承接更干净) | ✅ SHIPPED #3474 |
| D2 | 存量规则 | **OPT-IN**:新增 `resultWriteback.onNonApproved`(默认 false);已保存规则行为不变,作者显式开启 | ✅ SHIPPED #3474 |
| D3 | 覆盖终态 | `toStatus !== 'approved'` 三态统一(rejected/revoked/cancelled) | ✅ SHIPPED #3474 |
| D4 | approverField 语义 | 写终态操作者(null-safe:`event.actor?.id ?? null`);文档写明非 approved 路径该字段含义是"完成者" *(注:keystone 测试与本项耦合 —— 若改此项,测试断言随之改)* | ✅ SHIPPED #3474 |
| D5 | select 校验强度 | LENIENT:保存端仍只校验 'approved' option;缺 option 的终态运行时 skip + `backwriteSkipped` 可观测,不新拒存量规则 | ✅ SHIPPED #3474 |
| D6 | 下游扇出 | 与 approved 路径对等:深度防护的 `multitable.record.updated` + realtime 照发(复用 `writeApprovalResultBack` 免费获得) | ✅ SHIPPED #3474 |

## T0-3 — delete_record 编辑器安全露出 · S (~1–2pd) · Lane C after T3-4

| # | 决策 | 建议默认 | 票 |
|---|---|---|---|
| Q1 | 跨 base 露出 | v1 **仅 same-base**(trigger-record delete);跨 base 保持 runtime-capable 但编辑器不露出,单独 gated slice | ✅ SHIPPED #3477 |
| Q2 | 防误删确认 | 必选 acknowledgement checkbox 阻塞 Save(文案:永久不可撤销);ack 存 authoring state,**不进 action.config**(serialize 显式 delete_record 分支输出干净 `{}`)。**建 build 契约补充:** 已保存规则编辑时 ack 预勾选、新加 delete action 必须重新勾;ack/hint 文案走 i18n 模块 | ✅ SHIPPED #3477 |
| Q3 | 爆炸半径 | trigger-record-only:same-base delete 只删触发记录(空 config),v1 无 id/字段路径选择器 | ✅ SHIPPED #3477 |
| Q4 | 保存端校验 | 扩展 `validateCrossBaseWriteConfig` 到 delete_record(和 lock_record)—— 与编辑器露出无关的 fail-closed-at-save 补防(该 action 本就 API 可存) | ✅ SHIPPED #3477 |
| Q5 | Test Run 语义 | 保持现状 + 编辑器非阻塞提示(Test Run 用合成记录、不会删真实记录);不为破坏性 action 特判 | ✅ SHIPPED #3477 |
| Q6 | 作者权限 | 与其它记录变更 action 对齐 `canManageAutomation`,本 rung 不加新 capability | ✅ SHIPPED #3477 |
| Q7 | 审计 | 复用既有 execution-log + `multitable.record.deleted`;独立破坏性审计/retention 仅在 owner 要求时再立项 | ✅ SHIPPED #3477 |

## T1-1 slice-2 — transfer/jump 超时效果 · M (~2–3pd) · Lane B(与 Lane C 并行)

*slice-1 已定且已上线(不投票):存储=approval_metrics 标量列 · remind 单发 · wall-clock 分钟 + 重入重置 deadline · afterMinutes 粒度。*

| # | 决策 | 建议默认 | 票 |
|---|---|---|---|
| Q1 | 本 slice 接通哪些效果 | **transfer + jump**;auto_approve/auto_reject 保留在枚举但 runtime-INERT,置于 `APPROVAL_NODE_TIMEOUT_TERMINAL_EFFECTS` env gate + 模板发布时确认之后(declared-but-do-not-wire 先例) | ✅ SHIPPED #3468 |
| QS-a | target 配置 schema(register 未单列,slice-2 必须定) | `timeout.transferToUserId`(静态单用户,publish 校验非空;role/chain 升级不在本 slice)· `timeout.jumpToNodeKey`(publish 校验:节点存在、approval 类型、非 parallel-region;直达 terminal 已有校验阻挡) | ✅ SHIPPED #3468 |
| QS-b | 间接级联 carve-out | timeout-jump 落点若自动完成(如 mergeWithRequester)并级联到 terminal = 事实 auto-approve → **归入 Q1 同一 terminal gate**:gate 未开则 fire 时 skip effect + 结构化日志(不 fallback 成 remind);gate 开启才允许级联 | ✅ SHIPPED #3468 |
| Q3 | 审计判别 | 复用既有 record actions(transfer/jump)+ `metadata.timeoutEffect=true`(adminJump 先例);不动 CHECK 约束 | ✅ SHIPPED #3468 |
| Q6 | parallel region | 区内 remind-only;parallel-branch 节点上的 transfer/jump/auto_* 超时配置 publish-reject | ✅ SHIPPED #3468 |
| Q7 | 执行者身份 | 保留系统 actor `system:approval-timeout` 记入 actorId+metadata;auto_reject(将来启用)合成 system comment 以满足 rejectCommentRequired | ✅ SHIPPED #3468 |

## 投票方式
- Historical voting instruction: direct chat replies or file edits were accepted while this ballot was open.
- Current as-built: all first-batch rungs are shipped; do not treat this file as an open authorization request.
- 第二批候选(仍需 per-rung GO):T1-2 inbound webhook · T3-5 cross-base backwrite · T2-1+2 · T1-4。

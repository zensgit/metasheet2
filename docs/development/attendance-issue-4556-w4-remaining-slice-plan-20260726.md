# #4556 W4 剩余切片执行计划（W4C-3a / 3b / 3c / 4 / 5）

> Status: **PLAN**（docs-only）。**不授予授权、不改任何 runtime、不构成开工。**
>
> Date: 2026-07-26 · 前置：W4C-2 的门审 findings 清零并合入（见 `…w4c2-remediation-plan-20260726.md`），
> 且 #4595 `AUTOMATION HOLD` 已由 owner 亲笔解除。
>
> 本文件回应 owner /goal 的第一条要求（「规划并计划开发」），把锁 §12.4-§12.8 的完成门翻译成可执行的
> 切片任务书与模型分配，使每片开工时无需再做设计。

## 0. 串行合同（锁 §12 逐字，每片一致）

每片：**独立 fresh-main PR** · **前序先合** · **独立对抗审 0 P1/P2** · **exact-head 测试与 mutation** ·
**不启用任何组织**。每个 cut-over 片额外须证：`legacy_projection_only` 下新覆盖的入口保留 flag-OFF 的
响应/投影字节、走 canonical boundary、且不插入任何 W4 calculation/outbox 行。

**跨片房规**（前四片门审累积，每片任务书都要带）：负例 stub 的失败点必须落在被测守卫之内 ·
点名「fails independently」逐条独立判别腿 · 多门互掩要分别 neuter 求排他失败（共享代码的变体亦算） ·
fixture 自然形状 · 「断言不发生」必配正控 · TOCTOU 必须构造真并发（双连接双 commit 序） ·
mutate 后核对命中真代码行 · 真库一律用**全新库**（共享库残留会造成假红） · 测试文件禁裸控制字节 ·
SHA 一律 `rev-parse` 直贴 · **每次合并前回读授权来源本身**。

## 1. W4C-3a — import / integration / rollback

**范围**：三种现代导入 transport（`values` / `unnest` / staging）、legacy import、integration sync、
semantic/provenance parity、append-only rollback。**债务**：P06-P11、P23、P24。

**门要点（锁 §12.4）**：三 transport 产出**同一** prepared result / projection / reversal chain ·
重复 batch item 折叠为一个 `(org,user,workDate)` 目标且按输入序 · rollback 恢复**冻结的 batch 前**父元组
而非 batch 内前驱 · CSV 与等价 XLSX **语义同、provenance 异** · integration 与 legacy import 得到同一
canonical W4 语义行，但其兼容投影**分开快照**（integration 缺 rule-engine/group-sync 的事实不得被冒充为
现代导入 parity） · 导入指标与冻结 legacy 规则引擎输出各自快照，**不一致 ⇒ `import_metric_conflict`
review 并阻断 promotion**（丢弃/零填/让导入指标覆盖 canonical 段结果 = 失败） · **恰 5000 条通过、5001
在 batch/item/staging COPY DML 之前失败**（authoritative 永不分块或部分提交；shadow 的显式越限证据不计入
promotion） · 首次导入 rollback 走 retire、更新导入 rollback 走 restore · 首次导入的 reversal 存**精确
after-image** 作非空历史投影 + 显式缺席 preimage + `retired/effective=false`，禁合成零/空默认 ·
rollback 一个被复活的导入 tombstone 或 review placeholder 时恢复其**精确**的 retired owner/pointer/
visibility/reason 元组，永不强制 active。

**风险点**：这是**数据面最危险**的一片（rollback 语义 + 5000 边界 + 三 transport 等价）。
**模型**：Sonnet 实现（事务/回滚/边界语义）；Fable 做 fixture 与 CI 接线；Opus 独立门。
**必备真并发腿**：同 batch 的 source 与 rollback 双 commit 序；staging COPY 与限额检查的顺序倒置。

## 2. W4C-3b — approval / correction / outdoor / cancellation

**范围**：canonical correction、leave/overtime、outdoor 首记录路径、冻结 request context、approval reversal。
**债务**：P12-P14、P17、P19、P22、**P26**（中心审批指派面）、P27/P28（schedule-fact 写者，见下）。

**门要点（锁 §12.5）**：首记录**不得**在无 request-time V2/context 时成为 authoritative ·
pre-W4 request 不得由当前配置升级；shadow 可完成其**精确 legacy 终态动作**加一条 unsupported W4 review，
而 authoritative 的 promotion 与终态动作在 legacy backlog 清零前**阻断** · promotion 要求每条待决
calculation-affecting request 的最新快照为 `resolved_v2`、与锁定 request payload 一致、且终态/反转链完整
（不可变的 `unsupported` 快照**不满足**此门） · request 创建与每次 pending edit 追加不可变快照；终态审批
绑定精确快照 version/hash 与返回的 approval record ID · **operation claim / suspension preflight 先于**
首个 request / event / approval / assignment / attendance-ledger DML · **P26 清单由实际 generic action
并集 + 每个 assignment-DML 调用点生成**，逐 action 同时测「普通考勤实例」与「携 `published_definition_id`
的对抗性考勤实例」——**按该字段做路由选择不能证明考勤不可达**。

**风险点**：跨插件的中心审批面（P17/P26）是**权限泄漏**风险最高处；本线此前已有「凭 org_id 单谓词可泄同事
数据」的同型教训。
**模型**：Sonnet 实现（身份授权 + 跨插件事务）；Opus 独立门。
**必备腿**：assignment mutation 与终态 decision 的序列化竞态（双连接）；对抗性实例的每个 action 各自独立腿。

## 3. W4C-3c — manual / recompute / operator / 最终清单

**范围**：不可变手工覆盖、**新增** prior-policy/default recompute 与显式 current-policy recompute（**新能力，
不得描述为既有路径迁移**）、移除 meta patch、canonical 化特权运维退役、**重生成最终 DML 清单**。
**债务**：P05、P15、P16、P20、P21、P25 及全部剩余项。

**门要点（锁 §12.6）**：手工覆盖在无关更新中存活直至显式取代 · set/unset/closed 状态校验器 ·
prior 与 current-policy recompute **可区分且可解释** · 退役写 `operator_retirement` **永不删除** ·
P15 生成式运维清理与每条 W4-backed P16 测试/staging 清理路径**都走 retirement**，工具专用 fixture
setup/teardown 单独命名、不得被误认为生产旁路 · 普通 punch/import/approval/recompute **不能复活**
operator-retired 父记录且失败时零写 · predecessor-null/错分支、legacy-preimage restore、import-then-live
证据丢失、从 first/last 反推——四类变异各自失败 · 直连服务的伪造授权与每个 entrypoint/capability 错配失败 ·
**P20 四个读面（anomaly listing / makeup-anomaly fact / open-record 归属 / DecisionTrace）各自使用 canonical
active-current helper，移除任一面的谓词只让该面的正控失败** · **最终生成债务集为空，CI 从 no-new-debt 转为
zero-bypass 硬执行**。

**风险点**：这是**收口片**——「最终清单为空」是硬门，任何前片遗留都会在此暴露。
**模型**：Sonnet 实现；Fable 做 collector 最终态与 CI 硬执行接线；Opus 独立门。

## 4. W4C-4 — shadow ledger and detail

**范围**：diff/backlog、dual-host detail、OpenAPI/client 生成、中性标签、decision-trace 集成。

**门要点（锁 §12.7）**：完整 dual-host 权限矩阵 · **same-org 他用户 404 与「不存在」等同**（禁存在性
oracle） · cross-org admin 伪造在 result SQL **之前**被拒 · **移除 subject/org 谓词必须导致测试失败** ·
未知 schema/enum fail-closed · 每条 ordinary-read SELECT 由生成式 current/history 清单分类，**新增一处直读
retired 行即失败** · unsupported trace 为 `undeterminable` · current-schedule/V1 重建与 raw-ID 变异失败 ·
OpenAPI lint/build/生成物 diff 干净。

**跨车道联动（必须在本片处理）**：本片接 decision-trace ⇒ 与 vNext Wave 5 解释面直接相交。W4 不可变证据
出现后，Wave 5 锁的 **posture 上限表须在其自身车道修订**，方可把 W4-backed 行呈现为 snapshot-grounded
（W4 锁 §10.3 已记该 follow-up）。**本片不得单方面改 Wave 5 的合同。**
**模型**：Fable 实现（读面 + OpenAPI 接线）；Opus 独立门。

## 5. W4C-5 — named synthetic staging soak（**独立 owner 授权闸**）

**这不是一个可由本车道自行开工的切片。** 锁 §12.8 + §14-9 明文：staging org 需**单独 owner 授权**。

**开工前置（逐条，缺一不可）**：单独 owner 授权 · exact image SHA · pending migrations **零** · 服务健康 ·
**禁通配符/客户数据/外部通知** · 每个 entrypoint 都有代表 · P16 staging 执行体与清理显式入清单（对 W4-backed
行的动态 SQL 或直接 DML 触发工具债务守卫） · 零「待决或仍可反转、且最新快照缺失/unsupported/payload 过期/
反转不完整」的 calculation-affecting request · 零未决 `legacy_time_ingress_not_authoritative` review（并有
负向 transition 测试） · **≥7 日历日、零 critical diff、零未决 review** · reversal 与 suspend/resume 演练 ·
authoritative suspend 保留 owner/pointer、离线重放干净、resume 回到 authoritative、首个变更打卡成功取代被保留
的 pointer · suspend/resume 后 authoritative retryable job 保持耐久且无 operation 行；shadow/unknown 的
accepted write posture **阻断** transition · 有效 pointer 与历史 hash 不变 · suspension preflight 零同步
source/result 写 · PASS 标记与残留归零。

**必须带入 soak 的预期差异清单**：W4C-1 裁量「`correction-applied` 无异常日 ⇒ 日 `adjusted`」与 legacy
`computeMetrics` 的差异是**已知预期差异**，若不入清单会被 soak 当作回归。

**日历时间提示**：soak 的 7 天是**日历时间不是开发时间**，其间可推进 W5/W6（各自门 + 各自授权）。

## 6. 之后（W5 / W6 / W7 / W8）

按原锁 §9：W5 单段 flex → W6 组有效策略只读聚合（**备料亦需另获授权**，见外部复核裁定）→ W7 组策略核算
切换 → W8 验证与收口。**issue #4556 的关闭 = owner 终裁**（锁 §14-10），不由任何门自动触发。

## 7. 模型分配总表（按代码难度，owner /goal 第二条）

| 面 | 模型 | 理由 |
| --- | --- | --- |
| canonical boundary / 身份授权 / 事务与 outbox 语义 / rollback 语义 | **Sonnet 5** | 正确性风险最高，需稳定的长链推理 |
| collector / fixture / CI 接线 / 读面与 OpenAPI | **Fable 5** | 机械面广、体量大 |
| 每片独立对抗审 · 设计锁审 · 语义漂移深读 | **Opus 5** | 门禁与裁量 |

（本表已按外部复核建议调整：boundary 与身份授权**不再**交 Fable。）

## 8. 交叉引用

- 锁：`attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md` §12.4-§12.8 / §14
- W4C-2 修复设计：`attendance-issue-4556-w4c2-remediation-plan-20260726.md`
- 开发及验证记录：`attendance-issue-4556-w4-development-verification-20260726.md`
- 授权 provenance 勘误：`attendance-issue-4556-w4-authorization-provenance-erratum-20260726.md`

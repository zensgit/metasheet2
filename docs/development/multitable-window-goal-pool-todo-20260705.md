# 多维表窗口 · 目标池规划与排序(TODO) — 2026-07-05

> 状态标记:✅ 已完成 · ⬜ 已解锁可执行 · 🔒 门禁中(owner 决策/前置未达)。
> 池子边界:**多维表窗口专属**。历史/恢复、审批自动化、数据库对接、考勤四条线各有开发窗口,本计划不进入其文件面;审批自动化窗口的编排计划另见 #3599,两份计划辖域不相交。
> 池子来源:S1 design-lock §8 arc ledger · 2026-06-29 benchmark refresh audit Tier-A/B 台账 · #3582 grid 性能基线 → #3591 GW design-lock · post-lightup 冻结清单 · benchmark-arc goal-todo 台账。

## 0. 调度纪律(硬约束)

1. **并发上限**:≤2 条 build 车道 + 1 条 design-lock/audit 起草车道 + 1 条云端车道。
2. **Grid 互斥锁**:`MetaGridTable.vue / useMultitableGrid / cells/*` 同一时间只允许一条车道占用(当前预留给 GW runtime)。
3. **每项交付双 MD**:design MD(design-lock,ratify 前)+ verification MD(runtime 落地后,含 golden 结果与非空转证明)。范本 = S1 线(#3569 设计 + #3593 验证)。
4. **模型分档**:设计/安全判断/对抗验证 = Fable 5;spec 完备的机械实现/文档装配/测试生成 = Sonnet 5(agent 显式指定;云端 routine 默认 Sonnet 5)。
5. **先清审后开新**:待审批次未清时不自动开启下一波 build 车道——待审队列膨胀与本纪律自相冲突。
6. **merge 节奏**:待审 PR 攒批集中审;合并按 rebase→等绿→立即合 循环处理 BEHIND 竞态。

## W0 — 审阅批次(等 owner 动作,非开发)

- ✅ **#3584 S1 runtime** — MERGED `4640f3662`(2026-07-05T02:26Z;head 含 post-review G7b)。S1 线(lock+runtime)全落地。
- ✅ **#3593 S1 验证 MD** — MERGED `efbf85f9`;S1 设计+runtime+验证台账闭合。
- ✅ **#3582 grid 性能基线** — MERGED `b891780bd`;结论固化为 flat 路径已解决,真缺口=grouped 视图。
- ✅ **#3591 GW design-lock** — MERGED `b061d4166`;grouped-path grid row windowing 已 ratify,`VIRTUALIZE_MIN_ROWS=60` 复用与 Playwright 验收条款进入 W2-4 runtime 前置。
- ✅ **#3574 OAPI allowlist⟺guard tripwire** — MERGED `c69c65a1`;route-file scope tripwire 已在主干。
- ✅ **S2 design-lock** — MERGED `9f08a4bf9`(#3618),prompt-config history render-only lock ratified; runtime tracked below.
- ✅ **S2 verification MD** — MERGED `912b18fb`(#3644),S2 runtime #3643 的 dev/verification 台账已落主干。

## W1 — 起草车道(W0 批次清空后启动;docs-only 零碰撞)

- ⬜ **W1-1 formula freshness / live-reactive audit design-lock**(Fable 5,audit-first)
  口径修正(2026-07-05,替代旧"grid 编辑触发公式重算"提法——该缺口已被超越):写路径 REST spine 的公式重算 **已存在**(`record-write-service.ts` Step 4c:物化回写 + 响应/实时补丁刷新),restore 亦经 canonical spine 触发重算(`univer-meta.ts:8880` 注释明确)。本项先 **audit** 界定剩余真缺口,再锁:
  (a) on-save vs live-reactive(输入过程中的实时预览)的产品口径;
  (b) **Yjs bridge 边界**——scalar CRDT flush 路径是否触发 Step 4c 或绕过;
  (c) restore/PIT 各边缘路径的重算覆盖面;
  (d) 跨记录/多跳传播深度(FOL fan-out 语义的跳数与失效边界)。
  产出:audit 结论 + design-lock(若 audit 证明缺口不成立则如实关闭,不硬造 slice)。
- ⬜ **W1-2 权限金矩阵主体 spec**(spec=Fable 5 → 套件生成=Sonnet 5)
  Tier-B #5 主体(#3574 仅 slice 1):row×field×base×OAPI 组合矩阵 spec 先行;显式排除历史窗口正在点亮的 flag 面,避免 golden 追逐移动目标。

## W2 — build 车道(各自 lock ratify 后解锁)

- ✅ **W2-3 S2 runtime**(prompt-config-history UI)— runtime MERGED `6e844cf89`(#3643); verification MD added in `multitable-ai-shortcut-prompt-config-history-s2-dev-verification-20260705.md`。
- ✅ **W2-4 GW runtime**(grouped 视图窗口化)— runtime PR #3648 已开:offset-table grouped windowing + jsdom goldens + Playwright 真浏览器前后数字 + verification MD。仍不含 grouped infinite-scroll / 跨页分组 / server-side grouping。
  W2-3 与 W2-4 文件面不重叠,可并行(不超并发上限)。

## W3 — 顺手批(单项 ≤半天;排在 W0 清空之后)

- ⬜ **W3-5 batchId===null real-DB golden + FE batchId 消费**(commit toast → History Center 批次深链)— 前置 #3584 已合,**ready**;Sonnet 5。
- 🔒 **W3-6 仪表盘 B4 非图表 widgets 批** — 先核 goal-todo 台账 browser-gated 语义再解锁;Sonnet 5。

## 🔒 owner 决策区(不排队列,仅列示)

- **S1b** 真批次回滚(restore 面扩展,design-lock first)· **S3** staleness 血缘 · **S4** cost 露出 · **S5** normalize kind(+ classify→select rider)——S1 lock §8 台账原样。
- **AI DARK→GA 点亮阶梯**(`MULTITABLE_AI_CONFIRM_LIVE_REQUESTS` double-confirm)——S1/S2 审计价值兑现前提。
- GW 后续:grouped infinite-scroll 接续 + 跨页分组数据模型(#3591 §6 点名的独立 slice)。
- 明确不做(维持既有纪律):移动端 / 模板市场 / 离线 / delete_record UI / Yjs GA(各自独立立项)。

## 默认执行序

清 W0 审阅批次 → 启动 W1-1/W1-2(并行)→ 任一 ratify 到达即启动对应 W2 项(保持并发上限)→ W3 插空 → 每项完成交付双 MD 并入下一审阅批次。

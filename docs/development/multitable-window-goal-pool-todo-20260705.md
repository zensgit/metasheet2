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

- ✅ **W1-1 formula freshness / live-reactive audit design-lock** — 已交付(audit `multitable-formula-freshness-audit-20260705.md` + design-lock `multitable-formula-freshness-designlock-20260705.md`;`LOCK-F` F1/F3 已在 `index.ts` Yjs bridge 落地、F4 故意留桩 + golden GF9、N4/N5 doc-only 锁定)。
  > 2026-07-07 独立 8-agent 代码级复审重导出同 4 条结论;唯一"新缺口"(recycle-bin undelete 无重算)**已被 N4 裁定**:undelete/reset 写入的是 PIT T-自洽物化值,**doc-only 锁定、不加重算**——再开"补算 slice"会**推翻已批 owner 决策**,故如实关闭,不建 slice。
  口径存档(勿复用为待办):写路径 REST spine 重算 **已存在**(`record-write-service.ts` Step 4c);(a) on-save vs live-reactive = 产品口径(无半成品 live 路径)· (b) Yjs 同表重算 = 有(taint parity),跨表 fan-out = F4/GF9 故意留桩 · (c) restore 家族过 spine,唯 undelete 快照回放 = N4 doc-only · (d) 单跳边界 = C1 RFC + FOL-3 已锁。
- ✅ **W1-2 权限金矩阵主体 spec** — 已交付(`multitable-w1-2-permission-matrix-spec-20260705.md`;row×field×base×OAPI 组合矩阵 + G-1…G-8 格子清单,§72-75)。Tier-B #5 主体(#3574 仅 slice 1)。
- 🔒 **W1-2-B B1–B4 权限 golden 生成** — 已有 spec(§72-75:B1 侧门×写修饰符/B2 oracle 泄漏/B3 管理面 403 矩阵/B4 差分×评论),但**执行需 owner/coordination go,非"已解锁可执行"**(权限膜/L3-leaning)。前置三条:①**#3789 合并后**(池纪律"先清审后开新");②**real-DB CI 可观测**——goldens 硬依赖 `DATABASE_URL` + sentinel(无本地 DB 跑不动,现只有旧 `d3d1/d3d2` real-DB 功能 golden);③**历史窗口 flag-set 冻结**(spec 要求排除其正点亮的 flag 面,避免 golden 追移动目标)。**多为 green-pinning 权限回归 goldens,不默认要求 observed-RED**;若要 fail-first 需逐格人工选择判别器。解锁后 = Sonnet 5 套件生成。

## W2 — build 车道(各自 lock ratify 后解锁)

- ✅ **W2-3 S2 runtime**(prompt-config-history UI)— runtime MERGED `6e844cf89`(#3643); verification MD added in `multitable-ai-shortcut-prompt-config-history-s2-dev-verification-20260705.md`。
- ✅ **W2-4 GW runtime**(grouped 视图窗口化)— runtime PR #3648 已开:offset-table grouped windowing + jsdom goldens + Playwright 真浏览器前后数字 + verification MD。仍不含 grouped infinite-scroll / 跨页分组 / server-side grouping。
  W2-3 与 W2-4 文件面不重叠,可并行(不超并发上限)。

## W3 — 顺手批(单项 ≤半天;排在 W0 清空之后)

- 🔒 **W3-5 batchId===null real-DB golden + FE batchId 消费**(commit toast → History Center 批次深链)— **非"已解锁可执行"**(2026-07-07 取证):①**跨窗口面**——深链目标 `HistoryCenterModal.vue`/`useHistoryCenter.ts` 属历史/恢复窗口文件面(池边界"不进入其文件面"),且正被其 4c 系列活跃改动(#3812 open、#3807/#3809 刚落);②**无 clear-spec**——仅本行一句,深链接口(commit-toast 如何以 batchId 打开 History Center)未定义,非 L2 clear-spec;③real-DB golden(仅 `plugin-tests.yml` DATABASE_URL 步可观测,无本地 DB)。**解锁前置**:与历史窗口约定深链接口契约(design-lock)、其 4c 系列收敛、real-DB CI 可观测。前置 #3584 已合但非唯一门。Sonnet 5(解锁后)。
- 🔒 **W3-6 仪表盘 B4 非图表 widgets 批** — 先核 goal-todo 台账 browser-gated 语义再解锁;Sonnet 5。

## 🔒 owner 决策区(不排队列,仅列示)

- **S1b** 真批次回滚(restore 面扩展,design-lock first)· **S3** staleness 血缘 · **S4** cost 露出 · **S5** normalize kind(+ classify→select rider)——S1 lock §8 台账原样。
- **AI DARK→GA 点亮阶梯**(`MULTITABLE_AI_CONFIRM_LIVE_REQUESTS` double-confirm)——S1/S2 审计价值兑现前提。
- GW 后续:grouped infinite-scroll 接续 + 跨页分组数据模型(#3591 §6 点名的独立 slice)。
- 明确不做(维持既有纪律):移动端 / 模板市场 / 离线 / delete_record UI / Yjs GA(各自独立立项)。

## 默认执行序

清 W0 审阅批次 → 启动 W1-1/W1-2(并行)→ 任一 ratify 到达即启动对应 W2 项(保持并发上限)→ W3 插空 → 每项完成交付双 MD 并入下一审阅批次。

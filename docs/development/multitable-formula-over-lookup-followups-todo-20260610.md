# 多维表 formula-over-lookup 链 — 后续项门控 TODO

> Date: 2026-06-10 · Status: **TRACKER(A-full #2450 MERGED `85f4c074b` 后)** · 配套计划:`multitable-formula-over-lookup-followups-development-plan-20260610.md`(含 FOL-1/FOL-2 完整设计锁定,经 4-agent 事实核验修订)
> 上游:派生字段借鉴计划 `multitable-derived-field-borrow-plan-20260526.md`(本链是其 Slice 3 backlog 项长出的独立修复链)
> 标记:✅ done · ⬜ todo(opt-in 后可动手)· 🔒 gated(被决策/前置阻塞)
> 纪律:每条独立 opt-in;**2026-06-10 owner 已授予 FOL-1 + FOL-2 全弧 opt-in(含并行开发)**。K3 post-GATE scoped gates 不受影响(本链全部为多维表内核打磨)。

---

## 0. 链史(全部 ✅)

| 环 | PR | 内容 |
|---|---|---|
| ✅ 特征化 | #1971 | formula-over-lookup 缺陷记录(stale + recalc 按 '0' 算) |
| ✅ A-min 设计 | #2246 | 同记录 link 编辑→同记录 formula 重算(design-lock) |
| ✅ A-min 运行时 | #2247 | PATCH 写路径 hydrated 重算;T4a 锁定 A-full 缺口为负向 |
| ✅ create 设计 | #2255 | create/submit/import 首算(design-lock) |
| ✅ create 运行时 | #2259 | 新记录 hydrated 首算 |
| ✅ A-full 设计 | #2410 | 一跳外表传播 design-lock |
| ✅ A-full 运行时 | #2450 | `85f4c074b` 2026-06-10。接缝扩展 + AF1-AF8 + AF6b;**含独立 review 全环**:REQUEST-CHANGES(F1 major:全公式重算 × actor 视角 hydration = 低权限 actor 持久 clobber 无关公式 8→1,真线复现)→ 修复 = 依赖门控结果兼任引擎重算白名单(A-full + A-min 双路径;create 保持全算)→ FIX-VERIFIED-APPROVE |

## 1. 进行中(owner 已 opt-in,并行 lane)

- [ ] ⬜ **FOL-1 相关记录下游失效(realtime fan-out + Yjs 读侧)** — Lane A
  - **缺口**:A-full 物化相关记录 formula 后,①相关表 realtime 零信号(Step 6 只 publish 源表);②相关记录的缓存 Y.Doc 无人失效(Step 3 钩子只拿源记录 id)。
  - **锁定要点**(详见计划 §2):纯失效信号零值上线;**发布门 = 受影响门**(F1 白名单同款,非 echo 即发——防放大);**fieldIds = 未掩码 affected 元数据**(helper 返回形扩展);actorId 跨表 omit / 同表携带;Yjs 读侧失效纳入;partialSuccess N× 成本显式接受;顺手修正 RWS 陈旧推值注释。
  - **测试**:R1-R7(发布门/未掩码 fieldIds/actorId 分裂/零 recordPatches/主事件回归/Yjs 双向)。
- [ ] ⬜ **FOL-2 dry-run 预览 hydration** — Lane B
  - **缺口**:#5c 真记录采样只取 RAW,"与生产一致"理由在 A-min 后倒置。
  - **锁定要点**(详见计划 §3):route 层 hydrate→mask→手填覆盖;**hydration 按表达式引用裁剪**(成本绑定);actor 视角;**joined-string 代入语义如实钉死**(`[100]`→`"100"`、`[]`→`""`、rollup null→`'0'`);引擎保持 no-DB。
  - **测试**:D1-D7;**新夹具(foreign sheet + links)是工作量主体**,非简单断言翻转。
- [ ] ⬜ **验证 MD**(两 lane 落地后):`multitable-formula-over-lookup-followups-verification-20260610.md`,per-slice 证据 + 本 TODO 终态打勾。

## 2. 门控项(沿用既有 gate,本链不重复拍板)

- [ ] 🔒 **FOL-3 递归/多跳传播** → Track C gate(C1 RFC 已拍:无具体多跳需求不建)
- [ ] 🔒 **FOL-4 formula→formula** → A2-full gate(A2-defense #1896 维持拒绝)
- [ ] 🔒 **FOL-5 lookup/rollup 物化** → C2b 存储 gate
- [ ] 🔒 **FOL-6 解析器算术(Option D / 多值 lookup 精确算术)** → B2 翻盘条件(预览/生产的 joined-string 语义统一受此 gate)
- [ ] 🔒 **FOL-7 协同(Yjs)路径重算** → 桥对 recompute helpers 维持 no-op stub;具名需求再议
- [ ] 🔒 **FOL-8 相关表 automation/webhook 触发**(物化不触发相关表自动化)→ automation 域独立 opt-in
- [ ] 🔒 **FOL-9 前端 off-page 失效策略**(filter/sort-on-formula 视图的"应进入"记录不自动出现)→ 前端事件处理独立议题

## 3. 落地纪律(沿用)

- 序列化对象新增字段 → 真实 wire 集成测试(wire-vs-fixture 纪律)。
- 单 PR 单链;`feat(multitable): …`;真库套件挂 `plugin-tests.yml`(FOL-2 文件已在列)。
- 不碰 `formula/engine.ts` / integration-core / RBAC / auth / migrations。

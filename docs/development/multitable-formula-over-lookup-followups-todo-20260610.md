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

## 1. 已落地(2026-06-10 同日收官,并行 lane)

- [x] ✅ **FOL-1 相关记录下游失效(realtime fan-out + Yjs 读侧)** — **#2464 MERGED `d0061a2c4`**
  - 9 项锁定决策零偏差落地:发布门=受影响门(echo-only 链接记录不入 recordIds);fieldIds=未掩码 affected 元数据(deny actor 钉死),HTTP echo 剥元数据(双层精确键集钉);actorId 跨表 omit / 同表携带;广播 payload 精确键集断言(无值键可能);Yjs invalidator 勘察为 record-id 全局键,相关 id 经既有 post-commit 钩子直传。
  - R1-R7 fail-first(R1/R2/R3 + 4 单元红→绿);review APPROVE-WITH-NITS,3 发现(时间戳 flake/wire 键集钉/R7 注释)合并前全修。
- [x] ✅ **FOL-2 dry-run 预览 hydration** — **#2465 MERGED `229a7ec5b`**
  - 7 项锁定决策零偏差落地:hydrate→mask→手填覆盖;表达式裁剪(D6 用查询捕获 + 未引用诱饵表证明零额外读);joined-string 语义按引擎实测钉死;#5c 注释更新;引擎 no-DB 不变量保持。
  - D1-D7 fail-first(6 红→绿,dryrun 套件 20→26);review APPROVE-WITH-NITS,F1(注释失实+link 死重)合并前修复,F2(hydration 先于 unknown_field 门)接受为成本注记。
- [x] ✅ **验证 MD**:`multitable-formula-over-lookup-followups-verification-20260610.md`(per-slice 证据 + 本 TODO 终态)。

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

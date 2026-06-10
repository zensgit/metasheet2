# 多维表 formula-over-lookup 后续两刀 — 验证报告 — 2026-06-10

> Status: **VERIFICATION(收官文档)** · 计划:`multitable-formula-over-lookup-followups-development-plan-20260610.md`(#2460)· TODO:同名 TODO(本报告落地时同步打勾)
> 范围:A-full(#2450)+ FOL-1(#2464)+ FOL-2(#2465)三刀的端到端证据链。
> 方法:每刀均走完整质量环 = 设计锁定(多 agent 事实核验)→ fail-first 测试 → 实现 → 本地全套验证 → 独立对抗 review → 发现修复 + 复核 → CI → admin-squash。

## 0. 落地总览

| 刀 | PR | squash | 质量环要点 |
|---|---|---|---|
| A-full 一跳外表传播 | #2450 | `85f4c074b` | 独立 review **REQUEST-CHANGES**(F1 major,真线复现)→ 白名单修复 → **FIX-VERIFIED-APPROVE** + AF6b 判别钉 |
| FOL-1 相关记录下游失效 | #2464 | `d0061a2c4` | 设计 19 声明 4-agent 核验(ready-with-edits,修正并入)→ 实现零偏差 → review **APPROVE-WITH-NITS**(3 发现全部合并前修复)→ CI 14 pass |
| FOL-2 dry-run hydration | #2465 | `229a7ec5b` | 同上核验 → 实现零偏差 → review **APPROVE-WITH-NITS**(F1 修复,F2 接受为成本注记)→ CI 14 pass |

## 1. A-full(#2450)— 证据

- **Fail-first**:AF1/AF2/AF4/AF5 实现前红(`expected 6 to be 51`、`expected 6 to be 101`),AF3/AF6 守卫绿;实现后 AF 全绿且 A-min T4a 按设计预言翻转(`expected 101 to be 10` → 断言改为 101)。
- **独立 review F1(major,已修)**:重算入口按依赖门触发后会评估记录**全部** formula 字段,而 hydration 是 actor 视角 → 低权限 actor(写 F + 写 M、对 G 无权限)改 F.target,M 上依赖 G 的无关公式 f2 被持久 clobber `8→1`(审查者真库真 PATCH 复现)。**修复**:`formula_dependencies` 门控结果兼任引擎重算白名单(`recalculateRecordFromData(…, onlyFormulaFieldIds)`),A-full 与 A-min 双路径生效;create/submit/import 首算保持全算(#2255 姿态)。复核以原探针对照:修复前 `f2: 1`,修复后 `f2: 8`;另发现修复顺带消除 stale-dep-row 过度触发与 legacy `=…` 字符串公式的破坏性 ride-along 求值。
- **判别加固(AF6b)**:复核 NIT-A 指出 AF6 用全权限 actor(修复前后值恒等);AF6b 用受限 actor 直接编辑 M.link,A-min 路径的同类 clobber 被判别性钉死。
- **本地验证**:相关集成 45/45(复核者跑)、单元 224 文件/2847(后增至 2865)、tsc 干净;CI 14 pass。
- Review 工件:`/tmp/pr2450-review-claude-20260610.md`、`/tmp/pr2450-fix-verification-claude-20260610.md`。

## 2. FOL-1(#2464)— 证据

- **设计核验前置**:4-agent workflow(19 承重声明 + 完备性批评)→ `ready-with-edits`;关键修正并入设计:fieldIds 必须未掩码(actor 掩码会坑两类接收方)、发布门=受影响门(echo 即发 = 放大路径)、前端主路径是 per-record `mergeRemoteRecord` GET、Yjs 读侧失效缺口纳入本刀、同表事件保留 actorId。
- **Fail-first**:集成 R1/R2/R3 红(`expected [] to have a length of 1`、自链第二事件缺失),单元 4 例红(publish 计数、invalidator 空调用、echo 元数据泄漏);R4/R5/R6 为既有行为回归钉(实现前即绿,符合设计)。
- **实现零偏差**(9 项锁定决策全部如锁落地);Yjs invalidator 键控勘察结论:record-id 全局键(`yjsBridge.cancelPending → yjsSyncService.invalidateDocs → yjsWsAdapter.notifyInvalidated`),相关 id 直传。
- **review APPROVE-WITH-NITS,3 发现合并前全修**:F1 时间戳 flake(`not.toContain('100')` 在 epoch 含 '100' 的确定性窗口误报)→ 改为广播 payload 精确键集断言(`['fieldIds','kind','recordIds','source','spreadsheetId']`,值键不可能存在);F2 wire 层 echo 键集钉(`['data','recordId','sheetId']`);F3 R7 source-undefined 生产语义注释。
- **本地验证**:新套件 6/6 + 相邻 27/27、单元 2865、tsc 干净。
- Review 工件:`/tmp/fol1-review-claude-20260610.md`。

## 3. FOL-2(#2465)— 证据

- **Fail-first**:6 红(`expected 1 to be 101`(raw 缺席按 0 代入)、rollup 未 hydrate、`expected +0 to be ""`、missing_sample 仍在)。
- **实现零偏差**(7 项锁定决策);joined-string 代入语义用引擎实测探针得出再断言(`[100]`→`"100"`→`+1`=101;`[]`→`""`;rollup null→`'0'`);D6 用 pool.query 捕获 + 未引用诱饵 foreign sheet 证明表达式裁剪(无 computed 引用 → 零 meta_links/foreign 读)。
- **review APPROVE-WITH-NITS**:F1(注释失实 + link 字段死重)合并前修复(`applyLookupRollup` 的 `fields` 只消费 lookup/rollup 条目,link 配置走 `relationalLinkFields`);F2(hydration 先于引擎 unknown_field 门 → 纯成本,受 `DRY_RUN_MAX_REFERENCED_FIELDS` 约束)接受为注记。
- **本地验证**:dryrun 20→26 全绿 + 相邻 FoL 套件 15/15、单元 2859、tsc 干净。
- Review 工件:`/tmp/fol2-review-claude-20260610.md`。

## 4. 边界自检(三刀共同)

- 未触碰:`src/formula/engine.ts`、migrations、central RBAC/auth、`plugin-integration-core`、前端、realtime 协议/publisher/CollabService、OpenAPI shape。
- 真库套件全部挂 `plugin-tests.yml` runner(A-full/FOL-1 加行;FOL-2 文件原已在列),`describeIfDatabase` + DB 哨兵 + runner 硬守卫覆盖 skip-when-unreachable 盲点;A-full 的 AF 套件已核实在 CI 真库 runner 实际执行。
- 已知局限按设计 §2.5/§3.1 留档:off-page 失效、相关表 automation/webhook 不触发(FOL-8/9 门控)、foreign 表字段级权限 parity、partialSuccess N× 成本、入房资格 JOIN 时校验。

## 5. TODO 终态

FOL-1 ✅ / FOL-2 ✅ / 验证 MD ✅(本文档);FOL-3..9 维持 🔒(各自既有 gate)。formula-over-lookup 链 + 两刀后续全部收官;该链当前无 still-open 实现项。

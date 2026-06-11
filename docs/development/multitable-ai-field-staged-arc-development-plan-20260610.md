# 多维表 AI 字段 staged 主线 + parity 清尾副线 — 开发计划 — 2026-06-10

> Status: **EXECUTION PLAN(docs-only)** · 配套 TODO:`multitable-ai-field-staged-arc-todo-20260610.md`
> 依据:总纲 `multitable-feishu-benchmark-20260522.md` §9-§10(sequencing #6 AI staged;最高战略 leverage 判定)+ 2026-06-10 完成度审计(5-agent 条目级核验,见 TODO §0)。
> 纪律:staged 单环 opt-in(每个 stage 一次显式批准,不自动开下一环);AI 一律 **fail-closed + 工件脱敏**;不碰 central RBAC/auth、`plugin-integration-core`、migrations(除非该环显式声明)。

## 0. 范围一句话

**主线**:把 AI 字段按既定 staged 路线推进——M0 决策批准 → M1 provider readiness → M2 后端(shortcut + 成本台账/配额执行)→ M3 前端 → M4 公式 AI 辅助(后置评估)。**副线**(与主线并行、零决策阻塞):stale 文档 reconcile、模板 preview/dry-run、图表补全、层级父链接约束钉、大表基线 harness 修复。

## 1. 既有资产盘点(不重复推导)

- **决策包已存在**:`multitable-phase3-lane-a1-ratification-table-20260515.md`(#1571)——R-1..R-3(RBAC)、OpenAPI A/B、响应 shape、E-1..E-12(环境变量契约)、P-1(provider 白名单)、Q-1..Q-4(默认配额)、T-blocker 边界(A1 declares / A2 enforces / A3 displays)。**M0 = operator 对该表逐行 markup**,本计划不重写它。
- **T-blockers 出处**:`multitable-feishu-phase3-ai-hardening-review-20260514.md`(T1-T7);A1 不关闭 T1/T3/T6,只声明形状。
- **前置已就位**:公式 dry-run 链(#1865/#1873/#2006/#2021 + hydration #2465)= 总纲排在 AI 前的基础设施,2026-06-10 已全部收官。
- **已失工件**:A1 实现设计稿(原 `/tmp`,未提交)——M1 第一步补一份**新的设计锁定**(尊重 M0 批准结果),属 staged 流程正常环节。
- **硬化门可复用**:D0 release-gate 骨架(#1541)、脱敏管线(`multitable-phase3-release-gate-redact.mjs`,`\bsk-` 规则已覆盖主流 key 形状)、`CONFIRM_*` 双确认模式(#1544 先例)。

## 2. 主线 — AI 字段 staged(每环独立 opt-in)

### M0 决策批准(零代码)
Operator 按批准表 §3 模板逐行 markup;结果**新增一份 ratification-result 附录文档**记录(原表保持 as-landed 不改写)。M0 完成判据:全部行有答案。
**✅ 2026-06-10 RATIFIED**(全按推荐 + owner 两修正)→ `multitable-ai-field-staged-arc-m0-ratification-result-20260610.md`。**修正一**:批准 ≠ 实现解锁——M1 实现 PR 额外需要 owner 显式解除 AI 线旧 defer gate(#1571 自身为 read-only/not-ratified 且 K3 门独立);设计锁定(docs-only)不受阻。

### M1 — A1 provider readiness(声明层)
1. **设计锁定 docs PR**(批准后即可先行;替代已失草稿;锁:resolver 形状、readiness 内部路由、状态机 `disabled/blocked/ready` + 4 个 A2 保留态、redaction 路径、按 M0 批准的 env 契约)。
2. **实现 PR**(🔒 另需 owner 显式解除 defer gate,见 ratification-result §3):provider resolver + readiness 查询路由(按 M0 的 RBAC/OpenAPI/shape 决议)+ 全套 fail-closed(无 key/无 enable → `disabled`;非白名单 → `blocked`)+ 工件脱敏测试。**不发真实 provider 调用**(`MULTITABLE_AI_CONFIRM_LIVE_REQUESTS` 双确认留给 M2)。
- 边界:不建新权限原语(R-3);不动 OpenAPI 公开面(M0 已定 Option B,**仅限 A1**);不写台账(T1 归 M2)。

### M2 — A2 AI 字段 shortcut 后端(执行层)
预置 prompt 的字段级 AI shortcut(摘要/分类/抽取/翻译):preview + run 端点、成本台账写入 + 配额执行(关 T1)、4 个保留状态推导(关 T6)、provider 错误→`blocked` 降级、值写入走既有 RecordWriteService 权威写路径。真实调用受双确认门。设计锁定先行;真库测试矩阵含配额触顶/脱敏/降级/权限。
**M0 修正二(约束)**:A2 是产品路径,**不得继承** A1 的 admin-only / internal-route 心智——preview/run 的 RBAC 必须在 A2 design-lock 按 sheet/field/record 权限与写入边界重新设计;API 面(internal vs OpenAPI)同样重评。

### M3 — A3 前端(体验层)
字段管理器 shortcut 配置 UI、单元格 preview/run、provider-blocked 安全态展示、成本/配额可见性(关 T3 展示)。设计锁定先行;遵守既有 i18n 模块扩展点。**M0 修正二同样适用**:display 面权限随 A3 design-lock 重新设计,不继承 A1 姿态。

### M4 — B2 公式 AI 辅助(后置)
🔒 M1-M3 验证后评估;依赖 readiness 基建,且需独立 opt-in。

## 3. 副线 — parity 清尾(独立小 PR,可与主线并行,互不依赖)

| # | 项 | 类型 | 要点 |
|---|---|---|---|
| S1 | stale 文档 reconcile | docs | 按 2026-06-10 审计证据翻正:phase3 plan/todo(B1/D2/D3/C1 四处 lane 级 stale)、open-items S1-10(多系列已由 #2297→#2354 落地)、research 对比文 §7-4(F1 #1897 已删干净);均加 reconcile 注记,不改写历史正文 |
| S2 | 模板 preview/dry-run | runtime | C1 余项:GET 模板预览(含样例数据)+ install dry-run(零写)端点 + 详情 UI;design-lock 先行(有 API 面);防覆盖 install(#1655)语义不变 |
| S3 | 图表补全 | runtime | scatter/area/funnel/gauge 渲染(后端聚合 `ChartData/ChartSeries` 复用,纯渲染层)+ S1-9 echarts 异步 chunk(`defineAsyncComponent` + spec 改 `flushPromises`) |
| S4 | 层级父链接约束钉 | runtime | 父链接字段 maxValues=1 校验(view-config 层),消除多值链接静默覆盖风险(三车道讨论稿 C1 遗留) |
| S5 | D2 50k/100k 基线 | ops | 修 harness 客户端(undici dispatcher/chunk,#1815 定位),跑出 50k/100k baseline 补全 perf budget;禁 async-import/seed-endpoint 路线 |

## 4. 执行纪律(沿用已验证流程)

每个 runtime 环:设计锁定(多 agent 事实核验)→ fail-first 测试 → 实现 → 真库套件 + tsc + 单元全集 → 独立对抗 review(major 必修复+复核)→ CI → admin-squash → 验证记录。真库套件挂 `plugin-tests.yml` runner;wire-vs-fixture 纪律;AI 相关一律脱敏断言 + fail-closed 断言。

## 5. 明确不在本计划

跨 base link/automation(总纲 #8,前提已齐但高风险,独立 opt-in)、FOL-3..9 / A2-full / B2 解析器 / C 多跳物化 / D outbox / F2(各既有 gate)、AI 自动化动作(M2 仅字段 shortcut)。

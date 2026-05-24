# Multitable Feishu Benchmark — v2 Errata + Roadmap Re-rank Verification

Date: 2026-05-22
Status: docs-only verification（无产品代码改动）
Subject document: `docs/development/multitable-feishu-benchmark-20260522.md` (v2)
Source v1 sha256: `e6b7c247d1bb5bc8daa2791f74ae5c380c35c80d2b3e7117cf56689e117430bb`

## 1. Purpose

本 verification MD 记录 benchmark v1 → v2 修订的事实修正证据 + sequencing rerank 决策依据，作为未来工程优先级讨论的可追溯锚点。

## 2. v1 stale facts — 修正前后对照

### 2.1 `send_email` 实现状态修正

**v1 claim**（错）："但 `send_email` 仅类型存在无 endpoint 实现"

**v2 证据 — 源码层已 ready**：

```text
packages/core-backend/tests/unit/email-transport-readiness.test.ts
  ├─ 'blocks smtp transport when required provider env is missing'
  ├─ 'passes smtp readiness when all provider env is present without sending email'
  ├─ 'blocks smtp readiness when port is invalid'
  ├─ 'blocks smtp readiness when optional transport values are invalid'
  └─ 'redacts smtp values and bearer-like secrets from markdown reports'

scripts/ops/multitable-email-real-send-smoke.test.mjs
scripts/ops/multitable-email-real-send-smoke.ts
packages/core-backend/tests/e2e/multitable-automation-send-email-smoke.spec.ts

docs/development/multitable-phase2-lane-b3-email-real-send-smoke-development-20260511.md
docs/development/multitable-phase2-lane-b3-email-real-send-smoke-verification-20260511.md
docs/development/multitable-rc-automation-send-email-smoke-development-20260507.md
docs/development/multitable-rc-automation-send-email-smoke-verification-20260507.md
```

**v2 修正**：源码已 ready（SMTP transport + readiness gate + real-send smoke gate + Phase 2 Lane B3 聚合门 + RC automation smoke）。真实差距是：
1. 生产环境真实邮箱回执证据（运维 + SMTP 凭证配置 + 实发归档）
2. 多渠道扩展（Slack / Teams / Lark Bot）— K3 PoC GATE PASS 后

### 2.2 OpenAPI spec 状态修正

**v1 claim**（错）："全 codebase 无 OpenAPI spec / Postman collection"

**v2 证据 — spec 三件套齐备**：

```text
packages/openapi/src/paths/
  ├─ admin-plugins.yml
  ├─ approvals.yml
  ├─ attendance.yml
  ├─ audit.yml
  ├─ auth.yml
  ├─ comments.yml
  ├─ data-sources.yml
  ├─ multitable.yml         ← 1602 lines（完整 multitable spec）
  ├─ permissions.yml
  └─ plm-workbench.yml

packages/openapi/dist/
  ├─ combined.openapi.yml
  ├─ openapi.json
  ├─ openapi.yaml
  └─ sdk.ts                 ← SDK auto-gen 已 ready

packages/openapi/dist-sdk/tests/
  ├─ approval-paths.test.ts
  ├─ plm-workbench-paths.test.ts
  └─ client.test.ts
```

**v2 修正**：spec source + dist + parity test 三件套齐备，sdk.ts 已 ready 未发布。真实差距是面向外部开发者的：
1. docs site（spec → ReDoc/Stoplight 静态站发布）
2. SDK 分发（npm / pypi / Go module — sdk.ts 已 ready）
3. Webhook HMAC-SHA256 签名（业内 table stakes）
4. 配额 / rate-limit / API key 治理
5. 错误码 reference（关联 audit MD §3.5 5 个 frontend fallback string）

## 3. Sequencing rerank — 决策依据

### 3.1 新增门槛 1：perf gate before virtual scroll

**问题**：v1 直接把 Grid 虚拟滚动列为 Tier 0 优先级，但未要求 baseline measurement。

**风险**：虚拟化做完无法证明 ROI；可能掩盖二阶问题（network bottleneck / server-side filter latency / Yjs sync overhead）。

**v2 修正**：
- **#1 D2 large-table perf gate**：10k/50k/100k 行 baseline（导入 / 查询 / 渲染 FPS / 导出 / 编辑延迟）→ 输出 perf budget
- **#2 Grid virtualization**：基于 #1 结果做，不盲改
- 原则：measurement-before-optimization

### 3.2 新增门槛 2：permission matrix as enterprise must-have

**问题**：v1 把权限相关项埋在 UX gaps（"Field-level conditional visibility"），低估了企业版核心需求。

**风险**：cross-base / AI / template 等后续 feature 都依赖权限基线稳定；若埋着不做，后续 feature 会持续暴露权限边界漏洞（尤其 export-with-permission-mask）。

**v2 修正**：
- **#3 D3 permission matrix gate** 升至顶层 — 与性能同级
- 5 类 golden test matrix：sheet / view / field / record / export × user role × granted/denied/inherited
- 重点防 export-with-permission-mask 安全漏洞

**证据 — 权限基础设施已部分存在**：
- `apps/web/src/multitable/composables/useMultitableRecordPermissions.ts` (Slice E 已扩 isZh)
- `apps/web/src/multitable/components/MetaSheetPermissionManager.vue` + `MetaRecordPermissionManager.vue` (T3C-2a)
- `apps/web/src/multitable/types.ts:325 MetaFieldPermissionEntry`
- 缺的不是基础设施，是 golden matrix test + export-mask 验证

### 3.3 新增门槛 3：AI provider readiness before AI field

**问题**：v1 把 AI 字段列为 Tier 2 Phase 1 直接做（4-6 周），但未拆分 provider readiness 前置。

**风险**：直接开 AI field type 会先引入：
- 成本失控（无 cost model / 无 budget cap）
- 合规风险（无 redaction policy）
- 失败态混乱（provider unavailable / quota exceeded / network error 各 case 行为不一致）
- 缓存缺失（重复调用 LLM 浪费）

**v2 修正**：
- **#5 Formula dry-run diagnostics** 先行：formula 基础设施（Slice C 已含 15 diagnostic），扩展为 dry-run mode（用测试数据预览公式结果），为 AI 字段铺路
- **#6 AI provider readiness + AI field shortcut** staged：
  - Phase 1: provider 选型（Anthropic Claude with prompt caching 推荐，与 metasheet2 主线一致） + cost model + redaction policy + blocked-state handling
  - Phase 2: AI field preview/run

### 3.4 调整：cross-base 留到最后

**问题**：v1 把 cross-base 列 Tier 2 战略差异化（4-5 周）。

**风险**：cross-base 操作会暴露：
- 权限边界（base A 用户能否触发 base B 操作？per-base scope vs cross-base scope）
- integration-core 边界（K3 PoC stage-1 lock 红线）

**v2 修正**：
- **#8 Cross-base link/automation** 最后做
- 双前提：#3 permission matrix 稳定 + K3/integration GATE PASS
- 仍是高战略价值，但风险曲线决定不应过早开

## 4. v2 8-step sequencing 总览

| # | 项 | Effort | 风险 |
|---|---|---|---|
| 1 | D2 large-table perf gate | 1 PR / 1 周 | 极低 |
| 2 | Grid virtualization（基于 #1）| 2-3 周 | 中 |
| 3 | D3 permission matrix gate | 2-3 周 | 低 |
| 4 | Grid BI polish | 2-3 周合计 | 低 |
| 5 | Formula dry-run diagnostics | 1.5-2 周 | 低 |
| 6 | AI provider readiness + AI field shortcut | Phase 1: 2-3 周；Phase 2: 4-5 周 | 高 |
| 7 | Template preview/dry-run/onboarding | 3-4 周 | 低 |
| 8 | Cross-base link/automation | 4-5 周 | 高 |

Quick wins 7 项不变（可与 #1-#5 并行），其中 Email send UI 修正为"补 UI + 配置流程"（源码已 ready）。

## 5. 后续 PR 序列建议

**immediate next slice — D2 large-table perf gate**：
- 1 个 docs-only + 1 个 perf-test PR
- 输出：baseline 报告 MD + perf budget 表 + 复现脚本
- 风险：极低（pure measurement，无代码改动）
- 决策价值：高（解锁 #2 虚拟化 ROI 论证 + 后续优化决策锚点）

**parallel quick wins**：
- Webhook HMAC 签名（3-5 天）
- `lock_record` action UI（2 天）
- Webhook retry + exponential backoff UI（3-5 天）

## 6. 验证清单

- [x] v2 benchmark MD 已修订（in-place）
- [x] §13 Changelog 完整记录 v1 → v2 差异
- [x] 2 处 stale fact 修正含 file:line 证据
- [x] sequencing rerank 含决策原则（measurement before optimization / enterprise baseline before differentiation / foundations before advanced / stability before risk）
- [x] 本 verification MD 含 v1 → v2 完整 traceability
- [ ] v2 benchmark MD + 本 verification MD push 入 main（pending operator confirmation）
- [ ] D2 large-table perf gate scout + design MD（next slice，待启动）

## 7. 文档版本约束

未来 benchmark v3 触发条件（之一即可）：
- D2 perf gate 完成后 baseline 数据回填
- 任一 Tier 1 (#3 permission matrix / #4 BI polish) 完成后 gap 项 close
- 新发现 stale fact（保持事实纪律）

文档应在工程切片完成时同步更新对应 gap close 状态；保持 v2 作为 active baseline 直到 v3 触发。

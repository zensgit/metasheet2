# Data Factory 阶段二 — TODO (gated checklist) - 2026-05-26

> **图例:** 🔒 blocked-by-gate · ⬜ ready-when-unlocked · ✅ done · ⏸ deferred
> **全部 gated:** K3 PoC GATE PASS + 阶段二 unlock + 每个 PR 单独 opt-in。**Gate 0 今天未过 → 下面一项都不启动。**
> 这是 #1839 DF-N0..N4 phasing + #1874 偏好的执行清单，**非新设计、非开建授权**。

## Gate 0 — 前置门（未过）
- [ ] 🔒 K3 PoC **GATE PASS**（S3 read/list 决定 + S4 单记录 Save 回归仍未闭）
- [ ] 🔒 阶段二 **unlock** 决定（owner）

## 已完成（Stage-5 监控）
- [x] ✅ DF-N1 只读运行监控 UI（#1848）
- [x] ✅ DF-N1.5 单条手动 dead-letter 重放（#1857）
- [x] ✅ #1838 addendum：DF-N2 JSONB + FaaS-自有沙箱偏好（#1874，OPEN）

## DF-N2 — Provenance 逐记录血缘 〔最近 · 最低风险〕
- [ ] 🔒 **N2-1** contracts：`ProvenanceEvent` 形状 + 11 event-type 枚举 + 脱敏契约 + OpenAPI　·　测试：schema parity / 非法枚举拒绝
- [ ] 🔒 **N2-2** runtime：现有 run/exception 上加 JSONB lineage + by-`rowId` 视图；runner 每步追加脱敏事件　·　测试：脱敏 / 每步追加 / **跨 run** by-rowId / **新字段真 wire round-trip**　·　plugin-local SQL（`migration-sql.test.cjs` 守门）
- [ ] 🔒 **N2-3** frontend：`IntegrationWorkbenchView` 逐行血缘时间线（只读）　·　测试：时间线渲染 / 不显示 secret

## 配置层 C — operator 5 段式后端 〔可与 N2 并行〕
- [ ] 🔒 **C-1** contracts：`ConnectorProfile`/`DatasetDefinition`/`MappingRule` 类型 + OpenAPI（映射现有表，Dataset 是新增）
- [ ] 🔒 **C-2** runtime：`DatasetDefinition` 持久化 + read/write capability 显式化　·　测试：**只读源拒绝 upsert** / 非法枚举拒绝
- [ ] 🔒 **C-3** frontend：5 段式 stepper（数据源→数据集→数据准备→测试发布→运行监控）
- [ ] 🔒 **C-4** frontend：dry-run **写前强制**守卫（对齐 #1826 C5）

## DF-N3 — Retry + Back-pressure 〔改 runtime 语义 · 最高风险 · 需 N2 + 多记录相关性〕
- [ ] 🔒 **N3-1** contracts：`RunPolicy`（max rows、连续失败→暂停、5xx 退避、auth-fail 硬停、validation→dead_letter）
- [ ] 🔒 **N3-2** runtime：选定失败行有界 retry　·　测试：**不含此前成功行** / idempotency 防重复写
- [ ] 🔒 **N3-3** runtime：back-pressure / 停止规则　·　测试：每条规则 / 暂停可见（多记录解锁后才真正生效）
- [ ] 🔒 **N3-4** frontend：bulk retry UI + run-policy 编辑器

## DF-N4 — 连接器目录 + 第 2 家 ERP 〔证明「通用」· 需 2nd vendor + PoC 证据〕
- [ ] 🔒 **N4-1** contracts：dataset 模板标准化；K3 WISE 变**预设模板**
- [ ] 🔒 **N4-2** runtime：HTTP / SQL 只读 / CSV·Excel 模板　·　测试：各过 `adapter-contracts.test`
- [ ] 🔒 **N4-3** runtime：**第 2 家 vendor adapter**（同契约、不 fork）　·　测试：golden 契约套件对 vendor2 通过
- [ ] 🔒 **N4-4** frontend：连接器目录 UI

## FaaS 逃生舱 〔阶段二+/阶段三 · 最后 · 独立安全评审〕
- [ ] 🔒 **F-1** design：安全模型 RFC（沙箱/资源上限/密钥隔离/SDK 面/威胁模型）
- [ ] 🔒 **F-2** runtime：function-adapter 宿主，长在 `plugin-sandbox.ts`/`PluginIsolationManager.ts`（**非 Aliyun FC**；长/异步超时）　·　测试：逃逸被挡 / 资源超限被杀 / secret 不泄漏
- [ ] 🔒 **F-3** runtime：托管凭据 / parameter-context（作者不见 secret）
- [ ] 🔒 **F-4** frontend：连接器编写面（**仅集成者/admin，RBAC 门控**）
- [ ] 🔒 **F-5** runtime：连接器级 logging/quota/governance

## 贯穿全程（每个 PR 都要）
- [ ] 4-lane 分支（contracts/runtime/frontend/integration）· conventional commit · self-review + admin-merge
- [ ] OpenAPI parity 门 · wire-vs-fixture round-trip · enum 严格 · 脱敏强制 · 触权限走 real-DB golden 门
- [ ] integration-core = plugin-local SQL（`migration-sql.test.cjs` 守门）· 部署查 pending-migration + auth round-trip

## 解冻当天的最小起点
- [ ] ⬜ **先做 N2-2（JSONB 血缘）单 PR**，再 C-1/C-2。**不要**从 FaaS / DF-N4 起步。

## 永不违反的硬锁
- K3 Save-only / 单记录；无 Submit/Audit/BOM/多记录（除非 owner 决定）
- 业务用户面**永远只配置**，绝不开任意 JS/SQL 编辑器

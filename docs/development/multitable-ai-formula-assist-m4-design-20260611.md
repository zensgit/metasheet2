# 多维表公式 AI 辅助(M4 / Lane B2)— 设计锁定 — 2026-06-11

> Status: **DESIGN-LOCK(docs-only)** · 主线 arc 最后一环 M4;**owner 已预授(2026-06-11),实现不停问**。
> 依据:M4 deferred-eval(5 问,file:line)——全部为工程调用,零 owner 决策。M0-M3 基底已全建。
> 前置:rank 9 台账留存(留存契约先于 M4 这第三个台账写入方)。K3:多维表内核;不碰 central RBAC/auth、`src/formula/engine.ts`。

## 0. 范围一句话

NL→formula 建议:用户用自然语言描述公式 → AI 提议一个候选表达式 → 经既有 formula dry-run 校验 → 用户**手动接受**(零自动落库)。复用 A2 reserve-then-settle 台账/配额 + dry-run 链;新增一个 suggest 端点 + 字段管理器内的 UI 接缝。

## 1. 锁定设计(eval 推荐,全工程调用)

### 1.1 台账扩展(§1,type-only)
- `AiUsageAction` 加 `'suggest'`(`services/ai-usage-ledger.ts:46`)。**零迁移**:表的 `field_id`/`record_id` 已 nullable(migration zzzz20260611090000),`AiUsageLedgerEntry` 的 fieldId/recordId 已 `?: string|null`,insert 默认 null。suggest 行 record_id/field_id 为 NULL(sheet 级),reserve/settle/配额 SUM 不按 scope 过滤,语义不变。

### 1.2 数据最小化(§2)
- prompt context = **字段 names + types only,绝不送 record values**(公式创作是字段定义上下文,非记录读)。字段名按 schema 元数据处理(同 SQL 列名;dry-run #5c 已送 `{id,type}`)。
- **安全兜底(锁)**:组装后的完整 prompt 仍过 A2 同款 `redactString` gate(`routes/multitable-ai.ts:250-267`,`!==` 即拒)——secret 形状的字段名/描述会触发 unsafe_input 拒绝。instruction(用户的 NL 描述)同 A2 受长度上限 + 扫描。
- (若 operator 日后要按字段名过滤 = 配置决策,非本刀;默认不过滤,gate 兜底。)

### 1.3 dry-run 候选 + 成本上限(§3)
- **每请求一个候选**(同 A2 preview);"重新生成" = 客户端发起新 HTTP 请求(无服务端多候选循环——复杂度+成本不可控)。
- 成本上限**继承 A2 reserve-then-settle**:1 suggest = 1 reserve(advisory lock + 保守估算)+ 1 settle;N 次重生成 = N 个独立 reserve,配额门挡住失控(reserve 失败 → `quota_exhausted`)。
- 候选校验复用既有 `POST /formula/dry-run`(无写、无 canManageFields 门、零成本):候选非法 → 返回诊断给用户(不落候选、不二次调 AI);合法 → UI 展示候选待接受。

### 1.4 产品路径 RBAC(§4,修正二)
- 端点 `POST /sheets/:sheetId/ai/suggest-formula`,守卫 = **`canManageFields`**(公式创作是字段级操作,sheet 级,非记录级)——区别于 A2 shortcut run 的 `requireRecordReadable + canEditRecord`(记录级)。不继承 A1 admin-only/internal 姿态(修正二)。复用既有字段写 RBAC 原语(`permission-service.ts:162/1010/1021`)。
- 端点 internal 姿态待定:与 A2 一致(自有前端,不进 OpenAPI),per-route 守卫。

### 1.5 编辑器 UI 接缝(§5,Option A)
- 接入 `MetaFieldManager.vue` 既有 formula dry-run 面板(~:176-216,`configTargetType==='formula'`):表达式 textarea 旁加 NL 输入 + "生成公式" 按钮 → 候选展示在 code 块 + 接受/拒绝/重生成;接受 = 拷进 textarea → 既有 "Test"(dry-run)校验。
- 复用 A3 `useAiShortcut` 的状态机/错误映射模式(按 error.code:blocked/rate_limited/quota_exhausted/unsafe_input/provider_error;双确认门);i18n 加 `field.formulaSuggest.*` 键进既有 `meta-manager-labels`。
- 双确认门(readiness ready + E-12)同 A2。

## 2. 边界(硬性)
单候选同步;无服务端候选循环;无自动落库(用户手动接受);不碰 `src/formula/engine.ts`(dry-run 复用既有);无迁移;A2 台账/配额语义不动(仅加 enum 值);provider 客户端复用 A2(fetchFn DI,测试零真实调用)。

## 3. 测试矩阵(fail-first)

| # | 场景 | 断言 |
|---|---|---|
| M4-T1 | readiness≠ready 或 E-12≠1 | suggest `blocked`,fetch spy 零调用,台账 blocked 行(action=suggest,record/field NULL) |
| M4-T2 | RBAC:无 canManageFields | 403;有则成功 |
| M4-T3 | 成功路径 | AI 返候选 → 端点回候选 + dry-run 校验结果;台账 success 行 action=suggest tokens>0 |
| M4-T4 | 候选非法(dry-run 诊断) | 返回诊断,不二次调 AI,无额外成本行 |
| M4-T5 | 配额触顶 / 限流 | quota_exhausted / rate_limited,零调用(限流不写台账) |
| M4-T6 | unsafe_input:NL 描述或字段名含 secret 形状 | 拒发零调用 |
| M4-T7 | 泄漏哨兵 | key 不出现在响应/台账/日志;record values 从不进 prompt(spy 捕获请求体断言只有 names+types) |
| M4-T8 | 台账非干扰 | suggest 行(NULL scope)不破坏既有 preview/run 配额 SUM(rank 9 留存 + M2 配额回归) |
| M4-T9 | FE:NL→生成→候选→接受填入 textarea→Test 校验;blocked/quota 状态 UX | 组件 spec |
| M4-T10 | 静态边界 | 无 engine.ts/迁移 diff;AiUsageAction 仅加一值 |

## 4. 回滚
端点 + enum 值 + 前端面板:revert 即消失;台账 suggest 行与 preview/run 同地位(留存清扫覆盖);无 schema 残留。

## 5. 不在 M4
服务端多候选循环 · 自动落库/接受 · 公式解释/纠错(只 suggest)· 跨字段公式链(A2-full gate)· operator 字段名过滤策略(配置决策)· OpenAPI 公开。

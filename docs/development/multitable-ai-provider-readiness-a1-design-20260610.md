# 多维表 AI provider readiness(A1 / M1)— 设计锁定 — 2026-06-10

> Status: **DESIGN-LOCK(docs-only,无运行时代码)** · 主线位置:arc 计划 M1a(`multitable-ai-field-staged-arc-development-plan-20260610.md`)
> 决策依据:M0 批准结果 `multitable-ai-field-staged-arc-m0-ratification-result-20260610.md`(全按推荐 + 两修正);原 #1571 批准表保持只读。
> 地基:2026-06-10 独立勘察(8 问,file:line 证据)——本设计不发明新机制,全部复用既有先例。
> 实现解锁:owner 已于 2026-06-10 显式解除 AI 线 defer gate(见批准结果 §3 补记)→ M1b 实现 PR 可在本设计合并后开工。

## 0. 范围一句话

A1 = **声明层**:env 契约解析 + provider readiness 状态机 + admin-only 内部查询路由 + 独立 ops 门脚本。**零真实 provider 调用、零 DB、零迁移、零 OpenAPI 面、零新权限原语**;T1/T3/T6 只声明形状不关闭。

## 1. 既有先例(勘察核实,实现必须复用)

| 需求 | 复用 | 出处 |
|---|---|---|
| 纯 env 配置 resolver | `resolveEmailTransportReadiness(env?)` 模式:纯函数、`{ok,status,messages,requiredEnv,optionalEnv}` 报告、双确认 guard、fail-closed blocked | `services/email-transport-readiness.ts:114-168` |
| admin-only 路由守卫 | `requireAdminRole()`(查 `user_roles`,非 admin 403,RBAC 服务错误 503 fail-closed) | `guards/audit-integration.ts:113-198`;用法 `routes/automation.ts:246/280/309` |
| 内部路由标记 | 路由文件头注释声明 internal;openapi parity gate 只断言公开端点存在,内部路由天然不触发 | `routes/internal.ts:6-10`;`scripts/ops/multitable-openapi-parity.test.mjs:51-149` |
| 响应 shape | 单对象 GET 返回 **flat**(非 `{ok,data}` 信封) | `routes/automation.ts:189/233`(shape 决议=defer-to-PR;此为先例普查结果,实现 PR 复核后即定 flat) |
| 脱敏 | 后端 `multitable/automation-log-redact.ts`(`\bsk-` 规则 + 归一化键名结构脱敏)+ 门脚本 `multitable-phase3-release-gate-redact.mjs` | 后端 :33;门 :17 |
| 门脚本骨架 | exit 0=PASS / 1=FAIL / 2=BLOCKED(blocked 永不塌缩为 fail)+ JSON/MD 工件 + redactString | `scripts/ops/multitable-phase3-release-gate.mjs:40-42,498-530` |
| AI 残留 | **无**——代码库零 AI 集成;`sk-` 脱敏规则已覆盖 anthropic/openai key 形状 | 全库 grep |

## 2. 锁定设计

### 2.1 Resolver(核心)

新文件 `packages/core-backend/src/services/ai-provider-readiness.ts`(镜像 email-transport-readiness;纯函数、无类、无 DB):

```ts
resolveAiProviderReadiness(env: NodeJS.ProcessEnv = process.env): AiProviderReadinessReport
```

报告形状:`{ ok: boolean; status: AiProviderReadinessStatus; provider?: 'anthropic' | 'openai'; model?: string; caps: { requestTimeoutMs; maxOutputTokens; tenantDailyTokenCap; tenantWeeklyTokenCap; tenantBurstRpm; accountDailyUsdCap }; messages: string[]; requiredEnv: string[]; optionalEnv: string[] }`。

**状态机(T6 全集声明,A1 只发射前三)**:

```
disabled | blocked | ready          ← A1 发射
rate_limited | quota_exhausted | provider_error | unsafe_input   ← A2 保留(类型导出,A1 永不产生)
```

**解析规则(fail-closed,按 M0 批准的 E-1..E-12)**:
1. `MULTITABLE_AI_ENABLED` 缺省/≠`1` → `disabled`(ok=false;这是默认部署态)。
2. `MULTITABLE_AI_PROVIDER` ∉ {`anthropic`,`openai`}(P-1)→ `blocked` + message(值原样回显**仅当**不含 secret 形状;实现保守:非法值统一回显 `<invalid>`)。
3. `MULTITABLE_AI_API_KEY` 缺失/空白 → `blocked`;**仅做存在性判断,任何路径不回显 key 值**。
4. `MULTITABLE_AI_MODEL` 缺省 → 按 provider 默认表(实现 PR 定常量);显式值不在 per-provider 允许表 → `blocked`。
5. E-6..E-11 数值解析:非法/越界 → clamp 到批准的 min/max 并记 message(不 block;Q-1..Q-4 默认值=批准值);解析结果进 `caps`(**仅声明**,A1 无任何执行点)。
6. `MULTITABLE_AI_BASE_URL` 可选,语法校验失败 → `blocked`。
7. `MULTITABLE_AI_CONFIRM_LIVE_REQUESTS`(E-12):A1 **仅在 optionalEnv / message 中信息性声明、完全不消费,不进入 requiredEnv**——A1 没有任何 live 调用路径可被它放行(镜像 `CONFIRM_SEND_EMAIL` 在 readiness 报告中的呈现方式,真实消费归 M2)。
8. 全部通过 → `ready`(ok=true)。**`ready` ≠ 已验证 key 有效**——A1 不发请求,message 注明 "declarative readiness only"。

### 2.2 查询路由(A1 唯一 HTTP 面)

新文件 `packages/core-backend/src/routes/multitable-ai.ts`,挂载 `/api/multitable/ai/readiness`(GET):
- 文件头注释声明 **internal / not in OpenAPI**(M0 Option B,**仅限 A1**;模板 `routes/internal.ts:6-10` 风格 + 引用批准结果)。
- 守卫:平台 JWT(R-1)+ `requireAdminRole()`(R-2,**仅限 A1** 修正二注释写明)。不建新权限原语(R-3)。
- 响应:resolver 报告 **flat** 返回(先例 §1;实现 PR 复核 main 先例后落定)。
- 响应前过一遍后端 redactor(防御性;resolver 本身已不含 secret 值)。

### 2.3 Ops 门脚本

`scripts/ops/multitable-ai-readiness-gate.mjs` + 根脚本 `verify:multitable-ai:readiness`:
- 调 resolver(进程内 import,无 HTTP 依赖),exit:`ready`→0、`disabled`/`blocked`→**2(BLOCKED,永不 1)**、脚本自身异常→1。
- JSON + MD 工件(`--output-dir`),全输出过 `redactString`;单测含 sentinel 注入断言(`sk-` 形状值绝不出现在工件)。
- **不接入** `verify:multitable-release:phase3` 聚合(该聚合属 Phase 3 旧弧;AI 线由本 arc 独立跟踪,聚合接线是后续独立小决策)。

### 2.4 边界(全部硬性)

无 DB/迁移;无 OpenAPI 源改动(parity gate 零接触);无真实 provider 调用(连"验证 key"都不做);无新权限原语;不注册任何 notification/automation channel(env-gate 通道纪律留给 M2);不动 central RBAC/auth;A2/A3 面按修正二届时重设计。

## 3. 测试矩阵(fail-first;纯 env/路由级,无真库依赖 → 默认 unit/route runner,不挂 plugin-tests)

| # | 场景 | 断言 |
|---|---|---|
| A1-T1 | env 全缺省 | `disabled`,ok=false,requiredEnv 列出 E-1..E-5 |
| A1-T2 | enabled + provider=`azure-openai` | `blocked`;message 不含原始值(`<invalid>`) |
| A1-T3 | enabled + provider 合法 + key 缺失 | `blocked`;报告/messages 全文不含 key 名以外的 secret 形状 |
| A1-T4 | 全配置合法 | `ready`,caps=解析值,"declarative readiness only" message |
| A1-T5 | E-6..E-11 越界(过小/过大/非数字) | clamp 到批准 min/max + message,不 block |
| A1-T6 | **泄漏哨兵**:env 注入 `sk-` 形状 key | resolver 报告 JSON 序列化全文、路由响应、门脚本 JSON+MD 工件——三处均不含哨兵 |
| A1-T7 | 路由:admin | 200 flat 报告 |
| A1-T8 | 路由:非 admin 已认证 / 未认证 | 403 / 401(requireAdminRole 既有语义);RBAC 服务故障 → 503 |
| A1-T9 | 门脚本 | disabled→exit 2;ready→exit 0;工件 JSON/MD 存在且已脱敏 |
| A1-T10 | OpenAPI 静态 | `packages/openapi/` 零 diff;parity gate 通过 |

## 4. 回滚

纯增量 + env-gated(默认 `disabled`):revert 即消失;无数据、无协议、无配置迁移残留。

## 5. 不在 A1(归属与 gate)

T1 台账/配额执行(M2)· T6 四保留态推导(M2)· T3 SLO 执行/展示(M2/M3)· 真实调用与 E-12 消费(M2)· 任何 preview/run/display 产品面(M2/M3,修正二)· release:phase3 聚合接线(独立小决策)。

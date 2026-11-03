# `POST /api/multitable/automation/webhooks/:ruleId` 鉴权探针（2026-09-14）

> 本文实跑验证 W5-H 静态发现（`docs/development/integration-scenario-shortlist-20260914.md`
> 「我没能实读 / 不确定的点」第 1 条）。证据基线：本 worktree `HEAD a61d6de565aafa129213314663e43d68b8a64fdb`
> （`docs/integration-scenario-shortlist-20260914` 分支，相对 `ce9da32ae` 只多一份 docs 提交，
> 涉及的后端源码 file:line 与 `ce9da32ae` 相同）。**本文零源码/测试改动**，探针脚本只存在于
> `%TEMP%/.../scratchpad/w5e/`，未落进仓库。

## 结论

**不可达。** 外部无会话调用方（无 `Authorization` header、无 cookie，仅带正确的 HMAC 签名 + 新鲜时间戳）
被全局会话门在到达路由前直接 401，路由自身的 HMAC 验证逻辑从未执行。这是**实跑确认**，不再是静态推断。

## 证据

### 1. 静态三处实读（行号即本次实读所得，均与 `ce9da32ae` 一致）

- `packages/core-backend/src/routes/automation.ts:255-271`：webhook 路由无 `skipAuth`/公开标记、无另一条
  无门挂载；HMAC/时间戳/重放窗/限流都在 `svc.handleInboundWebhook` 内部。
- `packages/core-backend/src/auth/api-path-policy.ts:114-164`（`GLOBAL_GATE_EXCEPTIONS`）：grep `webhook`
  零命中，最近的两条豁免（`/api/plm-embed`、`/api/cache-test`，均 `prefix`）都不覆盖这条路径。
- `packages/core-backend/src/index.ts:1694-1707`（全局门）+ `:1847`（挂载点）：判定链
  `isWhitelisted → isPublicFormAuthBypass → isOapiAllowlistRequest → isApiPath ⇒ jwtAuthMiddleware`；
  `jwt-middleware.ts:26-28` 确认 `isWhitelisted` 只是 `isGateException`（上表）的包装，无第二张表。
- `packages/core-backend/src/multitable/oapi-read-allowlist.ts`：grep `webhook` 零命中（该文件同时是
  OAPI-1 读、OAPI-2a 写两张表，`isOapiAllowlistRequest` 一个函数覆盖两者，探针 (a) 已直接调用验证）。

### 2. 探针 (a) —— 内存级调用真实判定函数

`tsx scratchpad/w5e/probe-a-gate-exceptions.mts`（`tsx` 来自 `pnpm install --frozen-lockfile` 后的
`node_modules/.bin/tsx`），对 `/api/multitable/automation/webhooks/<uuid>` 的输出：
```json
{ "isApiPath": true, "matchGateException": null, "isGateException": false,
  "isWhitelisted_jwtMiddleware": false, "isOapiAllowlistRequest_POST_noAuth": false,
  "isPublicFormAuthBypass": false }
```
三条豁免机制全假、`isApiPath` 为真 ⇒ 按 `:1705` 必然落进 `jwtAuthMiddleware`。

### 3. 探针 (b) —— 复刻真实门 + 真实路由，真实 HTTP 请求

把 `index.ts:1694-1707` 逐字复制、挂在真实 `createAutomationRoutes` 前（`AutomationService` resolver 传
`() => undefined`，令路由鉴权通过后答确定性 503，与门的 401 可区分）。用真实 `signInboundWebhookBody`
签名，请求不带 `Authorization`/cookie：`tsx scratchpad/w5e/probe-b-gate-e2e.mts`
```json
{ "status": 401, "body": { "ok": false, "error": { "code": "UNAUTHORIZED", "message": "Missing Bearer token" } },
  "verdict": "BLOCKED_BY_GLOBAL_GATE" }
```
该 401 形状与 `jwt-middleware.ts:156` 门的 401 逐字一致，与路由自己的 `401 {ok:false}`
（`automation.ts:267`，无 `error` 字段）不同形 ⇒ 判定为门拦，非路由拒。

**对照组**（同请求去掉门中间件，等同现有 `tests/integration/multitable-inbound-webhook-trigger.test.ts`
的挂法）：`tsx scratchpad/w5e/probe-b2-control-no-gate.mts`
```json
{ "status": 503, "body": { "error": "Automation service is not initialized yet" } }
```
证明同一请求越过门后能进到路由内部（止步于 `getService` 的 503，因未接真 DB；不影响结论）。

### 4. 文档/前端是否声称外部可直接调用

`grep -i "automation/webhooks"` 命中四处，均指向"外部系统只需 HMAC 头即可调用"：
- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue:60-66,141-145`：规则编辑器提示原文
  （中/英）——「保存后向 `POST .../automation/webhooks/:ruleId` 发送请求；请求头需携带
  `X-MS-Webhook-Timestamp`/`X-MS-Webhook-Signature`」，**未提及**需要会话/Bearer/Cookie。
- `docs/development/approval-automation-t1-2-inbound-webhook-dev-verification-20260702.md:24-26`
  （Trust Boundary）：「The webhook caller is anonymous. Possession of the per-rule secret authorizes
  delivery.」—— 明确把"匿名调用方+密钥"定为信任模型。
- 同 doc 引用的 `tests/integration/multitable-inbound-webhook-trigger.test.ts:1-10,96-100`：自称
  「Drives the public unauthenticated route」，挂法是裸 `express()` + 路由，**不含全局门**——这条已有
  测试从未、也不可能发现"门会拦"。

即：不是"前端自带会话、本不面向外部"的情况——UI 文案与 dev-verification 文档明确承诺外部可只凭密钥
调用；实跑显示生产门不允许这个承诺兑现。这是**功能缺口**，不是误读。

## 影响

- **谁会用它**：规则编辑器里选 `webhook.received` 触发器的最终用户，及其配置的外部系统（n8n / 客户自建
  脚本 / 第三方 SaaS 出站 webhook）——UI 直接把这个 URL 和签名规则打印给用户去配置到外部系统里。
- **对 W5-H 三场景各自 n8n 那一跳**：
  - 场景 A / B（ERP / PLM 拉取）：n8n 触发拉取走的是 `/api/integration/stock-preparation/mvp/source-runs/*`
    （需 JWT），跟这条 automation webhook 无关，不受影响。
  - 场景 C（Bridge → pipeline → 多维表）：短名单 `C.4` 已把这条标为「n8n 触发 automation（现状不通）」，
    本次实跑把它从"静态推断"坐实为"实测确认"；C 场景选择的三跳（Bridge 只读 → PipelineRunner →
    n8n 用 `mst_` 读写）本就没有依赖这条端点，结论不改变对 C 的推荐，只是去掉了那条"未实跑"的免责声明。

## 选项（不做推荐，仅摆事实）

1. **把该路径加入 `GLOBAL_GATE_EXCEPTIONS`（`exact`），只靠 HMAC 鉴权。**
   兑现现有 UI 文案与 dev-verification 文档已经声明的信任模型（匿名调用方 + per-rule 密钥）。
   **是授权边界改动**：新增一条无会话即可达的路径，需要 owner ADR——尤其要重新核实
   `automation-inbound-webhook.ts` 里 HMAC 校验/重放窗/限流在"门外"独立扛得住的前提（现状本来就是这么设计
   的，但从"门内也挡一层"变成"完全只靠 HMAC"，是把唯一防线从两层收成一层）。
2. **保持需会话，外部改走 `mst_` API token（比照 OAPI-1/2a 模式新增到 `oapi-read-allowlist.ts`）。**
   与仓内既有"`mst_` 分能力精确 allowlist"范式一致，代价是放弃"匿名 + HMAC"设计、UI 文案与
   dev-verification 文档需要同步改写（承诺变了）。**也是授权边界改动**（扩大 `mst_` token 可达面），
   同样需要 owner ADR；且需要决定 automation 规则创建者如何给外部系统发 `mst_` token（现有 token 无
   rule 级 scope）。
3. **新开一个受控触发入口**（短名单 `A.6`/`C.6` 里已经点名的同一类缺口：新代码、新授权边界）。
   例如一个只做"验签后排队"的极小无会话端点，与现有 `webhook.received` 触发器解耦，把"谁能触发
   automation"和"谁能拿到 rule 级密钥"分开建模。工作量最大，但不改变现有两个端点（automation webhook /
   `mst_` OAPI）的既有信任模型。**是授权边界改动**，需要 owner ADR。

三个选项都改变"谁能在无会话情况下打进 `/api/multitable/**`"这条线，按仓库既有惯例
（`api-path-policy.ts` 头部注释：加一条豁免 = opt-out of authentication）都需要 owner 决策，
非实施顺手可做。

## 未做事项

- 未跑 `tests/integration/multitable-inbound-webhook-trigger.test.ts` 本身（需要 `DATABASE_URL`，本次
  未接真 DB；且如上所述，该测试的挂法本就不含全局门，跑绿也不能回答本次的问题）。
- 未验证"带合法会话 JWT"的正向路径（即门放行后路由真正执行到 `handleInboundWebhook` 并识别签名）——
  探针 (b2) 只证明门放行后能进到路由，未接真 `AutomationService`/真 DB 走完整签名校验+落库。
- 未跑 `pnpm --filter @metasheet/core-backend exec tsc --noEmit` 或任何 lint/build；本任务零源码改动，
  判定为非必需。
- 未清理本次为跑探针而执行的 `pnpm install --frozen-lockfile`（`node_modules` 由 `.gitignore` 排除，
  worktree `git status` 全程干净，未做进一步处理）。

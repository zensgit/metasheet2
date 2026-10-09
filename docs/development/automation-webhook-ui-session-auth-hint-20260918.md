# TRG-02 收尾：webhook.received UI 提示补齐会话认证要求（2026-09-18）

## 裁决原文
> owner 已裁决：维持会话 JWT + HMAC，不开匿名入口、不扩大 `mst_` allowlist；UI 提示须补充会话认证要求。

来源：`artifacts/reviews/queue-closeout-20260916/review-and-decisions.md` §7.2 TRG-02。

## 事实依据（未改动，仅引用）
- `packages/core-backend/src/index.ts:1721-1734`：全局会话门先于路由执行，匿名请求 401。
- `routes/automation.ts:439-453`、`automation-service.ts:3029-3039`：webhook 请求体的 HMAC-SHA256 + 时间戳校验。
- `docs/development/automation-webhook-auth-probe-20260914.md`：既有探针结论。

## 改了哪两处
1. `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue:142-144`（`webhookEndpointHint` 提示文案，中英文各一行）：在原有 HMAC 签名/时间戳说明前，补充「调用方须持有效会话 JWT（Authorization: Bearer）——匿名调用被全局会话门拒绝（401）」。
2. `apps/web/tests/multitable-automation-rule-editor.spec.ts:4535-4538`：在既有 `webhook.received: requires a signing secret for a new rule...` 用例中新增一条断言，校验提示文本包含 `session JWT`（组件默认渲染英文；未新建 spec 文件，沿用既有已登记 spec，exec 行无需改动）。

## 为什么不写"以当前登录用户身份执行"
会话门只校验**调用者**的 JWT 合法性，不改变 webhook 规则的**执行身份**——`automation-service.ts` 仍以规则的既存作者（保存时记录的 creator）身份执行动作，与本次调用的登录用户无关。若文案写成"以当前登录用户身份执行"，会误导使用者以为规则执行权限随调用者变化，与实现不符，故仅描述认证门槛（JWT 必需 + HMAC 校验 + 401 拒绝），不涉及执行身份归属。

## 测试
- `pnpm exec vitest run tests/multitable-automation-rule-editor.spec.ts`（apps/web 内）：177 passed。
- 新增断言：`webhookEndpointHint` 文本包含 `session JWT`（英文默认渲染路径）。

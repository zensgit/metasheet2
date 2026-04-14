# MetaSheet Week 3/4/5 开发验证文档

Date: 2026-04-14

## 1. 交付总览

| 周次 | 主题 | PR | 状态 |
|---|---|---|---|
| Week 3 | 公开表单安全加固 | #862 | ✅ 已合并 |
| Week 4 | 字段验证规则引擎 | #864 | ✅ 已合并 |
| Week 5 | API Token + Webhook V1 | #863 | ✅ 已合并 |

前置依赖（已完成）：
- Week 3 baseline: `fbc170f73` — 公开表单 token 模型、form-context、匿名提交（Codex 提交）

---

## 2. Week 3: 公开表单安全加固 (PR #862)

### 2.1 新增文件

| 文件 | 说明 |
|---|---|
| `packages/core-backend/src/middleware/rate-limiter.ts` | 通用限流中间件 |
| `packages/core-backend/tests/unit/rate-limiter.test.ts` | 9 个单测 |
| `packages/core-backend/tests/integration/public-form-flow.test.ts` | 8 个集成测试 |
| `docs/development/public-form-runtime-verification-20260414.md` | Smoke 文档 |

### 2.2 Rate Limiter 设计

```typescript
createRateLimiter({ windowMs, maxRequests, keyPrefix })
```

- 内存滑动窗口（Map-based），无 Redis 依赖
- Key 提取：匿名用户 → `req.ip`；认证用户 → `userId`
- 超限返回 429 + `Retry-After` 头
- 周期性自动清理过期窗口

预配置实例：

| 实例 | 窗口 | 限额 | 适用 |
|---|---|---|---|
| `publicFormSubmitLimiter` | 15 分钟 | 10 次 | 公开表单提交 |
| `publicFormContextLimiter` | 15 分钟 | 60 次 | 公开表单上下文加载 |

条件应用：`conditionalPublicRateLimiter()` — 仅当 `publicToken` 存在时生效，认证用户不受限流。

### 2.3 提交审计日志

公开表单成功提交后自动记录：
```json
{
  "viewId": "view_123",
  "publicToken": "mst_abc1...",
  "ip": "192.168.1.1",
  "recordId": "rec_xyz",
  "timestamp": "2026-04-14T..."
}
```

### 2.4 验收命令

```bash
cd packages/core-backend
npx vitest run tests/unit/rate-limiter.test.ts --watch=false
# 9/9 通过

npx vitest run tests/integration/public-form-flow.test.ts --watch=false
# 8/8 通过
```

---

## 3. Week 4: 字段验证规则引擎 (PR #864)

### 3.1 新增文件

| 文件 | 说明 |
|---|---|
| `packages/core-backend/src/multitable/field-validation.ts` | 验证规则类型定义 |
| `packages/core-backend/src/multitable/field-validation-engine.ts` | 验证执行引擎 |
| `packages/core-backend/tests/unit/field-validation.test.ts` | 68 个单测 |
| `packages/core-backend/tests/integration/field-validation-flow.test.ts` | 13 个集成测试 |

### 3.2 规则类型

| 规则 | 参数 | 适用字段 | 说明 |
|---|---|---|---|
| `required` | — | 所有 | 非空校验（null/undefined/空串/空数组） |
| `min` | `{ value: number }` | number/currency | 最小值 |
| `max` | `{ value: number }` | number/currency | 最大值 |
| `minLength` | `{ value: number }` | text/array | 最小长度 |
| `maxLength` | `{ value: number }` | text/array | 最大长度 |
| `pattern` | `{ regex, flags? }` | text | 正则匹配 |
| `enum` | `{ values: string[] }` | select | 枚举校验 |
| `custom` | 自定义 | 所有 | 预留扩展 |

### 3.3 验证引擎 API

```typescript
// 单字段验证
validateFieldValue(fieldId, fieldName, fieldType, value, rules): FieldValidationError[]

// 整条记录验证
validateRecord(fields, data): ValidationResult  // { valid, errors[] }

// 默认规则
getDefaultValidationRules(fieldType, options?): FieldValidationConfig
// text → maxLength: 10000
// select → enum from options
```

### 3.4 接入点

已接入两个提交入口：

| 端点 | 接入位置 |
|---|---|
| `POST /api/multitable/views/:viewId/submit` | 表单提交（含公开表单） |
| `POST /api/multitable/records` | 直接记录创建 |

验证失败返回 HTTP 422：
```json
{
  "error": "VALIDATION_FAILED",
  "message": "Record validation failed",
  "fieldErrors": [
    {
      "fieldId": "fld_email",
      "fieldName": "Email",
      "rule": "pattern",
      "message": "Must be a valid email address"
    }
  ]
}
```

### 3.5 设计决策

- **后端是权威来源**：前端复用同一套规则定义，仅做 UI 展示
- **非 fail-fast**：返回所有错误，前端可一次展示所有问题
- **null 跳过**：空值跳过非 required 规则（允许部分更新）
- **自定义消息**：每条规则可携带 `message` 覆盖默认消息

### 3.6 验收命令

```bash
cd packages/core-backend
npx vitest run tests/unit/field-validation.test.ts --watch=false
# 68/68 通过

npx vitest run tests/integration/field-validation-flow.test.ts --watch=false
# 13/13 通过
```

---

## 4. Week 5: API Token + Webhook V1 (PR #863)

### 4.1 新增文件

| 文件 | 说明 |
|---|---|
| `packages/core-backend/src/multitable/api-tokens.ts` | Token 类型定义 |
| `packages/core-backend/src/multitable/webhooks.ts` | Webhook 类型定义 |
| `packages/core-backend/src/multitable/api-token-service.ts` | Token CRUD + 验证 |
| `packages/core-backend/src/multitable/webhook-service.ts` | Webhook CRUD + 投递 |
| `packages/core-backend/src/multitable/webhook-event-bridge.ts` | EventBus → Webhook 桥接 |
| `packages/core-backend/src/middleware/api-token-auth.ts` | Bearer token 认证中间件 |
| `packages/core-backend/src/routes/api-tokens.ts` | REST 路由 |
| `packages/core-backend/tests/unit/api-token-webhook.test.ts` | 41 个测试 |

### 4.2 API Token 设计

| 属性 | 说明 |
|---|---|
| 格式 | `mst_` + 32 位随机 hex |
| 存储 | SHA-256 hash（不存明文） |
| 展示 | 仅显示 `tokenPrefix`（前 8 位） |
| Scope | `records:read`, `records:write`, `fields:read`, `comments:read`, `comments:write`, `webhooks:manage` |

操作：
- **创建** → 返回明文 token（仅此一次）
- **轮换** → 撤销旧 token + 创建新 token（继承 scope）
- **验证** → hash 输入 → 查找匹配 → 检查 revoked/expired → 更新 lastUsedAt
- **撤销** → 软撤销（标记 `revoked: true`）

### 4.3 Webhook 设计

| 属性 | 说明 |
|---|---|
| 事件类型 | `record.created`, `record.updated`, `record.deleted`, `comment.created` |
| 签名 | HMAC-SHA256（`X-Webhook-Signature` 头） |
| 超时 | 5 秒 |
| 重试 | 指数退避，最多 3 次 |
| 熔断 | 连续 10 次失败自动禁用 |

投递 Headers：
```
X-Webhook-Id: whk_xxx
X-Webhook-Event: record.created
X-Webhook-Signature: sha256=abc123...
X-Webhook-Timestamp: 2026-04-14T...
Content-Type: application/json
```

### 4.4 EventBus 桥接

`webhook-event-bridge.ts` 订阅 EventBus 事件，自动转发到 Webhook 投递队列。**不修改任何现有事件发布代码**。

### 4.5 REST 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/multitable/api-tokens` | 列出用户 token |
| `POST` | `/api/multitable/api-tokens` | 创建 token |
| `DELETE` | `/api/multitable/api-tokens/:id` | 撤销 token |
| `POST` | `/api/multitable/api-tokens/:id/rotate` | 轮换 token |
| `GET` | `/api/multitable/webhooks` | 列出 webhook |
| `POST` | `/api/multitable/webhooks` | 创建 webhook |
| `PATCH` | `/api/multitable/webhooks/:id` | 更新 webhook |
| `DELETE` | `/api/multitable/webhooks/:id` | 删除 webhook |
| `GET` | `/api/multitable/webhooks/:id/deliveries` | 投递历史 |

### 4.6 Bearer Token 认证中间件

```typescript
// Authorization: Bearer mst_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
// 中间件自动验证 → 设置 req.apiTokenScopes
// 下游路由可检查 scope 权限
```

### 4.7 验收命令

```bash
cd packages/core-backend
npx vitest run tests/unit/api-token-webhook.test.ts --watch=false
# 41/41 通过
```

---

## 5. 手动 Smoke 验证清单

### 5.1 公开表单限流

- [ ] 访问 `/multitable/public-form/:sheetId/:viewId?publicToken=xxx`
- [ ] 提交 10 次后，第 11 次返回 429
- [ ] 等待 15 分钟后限流重置
- [ ] 用认证用户访问同一端点，不受限流影响
- [ ] 检查服务器日志包含 `[public-form-submission]` 审计条目

### 5.2 字段验证

- [ ] 创建一个 text 字段，设置 `validation: [{ type: "required" }]`
- [ ] 提交空值 → 返回 422 + `fieldErrors`
- [ ] 创建 number 字段，设置 `min: 0, max: 100`
- [ ] 提交 -1 → 422；提交 50 → 成功
- [ ] 创建 text 字段，设置 `pattern: { regex: "^[a-z]+$" }`
- [ ] 提交 "ABC" → 422；提交 "abc" → 成功
- [ ] 多个字段同时验证失败 → 返回所有错误
- [ ] 公开表单提交同样受验证规则约束

### 5.3 API Token

- [ ] `POST /api/multitable/api-tokens` → 获取 `mst_...` 明文 token
- [ ] 用 `Authorization: Bearer mst_...` 访问 `/api/multitable/records` → 成功
- [ ] 用错误 token → 401
- [ ] 撤销 token 后再访问 → 401
- [ ] 轮换 token → 旧 token 失效，新 token 可用

### 5.4 Webhook

- [ ] `POST /api/multitable/webhooks` 创建 webhook → 指向测试 URL
- [ ] 创建一条记录 → webhook 收到 `record.created` 事件
- [ ] 检查 `X-Webhook-Signature` 头正确（HMAC-SHA256）
- [ ] 目标 URL 不可达 → 自动重试（查看投递历史）
- [ ] 连续 10 次失败 → webhook 自动禁用

---

## 6. API 契约速查

### 限流响应 (429)
```
HTTP/1.1 429 Too Many Requests
Retry-After: 900

{ "error": "Too many requests", "retryAfter": 900 }
```

### 字段验证失败 (422)
```json
{
  "error": "VALIDATION_FAILED",
  "message": "Record validation failed",
  "fieldErrors": [
    { "fieldId": "fld_1", "fieldName": "Name", "rule": "required", "message": "This field is required" },
    { "fieldId": "fld_2", "fieldName": "Age", "rule": "min", "message": "Must be at least 0" }
  ]
}
```

### Token 创建响应
```json
{
  "token": {
    "id": "tok_abc123",
    "name": "My API Key",
    "tokenPrefix": "mst_a1b2...",
    "scopes": ["records:read", "records:write"],
    "createdAt": "2026-04-14T...",
    "revoked": false
  },
  "plainTextToken": "mst_a1b2c3d4e5f6..."
}
```

### Webhook 投递 Headers
```
POST https://your-endpoint.com/webhook
X-Webhook-Id: whk_xxx
X-Webhook-Event: record.created
X-Webhook-Signature: sha256=abc123def456...
X-Webhook-Timestamp: 2026-04-14T08:00:00.000Z
Content-Type: application/json

{ "event": "record.created", "data": { "recordId": "rec_1", ... } }
```

---

## 7. 架构依赖关系

```
Week 3 (公开表单) ─── rate-limiter.ts ──┐
                                         ├── univer-meta.ts (submit 端点)
Week 4 (字段验证) ─── field-validation-engine.ts ──┘

Week 5 (API Token) ─── api-token-service.ts ── api-token-auth.ts (中间件)
                   ─── webhook-service.ts ── webhook-event-bridge.ts ── EventBus
```

---

## 8. 测试覆盖汇总

| 模块 | 单测 | 集成测试 | 合计 |
|---|---|---|---|
| Rate Limiter | 9 | 8 | 17 |
| Field Validation | 68 | 13 | 81 |
| API Token + Webhook | 41 | — | 41 |
| **合计** | **118** | **21** | **139** |

---

## 9. 下一步

| 周次 | 主题 | 说明 |
|---|---|---|
| Week 3 frontend | 表单分享管理 UI | Human/Codex：生成链接、设过期、开关 |
| Week 4 frontend | 验证规则配置 UI | 字段设置面板中嵌入规则编辑器 |
| Week 5 frontend | Token/Webhook 管理页 | `MetaIntegrationManager.vue` 扩展 |
| Week 6 | 高级自动化 V1 | 定时触发、条件判断、webhook 动作、串联 |
| Week 7 | 图表 / Dashboard V1 | 柱状/折线/饼图 + dashboard 面板 |
| Week 8 | RC 收口 | 回归、演示数据、发布说明 |

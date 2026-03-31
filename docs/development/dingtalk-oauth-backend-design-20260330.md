# DingTalk OAuth Backend Design

日期：2026-03-30

## 目标

把 DingTalk 登录链路从"前端占位回退"推进到"后端 callback 可用、前端可完成登录闭环"。

## 新增接口

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/auth/dingtalk/launch` | 返回 DingTalk OAuth 授权 URL，前端跳转用 |
| POST | `/api/auth/dingtalk/callback` | 交换 DingTalk auth code，返回本地 JWT + user + features |

## 流程

```
LoginView
  ↓ probeDingTalk() — GET /api/auth/dingtalk/launch
  ↓ 200 → 显示钉钉登录按钮；503 → 隐藏
  ↓ 用户点击
  ↓ window.location.href = data.url
  ↓
DingTalk Login Page (外部)
  ↓ 用户授权
  ↓ redirect to /auth/dingtalk/callback?code=xxx&state=yyy
  ↓
DingTalkAuthCallbackView
  ↓ POST /api/auth/dingtalk/callback { code, state }
  ↓
Backend auth.ts
  ↓ isDingTalkConfigured() → 503 if not
  ↓ exchangeCodeForUser(code)
  │   ↓ POST dingtalk token endpoint → access token
  │   ↓ GET dingtalk user info → openId, nick, email
  │   ↓ resolveLocalUser() → find or create local user
  ↓ authService.createToken(user)
  ↓ deriveProductFeatures(user)
  ↓ return { success: true, data: { user, token, features } }
  ↓
DingTalkAuthCallbackView
  ↓ setToken(token)
  ↓ primeSession({ success: true, data: { user, features } })
  ↓ loadProductFeatures()
  ↓ router.replace(homePath)
```

## 后端服务

### dingtalk-oauth.ts

- `isDingTalkConfigured()` — 检查三个环境变量是否存在
- `buildAuthUrl(state)` — 拼接 DingTalk OAuth2 授权 URL
- `exchangeCodeForUser(code)` — 完整的 code → local user 流程

### 用户解析策略

1. 先按 `dingtalk_open_id` 在 `users` 表查找
2. 如果有 email，按 email 匹配已有用户并关联 DingTalk 身份
3. 都没有，创建新用户（`role = 'user'`，email 从 DingTalk 获取或生成占位）

### 环境变量

| 变量 | 说明 | 必需 |
|------|------|------|
| `DINGTALK_CLIENT_ID` | DingTalk 应用 AppKey | 是 |
| `DINGTALK_CLIENT_SECRET` | DingTalk 应用 AppSecret | 是 |
| `DINGTALK_REDIRECT_URI` | 回调 URL，必须与 DingTalk 开放平台配置一致 | 是 |

三个变量任一缺失，launch 和 callback 端点返回 503。

## 响应 Shape

与现有 `/api/auth/login` 完全一致：

```json
{
  "success": true,
  "data": {
    "user": { "id": "...", "email": "...", "name": "...", "role": "..." },
    "token": "jwt-...",
    "features": { "attendance": true, "workflow": false, "attendanceAdmin": false, "attendanceImport": false, "mode": "platform" }
  }
}
```

## 前端变更

### LoginView.vue

- `onMounted` 时调用 `GET /api/auth/dingtalk/launch` 探测可用性
- 200 → 显示"钉钉登录"按钮；503/网络错误 → 隐藏
- 按钮点击 → 再次调用 launch 获取最新 URL → `window.location.href = url`

### DingTalkAuthCallbackView.vue

- 从占位回退改为真实 callback 处理
- 复用 `setToken()` + `primeSession()` + `loadProductFeatures()` 的现有登录路径
- 处理三种场景：缺参数、后端错误、成功

## OAuth State CSRF 防护

### 存储介质

进程内 `Map<string, number>` — `state → expiresAt` 时间戳。

### 流程

1. `GET /dingtalk/launch` → `generateState()` 生成 UUID，写入 Map，返回给前端
2. DingTalk 回调后前端把 `state` 原样 POST 回 `/dingtalk/callback`
3. `validateState(state)` 从 Map 查找并一次性消费（delete）
4. 不存在 → `400 Invalid or unknown state parameter`
5. 已过期 → `400 State parameter has expired`

### 过期策略

- TTL：5 分钟（`STATE_TTL_MS = 300_000`）
- 最大容量：10,000 条，超限时淘汰最早条目
- 每次 `generateState()` 时自动清理过期条目

### 局限

- 进程内存储，服务重启后全部失效（用户需重新点击"钉钉登录"）
- 多进程部署时各进程独立，state 只在发起请求的进程有效
- 如需多进程共享，后续可迁移到 Redis，接口不变

## JWT Middleware

DingTalk 端点已加入 `AUTH_WHITELIST`，不需要 Bearer token：
- `/api/auth/dingtalk/launch`
- `/api/auth/dingtalk/callback`

这两个路径必须在白名单中，因为它们在用户尚未登录时被调用（launch 用于获取授权 URL，callback 用于交换 code 获取 token）。改动范围仅限新增两行白名单路径。

## 非目标

- 不做 DingTalk 扫码登录（仅 web OAuth 授权码模式）
- 不做 DingTalk 目录同步
- 不改 admin-directory / admin-users 路由
- 不加新的会话写入逻辑（复用 setToken + primeSession）

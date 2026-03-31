# DingTalk OAuth Backend 部署清单

日期：2026-03-30

## 前提

本次部署的功能为 DingTalk OAuth 登录。如果不需要启用 DingTalk 登录，可以不配置以下环境变量——系统会自动降级，登录页不显示钉钉登录按钮。

## 1. 环境变量

在服务端运行环境中配置：

```bash
DINGTALK_CLIENT_ID=<DingTalk 应用 AppKey>
DINGTALK_CLIENT_SECRET=<DingTalk 应用 AppSecret>
DINGTALK_REDIRECT_URI=https://<your-domain>/auth/dingtalk/callback
```

**注意**：
- `DINGTALK_REDIRECT_URI` 必须与 DingTalk 开放平台应用配置中的回调地址完全一致
- 三个变量任一缺失时，`/api/auth/dingtalk/launch` 返回 503，前端自动隐藏钉钉登录按钮

## 2. 数据库（可选）

如果需要通过 `dingtalk_open_id` 关联已有用户，执行：

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS dingtalk_open_id TEXT;
CREATE INDEX IF NOT EXISTS idx_users_dingtalk_open_id ON users (dingtalk_open_id) WHERE dingtalk_open_id IS NOT NULL;
```

如果不执行此迁移，DingTalk 登录仍可工作——系统会通过 email 匹配已有用户或创建新用户，但无法按 DingTalk OpenID 直接关联。

## 3. 构建与部署

```bash
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
```

## 4. 验证

### 自动验证

```bash
node scripts/dingtalk-oauth-smoke.mjs --base-url http://localhost:7778
```

该脚本验证：
1. `GET /api/auth/dingtalk/launch` 可达（200 或 503）
2. `POST /api/auth/dingtalk/callback` 缺 code → 400
3. `POST /api/auth/dingtalk/callback` 错误 state → 400

### 手动验证

1. 不配置 DingTalk 环境变量时：
   - 访问登录页，不应出现"钉钉登录"按钮
   - `GET /api/auth/dingtalk/launch` 应返回 503

2. 配置 DingTalk 环境变量后：
   - 访问登录页，应显示"钉钉登录"按钮
   - 点击按钮，应跳转到 DingTalk 授权页
   - 授权后回调，应完成登录并跳转到首页

## 5. 回滚

1. 移除 DingTalk 环境变量即可禁用此功能
2. 前端会自动隐藏钉钉登录按钮
3. 已通过 DingTalk 登录创建的用户不受影响，可通过邮箱密码登录（需管理员设置密码）

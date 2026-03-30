# DingTalk Auth Deployment Guide

## Goal

这份文档说明如何把 MetaSheet 的 DingTalk 认证能力部署到新环境或现有环境。

适用范围：

- 已有 MetaSheet 站点，需要新增 DingTalk 登录/绑定
- 已完成代码合并，需要在服务器上启用 DingTalk 认证
- 需要给运维或交付方一份可重复执行的上线步骤

## What Gets Deployed

当前实现包含三块：

1. 登录页发起 DingTalk OAuth 登录
2. 登录后的账号绑定、解绑和绑定列表
3. 现有 MetaSheet 用户在被管理员授权后，可绑定并直接用 DingTalk 登录

默认策略：

- `DINGTALK_AUTO_PROVISION=false`
- 先授权，后绑定，再登录
- 不默认开启首次登录自动开户

## DingTalk Open Platform Side

在 DingTalk 开放平台必须先完成这些配置：

1. 创建或确认一个可用于网页登录的应用
2. 获取：
   - `Client ID`
   - `Client Secret`
   - 企业 `CorpID`
3. 在权限管理里至少开通：
   - `Contact.User.Read`
4. 配置回调地址：
   - `${PUBLIC_APP_URL}/auth/dingtalk/callback`

当前线上示例回调地址：

```text
http://142.171.239.56:8081/auth/dingtalk/callback
```

如果后续切到正式域名或 HTTPS，回调地址必须同步修改。

## Server Environment Variables

至少需要这些环境变量：

```bash
PUBLIC_APP_URL=https://app.example.com
CORS_ORIGIN=https://app.example.com
JWT_SECRET=<strong-random-secret>

DINGTALK_AUTH_ENABLED=true
DINGTALK_CLIENT_ID=<dingtalk-client-id>
DINGTALK_CLIENT_SECRET=<dingtalk-client-secret>
DINGTALK_ALLOWED_CORP_IDS=<corp-id>
DINGTALK_SCOPE="openid corpid Contact.User.Read"

# 推荐先保持关闭
DINGTALK_AUTO_PROVISION=false
```

可选变量：

```bash
# 不填时由代码按 PUBLIC_APP_URL 推导
DINGTALK_REDIRECT_URI=https://app.example.com/auth/dingtalk/callback

# 只有自动开户时才需要
DINGTALK_AUTO_PROVISION_PRESET_ID=<preset-id>
DINGTALK_AUTO_PROVISION_ORG_ID=<org-id>
DINGTALK_AUTO_PROVISION_EMAIL_DOMAIN=<example.local>
```

## Preflight

部署前先跑静态预检：

```bash
node scripts/dingtalk-auth-preflight.mjs
```

这个脚本会检查：

- `PUBLIC_APP_URL`
- `DINGTALK_CLIENT_ID`
- `DINGTALK_CLIENT_SECRET`
- callback URL
- `DINGTALK_ALLOWED_CORP_IDS`
- 自动开户相关变量是否完整

参考：
- [dingtalk-auth-ops-preflight-20260323.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/dingtalk-auth-ops-preflight-20260323.md)
- [dingtalk-auth-preflight.mjs](/Users/huazhou/Downloads/Github/metasheet2/scripts/dingtalk-auth-preflight.mjs)

## Database Migration

DingTalk 认证现在依赖两张表，部署时必须执行 migration：

```bash
pnpm --filter @metasheet/core-backend migrate
```

至少包含：

- `user_external_identities`
- `user_external_auth_grants`

其中 `user_external_auth_grants` 用于方案 B 的显式授权门。
如果是容器环境，确保 backend 镜像或运行目录里已经包含最新 migration 文件。

## Build

本地或 CI 先完成构建：

```bash
pnpm install
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
```

推荐最少回归：

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/auth-login-routes.test.ts tests/unit/admin-users-routes.test.ts
pnpm --filter @metasheet/web exec vitest run tests/app.spec.ts tests/useAuth.spec.ts tests/utils/api.test.ts tests/sessionCenterView.spec.ts
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts tests/sessionCenterView.spec.ts
pnpm --filter @metasheet/web exec vue-tsc --noEmit
node scripts/openapi-check.mjs
```

## Admin Authorization Setup

上线后如果采用方案 B，还需要一项管理动作：

1. 管理员登录 MetaSheet
2. 打开用户管理页
3. 对目标用户开启“钉钉登录授权”
4. 由该用户自行进入 `/settings` 绑定钉钉，或直接使用已存在绑定完成直登

如果不做这一步，即使 DingTalk OAuth 配置正确，未授权账号也会在绑定或直登阶段收到 `403`。

## Deploy Sequence

推荐顺序：

1. 更新服务器环境变量
2. 跑 preflight
3. 执行 migration
4. 重启 backend
5. 发布 frontend 静态包
6. 做浏览器验收

### Backend

如果是标准发布流程，确保 backend 重启后能读到新的 `DINGTALK_*` 环境变量。

如果是当前 `142.171.239.56` 这套容器部署，最重要的是：

- backend 容器必须在 `metasheet_default` 网络里
- backend 容器必须保留网络别名 `backend`

否则 web 容器里的反向代理会找不到后端。

### Frontend

当前线上环境是静态前端容器，发布方式是把 `apps/web/dist` 同步进 `metasheet-web` 容器：

```bash
rsync -az --delete -e 'ssh -i ~/.ssh/metasheet2_deploy' apps/web/dist/ mainuser@142.171.239.56:/home/mainuser/metasheet2-web-dist/
ssh -i ~/.ssh/metasheet2_deploy mainuser@142.171.239.56 'docker cp /home/mainuser/metasheet2-web-dist/. metasheet-web:/usr/share/nginx/html/'
```

如果你使用自己的 CI/CD，只要最终前端静态资源和后端环境变量都同步到目标环境，方式不必完全一致。

## Production Example

当前线上实际生效的关键配置是：

```bash
PUBLIC_APP_URL=http://142.171.239.56:8081
DINGTALK_AUTH_ENABLED=true
DINGTALK_ALLOWED_CORP_IDS=dingd1f07b3ff4c8042cbc961a6cb783455b
DINGTALK_REDIRECT_URI=http://142.171.239.56:8081/auth/dingtalk/callback
DINGTALK_SCOPE="openid corpid Contact.User.Read"
DINGTALK_AUTO_PROVISION=false
```

## Acceptance

上线后按这个顺序验收：

1. 打开 `/login`
2. 使用一个已授权账号登录管理后台
3. 确认用户管理页能看到“钉钉登录授权”状态
4. 对目标账号开启授权
5. 打开 `/settings`
6. 确认该账号可绑定 DingTalk，且绑定卡片可见
7. 点击右上角“退出登录”
8. 确认回到 `/login?redirect=...`
9. 点“钉钉登录”
10. 用已授权且已绑定账号完成认证
11. 确认回到 MetaSheet 并成功进入系统

## Rollback

最小回滚方式：

1. 将 `DINGTALK_AUTH_ENABLED=false`
2. 重启 backend
3. 保留本地邮箱密码登录作为兜底入口

这会关闭 DingTalk 登录，但不会破坏现有本地账号体系。

## Security Notes

上线后应立即做这几件事：

1. 轮换 DingTalk `Client Secret`
2. 轮换服务器管理密码
3. 轮换管理员初始密码
4. 清理联调阶段多余测试会话

不要把长期有效的服务器密码或 DingTalk 密钥继续留在聊天记录、截图或共享文档里。

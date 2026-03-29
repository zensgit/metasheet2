# DingTalk Auth Ops Preflight

## Goal

在真实企业联调前，先把最容易出问题的配置组合做本地静态预检，避免：

- 没配 `PUBLIC_APP_URL`
- callback URL 路径不对
- 只配了 fallback `APP_KEY/APP_SECRET`
- 开了自动开户但没限制企业范围

## Script

- [scripts/dingtalk-auth-preflight.mjs](/Users/huazhou/Downloads/Github/metasheet2/scripts/dingtalk-auth-preflight.mjs)

## Checks

脚本会检查：

- `DINGTALK_AUTH_ENABLED`
- `DINGTALK_CLIENT_ID`
- `DINGTALK_CLIENT_SECRET`
- `PUBLIC_APP_URL`
- 推导后的 `DINGTALK_REDIRECT_URI`
- `JWT_SECRET`
- `CORS_ORIGIN`
- `DINGTALK_ALLOWED_CORP_IDS`
- `DINGTALK_AUTO_PROVISION*`

## Example Commands

禁用场景：

```bash
node scripts/dingtalk-auth-preflight.mjs
```

启用场景：

```bash
DINGTALK_AUTH_ENABLED=true \
DINGTALK_CLIENT_ID=mock-client \
DINGTALK_CLIENT_SECRET=mock-secret \
PUBLIC_APP_URL=https://app.example.com \
JWT_SECRET=mock-jwt \
CORS_ORIGIN=https://app.example.com \
DINGTALK_ALLOWED_CORP_IDS=dingcorp-1 \
DINGTALK_AUTO_PROVISION=true \
DINGTALK_AUTO_PROVISION_PRESET_ID=attendance-employee \
DINGTALK_AUTO_PROVISION_ORG_ID=default \
DINGTALK_AUTO_PROVISION_EMAIL_DOMAIN=dingtalk.local \
node scripts/dingtalk-auth-preflight.mjs
```

## Rollout Sequence

1. 先在目标环境填好 `.env` 或密钥平台变量。
2. 跑 preflight，确保 callback URL 和自动开户策略合理。
3. 再执行数据库 migration。
4. 再做真实 DingTalk 企业扫码与免登联调。
5. 最后做 staging 验收和发布。

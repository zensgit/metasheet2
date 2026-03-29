# DingTalk Auth Go-Live Checklist

## Current Live State

目标环境：`http://142.171.239.56:8081`

部署说明：

- [dingtalk-auth-deployment-20260324.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/dingtalk-auth-deployment-20260324.md)
- [dingtalk-auth-credential-rotation-20260324.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/dingtalk-auth-credential-rotation-20260324.md)

当前已生效配置：

- `PUBLIC_APP_URL=http://142.171.239.56:8081`
- `DINGTALK_AUTH_ENABLED=true`
- `DINGTALK_ALLOWED_CORP_IDS=dingd1f07b3ff4c8042cbc961a6cb783455b`
- `DINGTALK_REDIRECT_URI=http://142.171.239.56:8081/auth/dingtalk/callback`
- `DINGTALK_SCOPE=openid corpid Contact.User.Read`
- `DINGTALK_AUTO_PROVISION=false`

当前已确认行为：

- 本地管理员账号可正常登录
- `zen0888@live.com` 已绑定 DingTalk
- 顶栏退出后会清空本地会话并回到登录页
- 登录页点击“钉钉登录”会跳到钉钉统一身份认证页
- 已完成一次真实 DingTalk 登录进入系统

## Immediate Actions

上线收口优先做这三项：

1. 轮换服务器 `root` 密码。
2. 评估并决定是否轮换 DingTalk `Client Secret`。
3. 清理联调阶段多余测试会话与临时账号。

当前状态：

- 管理员密码已完成轮换并验证可登录

## Recommended Operating Mode

当前建议维持：

- 保持 `DINGTALK_AUTO_PROVISION=false`
- 仅允许已存在 MetaSheet 账号先绑定后登录
- 不要立即放开“首次钉钉登录自动开户”

原因：

- 现在线上已经验证了“已有账号绑定后直登”闭环。
- 自动开户还没有对默认组织、默认权限模板和邮箱占位策略做真实业务验收。
- 先把登录稳定性跑一轮，比马上放开开户更稳妥。

## Acceptance Checklist

每次上线后按这个顺序验收：

1. 打开 `/login`
2. 使用本地账号登录
3. 打开 `/settings`
4. 确认页面首屏自动显示 DingTalk 绑定卡片
5. 点击右上角“退出登录”
6. 确认浏览器落在 `/login?redirect=...`
7. 点击“钉钉登录”
8. 完成钉钉认证
9. 确认直接进入系统，而不是回到登录页或提示未绑定

## Before Enabling Auto Provision

如果后续要开启自动开户，先补这三个决策：

1. 默认组织 ID
2. 默认权限 preset / 角色模板
3. 占位邮箱域名策略

建议最小配置：

- `DINGTALK_AUTO_PROVISION=true`
- `DINGTALK_AUTO_PROVISION_ORG_ID=<target-org>`
- `DINGTALK_AUTO_PROVISION_PRESET_ID=<least-privilege-preset>`
- `DINGTALK_AUTO_PROVISION_EMAIL_DOMAIN=<controlled-domain>`

并继续保留：

- `DINGTALK_ALLOWED_CORP_IDS=dingd1f07b3ff4c8042cbc961a6cb783455b`

## Rollback

如果钉钉登录出现异常，最小回滚策略是：

1. 将 `DINGTALK_AUTH_ENABLED=false`
2. 重启 backend
3. 保留本地邮箱密码登录作为兜底入口

这样不会影响现有本地账号体系。

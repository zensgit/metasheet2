# DingTalk Auth Credential Rotation Guide

## Goal

这份文档用于联调完成后的密码和密钥轮换。

适用场景：

- 已完成 DingTalk 登录联调
- 聊天、截图或临时文档中暴露过管理员密码、服务器密码或 DingTalk 密钥
- 需要在上线前把临时凭据全部换掉

## Rotation Order

建议顺序：

1. MetaSheet 管理员密码
2. 服务器 `root` 密码
3. DingTalk `Client Secret`

原因：

- 管理员密码最容易继续被误用，应先处理。
- 服务器密码影响运维入口，应尽快轮换。
- DingTalk `Client Secret` 需要同步平台和服务器配置，放最后更稳妥。

## 1. Rotate MetaSheet Admin Password

推荐用管理员接口重置：

```bash
TOKEN=$(curl -fsS -X POST http://<host>/api/auth/login \
  -H 'Content-Type: application/json' \
  --data '{"email":"<admin-email>","password":"<current-password>"}' | jq -r '.data.token')

curl -fsS -X POST http://<host>/api/admin/users/<user-id>/reset-password \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"password":"<new-strong-password>"}'
```

然后立刻验证：

```bash
curl -sS -X POST http://<host>/api/auth/login \
  -H 'Content-Type: application/json' \
  --data '{"email":"<admin-email>","password":"<new-strong-password>"}'
```

预期：

- 新密码登录返回 `success: true`
- 旧密码登录返回 `Invalid email or password`

说明：

- 当前实现会在重置密码后撤销该用户的旧会话
- 所以旧浏览器会话可能需要重新登录

## 2. Rotate Server Root Password

在服务器本机控制台或现有 root 会话中执行：

```bash
passwd
```

如果你是为其他账号轮换：

```bash
passwd <username>
```

完成后立刻验证：

1. 新开一个终端窗口
2. 用新密码测试 SSH
3. 确认能登录后，再关闭旧会话

不要先退出唯一的 root 会话再测试。

## 3. Rotate DingTalk Client Secret

这一步必须在 DingTalk 开放平台完成。

步骤：

1. 打开 DingTalk 开放平台对应应用
2. 生成或重置新的 `Client Secret`
3. 同步更新服务器环境变量：

```bash
DINGTALK_CLIENT_SECRET=<new-secret>
```

4. 重启 backend
5. 验证 `/api/auth/dingtalk/login-url?redirect=/settings` 仍返回 `200`

如果平台同时变更了其他配置，记得同步核对：

- `Client ID`
- 回调地址
- 权限项 `Contact.User.Read`

## Post-Rotation Verification

三项轮换完成后，按这个顺序验收：

1. 本地管理员密码登录成功
2. 旧管理员密码登录失败
3. 服务器新 root 密码可登录
4. 打开 `/login`
5. 点击“钉钉登录”
6. 完成 DingTalk 认证
7. 确认进入系统

## Notes

- 不要把新的服务器密码、管理员密码或 DingTalk `Client Secret` 写回仓库文档。
- 新密码应存放到受控密码管理器，而不是聊天记录。
- 如果轮换 DingTalk `Client Secret` 后登录失败，先检查服务器是否已经加载了新环境变量。

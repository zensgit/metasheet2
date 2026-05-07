# DingTalk 142 管理员联调 Token 恢复与关键接口验证

## 目标

- 恢复 142 环境可用的管理员联调 token。
- 验证主站关键后台入口可访问，避免后续联调继续卡在鉴权入口。
- 明确当前真实环境的“服务可用”与“联调入口可用”两类结论。

## 背景

- 本地旧文件 `/tmp/metasheet-142-main-admin-72h*.jwt` 已不存在。
- 142 服务本身运行正常，但之前手工签发的 token 返回 `Invalid token`。
- 需要按照项目当前真实用户身份重建一份可用管理员 token。

## 处理过程

### 1. 确认 142 当前管理员用户

- 通过 142 PostgreSQL 查询 `users`：
  - `zhouhua@china-yaguang.com`
  - `role=admin`
  - `id=b928b8d9-8881-43d7-a712-842b28870494`

### 2. 重新生成本地 72h 管理员 token 文件

- 生成文件：
  - `/tmp/metasheet-142-main-admin-72h-20260506T085320Z.jwt`
- 更新软链：
  - `/tmp/metasheet-142-main-admin-72h.jwt`

### 3. 验证 `/api/auth/me`

- 使用新 token 访问：

```bash
curl http://142.171.239.56:8081/api/auth/me -H "Authorization: Bearer <token>"
```

- 返回成功：
  - `success: true`
  - `user.id = b928b8d9-8881-43d7-a712-842b28870494`
  - `email = zhouhua@china-yaguang.com`
  - `role = admin`
  - `features.plm = true`

### 4. 验证关键后台入口

- 用户治理入口：

```bash
curl 'http://142.171.239.56:8081/api/admin/users?limit=1' -H "Authorization: Bearer <token>"
```

- 返回 `ok: true`，已拿到用户列表。

- 目录同步入口：

```bash
curl 'http://142.171.239.56:8081/api/admin/directory/integrations' -H "Authorization: Bearer <token>"
```

- 返回 `ok: true`，已拿到 DingTalk 目录集成信息。

## 当前结论

- 142 服务健康。
- 142 管理员联调 token 已恢复。
- `api/auth/me`、`api/admin/users`、`api/admin/directory/integrations` 已验证可访问。
- 当前可以继续进入：
  - 142 联调验收清单回填
  - 正式交付结论回填
  - 上线观察记录模板回填

## 后续建议

- 优先使用本地软链文件：

```bash
TOKEN="$(cat /tmp/metasheet-142-main-admin-72h.jwt)"
```

- 后续所有 142 后台接口联调统一复用该 token。
- 在 token 过期前完成本轮 142 验收；若后续继续需要，可按同样方式重新生成新的本地文件并再次验证 `/api/auth/me`。

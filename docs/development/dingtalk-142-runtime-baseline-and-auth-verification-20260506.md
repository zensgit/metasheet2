# DingTalk 142 运行基线与鉴权验证记录

## 目标

- 确认 142 服务器当前 MetaSheet 主站是否正常运行。
- 核验前后端容器、后端健康检查、现有管理员联调入口是否可继续使用。
- 识别当前真实环境联调的首要阻塞项。

## 验证步骤

### 1. 连接 142

- 使用本机 SSH 别名 `metasheet-142`
- 解析配置：
  - HostName: `142.171.239.56`
  - User: `mainuser`

### 2. 检查主站容器

- 主站容器运行中：
  - `metasheet-web`
  - `metasheet-backend`
  - `metasheet-postgres`
  - `metasheet-redis`

### 3. 检查后端健康

- 通过 142 本机访问后端：

```bash
curl http://127.0.0.1:8900/api/health
```

- 返回：
  - `ok: true`
  - `status: ok`

说明后端服务当前健康，数据库连接池也正常返回。

### 4. 检查主站 8081

- `http://127.0.0.1:8081/health` 返回的是前端页面 HTML，不是后端健康接口。
- 说明 8081 是 nginx / web 容器入口，真正的后端健康验证应走 `/api/health`。

### 5. 检查管理员 JWT 联调入口

- 本地旧文件 `/tmp/metasheet-142-main-admin-72h*.jwt` 已不存在。
- 已重新在 142 容器内生成新的 72h 本地文件：
  - `/tmp/metasheet-142-main-admin-72h-20260506T084911Z.jwt`
  - 软链：`/tmp/metasheet-142-main-admin-72h.jwt`

- 但使用该 token 访问：

```bash
curl http://142.171.239.56:8081/api/auth/me -H "Authorization: Bearer <token>"
```

- 当前返回：
  - `401 Unauthorized`
  - `Invalid token`

## 当前结论

- `142` 主站服务本身是运行中的。
- 后端健康检查正常。
- 当前真实环境联调的首要阻塞不是服务不可用，而是：
  - `管理员 JWT 联调入口尚未补通`

## 初步原因判断

- 142 当前未开启 `RBAC_TOKEN_TRUST`
- 不能依赖手工 claim token 作为可信 token 使用
- 需要走项目实际认可的用户 / session 鉴权链路，或从真实登录流程获取可用 token

## 下一步建议

- 优先补通一个真实可用的管理员联调 token。
- 补通后立即验证：
  - `/api/auth/me`
  - 用户治理入口
  - 目录同步入口
  - 审计入口
- 然后再开始回填 `142 联调验收清单` 与 `正式交付结论`

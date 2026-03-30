# DingTalk Directory Console Hardening Verification

## Scope

本轮验证覆盖以下增强：

- 后端目录账号列表高级筛选
- 后端目录账号列表分页元信息与摘要字段
- 后端目录账号 CSV 导出
- OpenAPI 契约更新
- 前端目录管理页“测试连接”
- 前端目录管理页分页与筛选
- 前端目录管理页 CSV 导出
- 前端目录管理页开户后临时密码回显
- 前端目录管理页钉钉授权按钮动态切换
- 目录管理 smoke 脚本
- DingTalk 缺权限错误结构化透传与前端 remediation 提示

## Commands Run

已实际执行：

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/admin-directory-routes.test.ts \
  tests/unit/directory-sync.test.ts

node scripts/openapi-check.mjs

pnpm --filter @metasheet/core-backend build

pnpm --filter @metasheet/web exec vitest run \
  tests/directoryManagementView.spec.ts \
  tests/dingtalkAuthCallbackView.spec.ts \
  tests/sessionCenterView.spec.ts \
  tests/userManagementView.spec.ts

pnpm --filter @metasheet/web exec vue-tsc --noEmit

pnpm --filter @metasheet/web build

node scripts/dingtalk-directory-smoke.mjs --help

pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/error-utils.test.ts \
  tests/unit/admin-directory-routes.test.ts \
  tests/unit/directory-sync.test.ts

pnpm --filter @metasheet/web exec vitest run \
  tests/directoryManagementView.spec.ts
```

## Result

结果如下：

- backend 定向单测通过
  - `24` 项通过
  - 覆盖新增高级筛选参数透传、目录服务边界行为、CSV 导出分页聚合、截断头、CSV 转义与失败路径
- OpenAPI check 通过
- backend build 通过
- frontend 定向单测通过
  - `44` 项通过
  - 覆盖目录页测试连接、分页请求、授权动作与既有 IAM 相关页面
- `vue-tsc --noEmit` 通过
- web build 通过
- smoke 脚本帮助输出通过
- smoke 脚本全链路在本地 mock 目录服务上通过
  - 覆盖 `/accounts/export.csv`、`Content-Disposition`、`X-Export-*` 响应头与 CSV 头行校验
- DingTalk 权限错误定向校验通过
  - backend `29` 项通过
  - frontend 目录页 `11` 项通过
  - 覆盖 live-style `subcode=60011` 报错解析、`requiredScopes` / `applyUrl` 透传、目录页 remediation 展示

## Functional Checks

本轮新增能力已验证：

- `GET /api/admin/directory/integrations/{integrationId}/accounts` 支持：
  - `q`
  - `linkStatus`
  - `isActive`
  - `matchStrategy`
  - `dingtalkAuthEnabled`
  - `isBound`
  - `departmentId`
- 响应体包含：
  - `total`
  - `page`
  - `pageSize`
  - `pageCount`
  - `hasNextPage`
  - `hasPreviousPage`
  - `summary`
- `GET /api/admin/directory/integrations/{integrationId}/accounts/export.csv` 支持：
  - 继承当前筛选条件
  - 导出规模限制
  - `Content-Disposition` 文件名
  - 导出总量与截断状态头部
  - 分页聚合导出与 CSV 特殊字符转义
- 前端目录页：
  - 首次加载会带 `page=1&pageSize=20`
  - 可点击“测试连接”
  - 可点击“下一页”加载后续成员
  - 可点击“导出 CSV”导出当前筛选结果
  - 当钉钉返回缺 scope 错误时，会展示缺少的权限项和申请链接
  - 历史同步运行记录中的 live-style 错误字符串，会被重新解析成可操作 remediation 提示
  - 开通本地账号后会直接展示临时密码与邮箱
  - 钉钉授权按钮会根据当前账号状态动态切换文案
  - 不影响授权钉钉登录、开户、解绑等既有操作

## Script Verification

本轮额外验证了目录 smoke 脚本的新校验面：

- 在本地 mock 目录服务上执行成功
- 正确校验成员列表分页字段
- 正确校验成员摘要字段
- 正确校验导出接口的 `text/csv`
- 正确校验导出接口的 `Content-Disposition`
- 正确校验导出接口的 `X-Export-Total / X-Export-Returned / X-Export-Truncated`
- 正确校验导出 CSV 头行

## Live Verification

本轮还完成了目标环境真实 smoke 回归：

- 环境：`http://142.171.239.56:8081`
- 目录集成：`e159e6fc-3ba8-4de8-8db6-3effde87fc0d`
- 目录名称：`DingTalk Directory Sync`

现网过程中先后暴露并修复了两类真实问题：

1. `/accounts/export.csv` 被旧版 backend 误匹配到 `/:accountId`
2. `/accounts` 在真实 PostgreSQL 上触发 `uuid = text` 类型比较错误

处理结果：

- 已把最新 backend 源码同步到现网服务器并重建 backend 镜像
- 已按现网原始 compose 项目名 `metasheet` 重启 backend，避免错误落到 `metasheet2_default` 网络
- 真实 smoke 已通过：
  - `/api/admin/directory/integrations`
  - `/runs`
  - `/departments`
  - `/accounts?page=1&pageSize=20`
  - `/accounts/export.csv?limit=100`
  - `POST /sync` 失败时已返回结构化权限 remediation
  - 线上前端静态资源已包含“钉钉应用缺少通讯录权限”提示文案

真实 smoke 输出结果：

- `integrations=1`
- `runs=1`
- `departments=0`
- `accountsOnPage=0`
- `totalAccounts=0`
- 导出响应头完整
- 导出 CSV 头行完整

最近一次真实同步运行状态也已确认：

- `status=error`
- `startedAt=2026-03-25T01:40:43.601Z`
- `errorMessage` 明确指向钉钉开放平台权限缺失
- 当前缺少 scope：`qyapi_get_department_list`
- 阻塞性质：外部配置未完成，不是 MetaSheet 同步接口或数据库异常

本轮重新部署后的真实接口返回也已确认：

- `POST /api/admin/directory/integrations/{integrationId}/sync`
  - `error.code=DINGTALK_PERMISSION_REQUIRED`
  - `error.details.provider=dingtalk`
  - `error.details.subcode=60011`
  - `error.details.requiredScopes=["qyapi_get_department_list"]`
  - `error.details.applyUrl` 指向钉钉开放平台申请页
- 线上 smoke 二次回归通过：
  - `runs=2`
  - `departments=0`
  - `totalAccounts=0`
  - 导出契约仍正常

## Final Live Verification

在用户提供新钉钉应用凭据并补齐通讯录权限后，已完成最终一轮真实联调：

- 目录集成已切到新应用：
  - `corpId=dingd1f07b3ff4c8042cbc961a6cb783455b`
  - 目录同步 appKey 已切换到新应用
- 后端真实问题已继续修复并部署：
  - 修复 `directory_account_departments` / `directory_accounts` 的 `uuid = text` 比较错误
  - 修复同步成功后将游标直接写入 `jsonb` 字段导致的 `invalid input syntax for type json`
  - 现网库补齐 `users.mobile` 字段，保证按手机号匹配可用
- 真实同步结果：
  - `POST /api/admin/directory/integrations/{integrationId}/sync` 返回 `status=success`
  - 最新 run：`325df9d5-7f47-4662-b80a-cc59ab38dc1b`
  - `accountsFetched=1`
  - `accountsUpdated=1`
  - `errorMessage=null`
- 真实 smoke 再次通过：
  - `runs=6`
  - `departments=0`
  - `accountsOnPage=1`
  - `totalAccounts=1`
  - 导出返回 `text/csv; charset=utf-8`
  - `X-Export-Total=1`
  - `X-Export-Returned=1`
  - `X-Export-Truncated=false`
- 目录同步写入后的真实状态：
  - 当前有 1 条钉钉目录账号记录
  - 当前摘要为 `pending=1 / active=1 / unbound=1 / dingtalkAuthDisabled=1`
  - 说明目录同步与待审核开户链路已打通，下一步重点是绑定/授权和自动化策略
- 钉钉扫码登录也已切到同一套新应用：
  - 服务器 `docker/app.env` 中 `DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET` 已更新
  - `/api/auth/dingtalk/login-url?redirect=/settings` 已确认返回新 `client_id`

## Final Account Closure Verification

在确认真实子部门 `1068569133` 可读后，已把目录集成的 `rootDepartmentId` 从根部门 `1` 切换到该子部门，并再次执行真实同步：

- 最新成功 run：`13237078-e624-4dcc-aa5d-8996e95fb555`
- 同步结果：
  - `accountsFetched=1`
  - `accountsInserted=1`
  - `accountsDeactivated=1`
  - `errorMessage=null`
- 当前目录中的活跃账号已切换为子部门成员 `zaah`

随后已在现网完成该账号的“开通 + 授权 + 绑定”闭环：

- 目录账号：`zaah`
- 手机号：`18367808344`
- 自动生成的 MetaSheet 邮箱：`0357574763363730830@dingtalk.local`
- 目录详情状态：
  - `linkStatus=linked`
  - `dingtalkAuthEnabled=true`
  - `isBound=true`
- 数据库已确认：
  - `user_external_identities` 中存在对应 `dingtalk` 绑定
  - `user_external_auth_grants.enabled = true`

这意味着该账号已经满足钉钉扫码登录的后端前置条件。

## Residual Risk

- 现网组织下当前仅同步到 1 个成员、0 个子部门；如果预期应更多，需要继续核对钉钉组织结构和应用可见范围
- 首次登录自动开户策略当前仍按既定方案 B 运行，未切到“钉钉首次登录自动开通”模式
- web build 仍保留既有大 bundle warning，但不影响本轮功能正确性
- CSV 导出和开户临时密码回显依赖前端对响应头与响应体的解析，后续如改动接口契约需要同步更新控制台提示文案

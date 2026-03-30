# DingTalk Directory Sync Verification

## Status

截至 2026-03-25，这个能力已经完成本地实现与静态验证，但还没有做真实 DingTalk 组织目录联调。

已完成：

- 后端 migration、服务、路由、调度接线
- 前端 `/admin/directory` 管理页
- 目录路由单测
- 目录服务层单测
- 目录页前端测试
- OpenAPI 路径与 schema
- OpenAPI build / validate / parse check
- backend build
- `vue-tsc --noEmit`
- web build

待完成：

- DingTalk 应用补齐通讯录权限后重新做真实凭据测试
- 首次真实成功同步
- 已绑定用户识别与离职策略联调验收

## Local Validation Result

本轮已实际通过以下命令：

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/directory-sync.test.ts \
  tests/unit/admin-directory-routes.test.ts

pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/admin-directory-routes.test.ts \
  tests/unit/admin-users-routes.test.ts \
  tests/unit/auth-login-routes.test.ts

pnpm --filter @metasheet/core-backend build

pnpm --filter @metasheet/web exec vitest run \
  tests/directoryManagementView.spec.ts \
  tests/sessionCenterView.spec.ts \
  tests/userManagementView.spec.ts

pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build

node scripts/openapi-check.mjs
```

结果：

- backend 目录服务/路由单测：`8` 项通过（含手机号重复命中边界用例）
- 目录相关路由单测：`61` 项通过（`tests/unit/directory-sync.test.ts`、`tests/unit/admin-directory-routes.test.ts`、`tests/unit/admin-users-routes.test.ts`）
- backend build 通过
- `vue-tsc --noEmit` 通过
- web build 通过
- OpenAPI check 通过

附注：

- web build 仍有既有的大 bundle warning，但不影响这次功能正确性

## Live Deployment Result

本轮还完成了现网部署与第一轮真实联调。

部署环境：

- 服务器：`142.171.239.56`
- 地址：`http://142.171.239.56:8081`
- 目录同步接口：`/api/admin/directory/*`

现网已验证：

- `GET /api/admin/directory/integrations` 返回 `200`
- 已成功创建 1 个 DingTalk 目录 integration
- `POST /api/admin/directory/integrations/:id/test` 已命中真实 DingTalk API
- `POST /api/admin/directory/integrations/:id/sync` 失败时会写入 `directory_sync_runs`
- `GET /api/admin/directory/integrations/:id/runs` 返回 `200`

现网真实阻塞：

- `test` 和 `sync` 都返回钉钉真实权限错误，而不再是泛化错误
- 当前已确认缺少：
  - `qyapi_get_department_list`
  - `qyapi_get_department_member`

现网错误样例：

- `DIRECTORY_INTEGRATION_TEST_FAILED`
- `DIRECTORY_SYNC_FAILED`
- 错误信息中已直接透传 DingTalk `subcode=60011` 和缺失 scope 名称

结论：

- MetaSheet 目录同步代码、部署、错误可观测性都已就绪
- 当前未能完成首次真实成功同步，原因是 DingTalk 应用未开通通讯录 scope，而不是 MetaSheet 代码缺陷

## Local Scope Covered

本轮本地验证已经覆盖：

- 目录集成新增、编辑、列表
- cron 非法值校验
- 手动同步接口
- scheduled run 互斥 skip 逻辑
- 同步运行记录接口
- 部门、成员、成员详情接口
- `external_identity` 冲突优先级
- `email_exact` 自动匹配
- `mobile_exact` 自动匹配（手机号唯一命中时自动 linked）
- `mobile_exact` 冲突边界（同一手机号匹配多用户时保持 pending）
- 关联已有账号
- 开通本地账号
- 无邮箱开户拒绝
- 授权钉钉登录
- 忽略、解绑、离职策略覆盖
- `disable_dingtalk_auth` 离职策略
- `disable_local_user` 离职策略
- 集成上下文别名路由
- 前端目录管理页加载与主要交互
- 方案 B 与现有 DingTalk 登录链路共存不回归

## Known Implementation Boundary

当前 v1 有一个明确边界：

`mobile_exact` 已接入，当前自动匹配策略包括：

- `external_identity`
- `email_exact`（唯一邮箱命中）
- `mobile_exact`（手机号归一化为数字串后唯一命中）
- `mobile_exact` 多命中（同一手机号对应多个本地账号时暂不自动链接）

## External Verification Matrix

下面这些仍需在真实 DingTalk 目录权限和凭据准备好后完成：

### 1. 连接配置

步骤：

1. 新建一个 `dingtalk` 目录 integration
2. 填入 `corpId / appKey / appSecret / rootDepartmentId`
3. 点击“测试连接”

预期：

- 配置校验通过
- 凭据无效时返回结构化错误
- 不写入成员目录脏数据

本轮结果：

- integration 已成功创建
- `test` 已能稳定命中 DingTalk
- 当前因缺少 `qyapi_get_department_list` 无法通过

### 2. 首次手动同步

步骤：

1. 点击“立即同步”
2. 观察 run 状态
3. 打开部门树和成员列表

预期：

- `directory_sync_runs.status=success`
- 部门数、成员数、更新数可见
- `directory_departments`、`directory_accounts` 有数据
- 同一成员不会重复插入

本轮结果：

- `sync` 已能稳定执行到真实 DingTalk API
- 因缺少 `qyapi_get_department_list`，run 当前落为 `error`
- `error_message` 已持久化到 `directory_sync_runs`

### 3. 已有绑定用户自动识别

前置：

- 现网已有至少 1 个已绑定 DingTalk 的 MetaSheet 用户

步骤：

1. 跑一次目录同步
2. 查看该成员在目录页的状态

预期：

- 状态为 `已绑定` 或等价状态
- 匹配策略显示为 `external_identity`
- 不会生成重复 link

### 4. 邮箱唯一匹配

前置：

- 钉钉目录成员邮箱与 MetaSheet 用户邮箱完全一致

步骤：

1. 跑同步
2. 查看该成员详情

预期：

- 状态为 `待审核`
- 匹配策略为 `email_exact`
- 系统不应自动授权钉钉登录

### 5. 冲突用户

前置：

- 已有绑定身份与邮箱匹配到不同本地用户，或管理员手工制造冲突样本

预期：

- 状态为 `冲突待处理`
- 不自动继续授权
- 管理员必须手动处理

### 6. 未匹配用户开户

前置：

- 目录成员在 MetaSheet 中不存在

步骤：

1. 对一个 `未匹配` 成员点击“开通本地账号”
2. 当目录里没有邮箱时，由管理员手动填写邮箱

预期：

- 写入 `users`
- 建立 `directory_account_links`
- 若未额外勾选授权，则 `user_external_auth_grants.enabled=false`

### 7. 授权钉钉登录

步骤：

1. 对一个已 link 的成员点击“授权钉钉登录”
2. 查看用户详情与授权状态

预期：

- `user_external_auth_grants.enabled=true`
- 用户管理页与目录页状态一致
- 会话中心允许该账号发起绑定

### 8. 三种离职策略

步骤：

1. 在 integration 上分别配置三种默认离职策略
2. 在目录成员上覆盖其中一种策略
3. 在钉钉侧把该成员移出同步可见范围后重新跑同步

预期：

- `mark_inactive`: 仅目录记录失活
- `disable_dingtalk_auth`: 关闭 DingTalk 登录授权，但不禁用密码登录
- `disable_local_user`: 本地账号停用，同时关闭 DingTalk 登录授权

### 9. 定时同步

步骤：

1. 给 integration 配置 `scheduleCron`
2. 启动服务
3. 观察 run 记录

预期：

- 定时任务自动创建 run
- 同一 integration 不并发执行
- 并发触发时后续 run 记为 `skipped`

## Acceptance Standard

建议把“真实联调验收通过”定义为：

- 目录同步成功跑通 2 次以上
- 成员和部门数量与钉钉后台量级一致
- `已绑定 / 待审核 / 冲突 / 未匹配` 4 类状态都能正确出现
- 目录同步不会绕过方案 B
- 至少 1 个“未匹配成员 -> 开通本地账号 -> 授权钉钉登录 -> 绑定/直登”链路通过

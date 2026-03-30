# DingTalk Directory Sync Deployment Guide

## Goal

这份文档说明如何把 MetaSheet 的钉钉目录同步能力部署到目标环境，并在上线后完成最小可运营验收。

适用范围：

- 新环境首次启用钉钉组织目录同步
- 已上线 MetaSheet，需要补上目录同步控制台与导出能力
- 需要给运维或交付方一份可重复执行的目录同步上线步骤

## What Gets Deployed

当前目录同步交付包含这些能力：

1. 目录集成管理
2. 手动同步与同步运行记录
3. 部门目录与成员目录查看
4. 成员筛选、绑定、开户、授权、解绑、离职策略覆盖
5. 成员目录 `CSV` 导出
6. 目录 smoke 校验脚本

## DingTalk Side Prerequisites

在钉钉开放平台侧，目录同步至少要满足：

1. 已创建一个可访问企业通讯录的应用
2. 已获取：
   - `CorpID`
   - `AppKey / Client ID`
   - `AppSecret / Client Secret`
3. 已开通目录同步所需通讯录权限

当前已知最少需要：

- `qyapi_get_department_list`
- `qyapi_get_department_member`

如果这两个权限未开通：

- “测试连接”会失败
- “立即同步”会失败
- 失败信息会落到 `directory_sync_runs.error_message`
- 当前目录控制台会直接展示缺少的 scope 与钉钉开放平台申请链接
- `POST /api/admin/directory/integrations/{integrationId}/sync` 也会返回结构化错误：
  - `error.code=DINGTALK_PERMISSION_REQUIRED`
  - `error.details.requiredScopes`
  - `error.details.applyUrl`

## Database Migration

目录同步依赖专用表，部署前必须执行最新 migration：

```bash
pnpm --filter @metasheet/core-backend migrate
```

至少要确认目录相关表已经存在：

- `directory_integrations`
- `directory_sync_runs`
- `directory_departments`
- `directory_accounts`
- `directory_account_links`

## Build

发布前建议完成以下构建与回归：

```bash
pnpm install

pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/admin-directory-routes.test.ts \
  tests/unit/directory-sync.test.ts

pnpm --filter @metasheet/web exec vitest run \
  tests/directoryManagementView.spec.ts \
  tests/dingtalkAuthCallbackView.spec.ts \
  tests/sessionCenterView.spec.ts \
  tests/userManagementView.spec.ts

pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
node scripts/openapi-check.mjs
```

## Admin Setup

目录同步不是纯环境变量开关，还需要管理员在系统里创建集成配置：

1. 管理员登录 MetaSheet
2. 打开 `/admin/directory`
3. 新建一个 `dingtalk` 目录集成
4. 填写：
   - 集成名称
   - `CorpID`
   - `AppKey / Client ID`
   - `AppSecret / Client Secret`
   - 根部门 ID（可选）
   - 定时同步 Cron（可选）
   - 默认离职策略
5. 点击“测试连接”
6. 点击“立即同步”

## Deploy Sequence

推荐顺序：

1. 更新 backend 代码与 migration
2. 执行 migration
3. 重启 backend
4. 发布 frontend 静态资源
5. 管理员创建或更新目录集成
6. 执行 smoke 验证
7. 再做浏览器验收

## Current Server Note

当前 `142.171.239.56` 这套环境有一个很关键的运行约束：

- Docker Compose 项目名必须保持为 `metasheet`
- backend / web / postgres / redis 依赖同一张网络：`metasheet_default`

如果误用目录默认项目名（例如在 `/home/mainuser/metasheet2` 下直接跑未显式指定项目名的 `docker-compose`）：

- 会新建 `metasheet2_default`
- 新 backend 会被挂到错误网络
- backend 启动时无法解析 `postgres`
- web 侧会持续出现 `502 Bad Gateway`

因此在这台机子上重启 backend 时，推荐命令是：

```bash
cd /home/mainuser/metasheet2
docker build -f Dockerfile.backend -t ghcr.io/local/metasheet2-backend:current .
docker rm -f metasheet-backend || true
docker-compose -p metasheet -f docker-compose.app.yml up -d --no-deps backend
```

## Post-deploy Smoke

上线后优先使用目录 smoke 脚本，而不是手工逐页点界面：

```bash
node scripts/dingtalk-directory-smoke.mjs \
  --base-url http://host:8081 \
  --token <admin-bearer-token> \
  --integration-id <directory-integration-id> \
  --page-size 20 \
  --export-limit 100
```

这个脚本会校验：

1. `GET /api/admin/directory/integrations`
2. `GET /runs`
3. `GET /departments`
4. `GET /accounts?page=1&pageSize=N`
5. `GET /accounts/export.csv?limit=N`

它会断言这些关键点：

- 目录列表返回正常
- 成员分页字段完整
- `summary` 字段完整
- 导出返回 `text/csv`
- 导出返回 `Content-Disposition`
- 导出返回 `X-Export-Total`
- 导出返回 `X-Export-Returned`
- 导出返回 `X-Export-Truncated`
- 导出 CSV 含预期表头

## Export Operations Note

目录导出现在是运营导向，不是快照归档导向。

当前行为：

- 导出复用当前筛选条件
- 默认导出上限 `5000`
- 最大导出上限 `10000`
- 导出由后端按分页聚合后拼出一份 CSV

这意味着：

- 适合管理员筛选后导出复核
- 适合线下交付、人工审核、批量处理
- 不建议把它当成严格一致性的全量归档备份

如果目录数据在导出过程中发生变化，理论上仍可能出现跨页重复或遗漏。

前端会根据这些响应头提示导出规模：

- `X-Export-Total`
- `X-Export-Returned`
- `X-Export-Truncated`

## Browser Acceptance

smoke 通过后，再做页面验收：

1. 打开 `/admin/directory`
2. 选择目录集成
3. 确认最近同步卡片可见
4. 确认成员概览卡片可见
5. 确认成员分页正常
6. 确认筛选项可用
7. 点击“导出 CSV”
8. 确认下载成功
9. 选择一个成员
10. 确认可执行开户、授权/取消授权、解绑、忽略、离职策略覆盖
11. 如果同步失败，确认页面能直接显示缺少的 DingTalk scope 和申请链接

## Rollback

最小回滚方式：

1. 在目录集成里关闭定时同步
2. 停止继续手动同步
3. 保留既有 DingTalk 登录与 MetaSheet 本地登录
4. 如有必要，移除或停用对应目录集成

这会暂停目录同步，但不会直接破坏现有本地账号或已绑定账号。

## Operational Boundary

上线时建议把下面这段明确交给运维和管理员：

- 目录导出是“按分页聚合的运营导出”，不是“事务性快照导出”
- 超大组织若需要全量、严格一致的归档导出，应走专门离线任务，不应直接复用控制台导出
- 钉钉通讯录 scope 缺失时，优先修复应用权限，不要误判为 MetaSheet 代码故障

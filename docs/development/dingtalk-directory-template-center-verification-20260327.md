# DingTalk Directory Template Center Verification

日期：2026-03-27

## 验证范围

覆盖以下 4 项：

1. 服务端预设中心
2. 治理报表导出
3. 定时目录同步与异常告警
4. GitHub 基线材料

## 本地验证

### 后端单测

命令：

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-directory-routes.test.ts tests/unit/directory-sync.test.ts
```

结果：

- 通过
- `2` 个测试文件
- `41` 项测试通过

覆盖点：

- 模板中心读写
- 模板中心版本回滚
- 治理报表 JSON / CSV
- 计划同步状态
- 告警列表与确认
- 告警写入与 webhook 发送

### 前端单测

命令：

```bash
pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts
```

结果：

- 通过
- `58` 项测试通过

覆盖点：

- 服务端模板中心空仓加载
- 本地缓存迁移到服务端
- 服务端治理资源加载
- 告警确认
- 既有模板/预设/失败处理流程回归

### 前端类型检查

命令：

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

结果：

- 通过

### 前端构建

命令：

```bash
pnpm --filter @metasheet/web build
```

结果：

- 通过
- 产物：
  - `apps/web/dist/index.html`
  - `apps/web/dist/assets/index-CokZNhFS.js`
  - `apps/web/dist/assets/index-C7UJjiOl.css`

### OpenAPI 校验

命令：

```bash
node scripts/openapi-check.mjs
```

结果：

- 通过
- `OpenAPI security validation passed`
- `OpenAPI parse check passed`

### 后端全量 TypeScript 构建

命令：

```bash
pnpm --filter @metasheet/core-backend build
```

结果：

- 未通过
- 不是类型报错
- 进程被系统直接 `SIGKILL`

补充复验：

```bash
pnpm --filter @metasheet/core-backend exec tsc --pretty false --noEmit
NODE_OPTIONS=--max-old-space-size=1024 pnpm --filter @metasheet/core-backend exec tsc --pretty false --noEmit
```

复验结果：

- 两次均被系统 `SIGKILL`

结论：

- 当前开发机上的 backend 全量 `tsc` 构建是环境性阻塞
- 本轮以“后端定向单测 + 前端 typecheck/build + OpenAPI check”为主验证依据

## 线上验证

### 部署动作

已部署到 `142.171.239.56`，执行方式：

- 同步本轮源码、OpenAPI 与文档到远端仓库
- 在 `metasheet-backend` 容器内覆盖 `packages/core-backend/src`
- 在 `metasheet-backend` 容器内执行 `pnpm --filter @metasheet/core-backend build`
- 因历史 migration 顺序已损坏，未直接跑 `migrate`
- 改为在 `metasheet-postgres` 中手工创建：
  - `directory_integrations`
  - `directory_departments`
  - `directory_accounts`
  - `directory_account_departments`
  - `directory_account_links`
  - `directory_sync_runs`
  - `directory_template_centers`
  - `directory_template_center_versions`
  - `directory_sync_alerts`
- 覆盖 `metasheet-web` 静态资源并重启 `metasheet-backend`

### 健康检查

命令：

```bash
curl -sf http://127.0.0.1:8900/health
```

结果：

- 通过
- 返回 `ok=true`

### 后端新路由挂载验证

命令：

```bash
curl -s -o /tmp/tc.out -w "%{http_code}" http://127.0.0.1:8900/api/admin/directory/integrations/dir-1/template-center
curl -s -o /tmp/ss.out -w "%{http_code}" http://127.0.0.1:8900/api/admin/directory/integrations/dir-1/schedule-status
```

结果：

- 两个接口均返回 `401`
- 响应体为 `Missing Bearer token`

说明：

- 路由已注册
- 鉴权中间件已生效

### 数据库表落地验证

命令：

```sql
select tablename
from pg_tables
where schemaname='public'
  and tablename in (
    'directory_integrations',
    'directory_sync_runs',
    'directory_template_centers',
    'directory_template_center_versions',
    'directory_sync_alerts'
  )
order by tablename;
```

结果：

- `directory_integrations`
- `directory_sync_runs`
- `directory_template_centers`
- `directory_template_center_versions`
- `directory_sync_alerts`

### 容器内 backend dist 验证

验证项：

- `/app/packages/core-backend/dist/src/directory/directory-sync.js`
- `/app/packages/core-backend/dist/src/routes/admin-directory.js`
- `directory-sync-alert` 代码片段存在

结果：

- 通过

### 前端新包命中验证

验证包：

- `index-CokZNhFS.js`
- `index-C7UJjiOl.css`

验证字符串：

- `服务端模板中心版本`
- `计划同步与告警`
- `导出治理 CSV`

结果：

- 通过

## 本轮交付文档

- `dingtalk-directory-template-center-design-20260327.md`
- `dingtalk-directory-template-center-verification-20260327.md`
- `dingtalk-directory-git-baseline-20260327.md`

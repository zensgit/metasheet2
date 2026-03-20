# Multitable Pilot Daily Triage — Day 1

## Triage Metadata

- Date: 2026-03-20
- Moderator: Claude (automated pilot)
- Teams reviewed: Team A (form/attachment/comments), Team B (import/grid/search)
- Build / branch / commit: metasheet-multitable-onprem-v2.5.0-local-20260320
- Environment: macOS (Apple Silicon) / PostgreSQL 16.9 / Node 24.10.0 / nginx 1.29.6 / PM2 6.0.14

## New Issues

### Issue 1: DATABASE_URL 需要 `?sslmode=disable`

- Title: 本地 PostgreSQL 迁移失败 — SSL 不支持
- Team: 部署
- Scenario: other (deployment)
- Severity: P2
- Blocking pilot: No（加参数后解决）
- Repro steps: 使用 env template 默认 DATABASE_URL → 执行 migrate.js
- Expected: 迁移成功
- Actual: `Error: The server does not support SSL connections`
- Owner: 待定
- Fix target: 24h（在 env template 加注释说明）

### Issue 2: bcryptjs 依赖缺失

- Title: admin bootstrap 脚本找不到 bcryptjs 模块
- Team: 部署
- Scenario: other (deployment)
- Severity: P2
- Blocking pilot: No（手动 `pnpm add -w bcryptjs` 解决）
- Repro steps: pnpm install → 执行 bootstrap-admin.sh
- Expected: admin 用户创建成功
- Actual: `Error: Cannot find module 'bcryptjs'`
- Owner: 待定
- Fix target: 24h（确保 bcryptjs 在 workspace root dependencies）

### Issue 3: pnpm add 命令会删除预构建的 apps/web/dist

- Title: pnpm add -w 导致前端 dist 被清除，应用 500
- Team: 部署
- Scenario: other (deployment)
- Severity: **P1**
- Blocking pilot: Yes（重新解压 dist 后恢复）
- Repro steps: 正常部署后 → `pnpm add -w bcryptjs` → 刷新页面
- Expected: 前端正常
- Actual: nginx 返回 500，`apps/web/dist/` 目录消失
- Owner: 待定
- Fix target: today（install 脚本需在 pnpm install 后校验 dist 完整性）

### Issue 4: CSV 导入格式不支持

- Title: Grid 导入按钮不接受 CSV 文件
- Team: Team B
- Scenario: import
- Severity: P2
- Blocking pilot: No（可手动输入数据）
- Repro steps: 打开 Grid → 点击导入 → 选择 .csv 文件
- Expected: CSV 数据填入表格
- Actual: alert "导入失败：文件格式错误"
- Owner: 待定
- Fix target: backlog（文档应说明支持的导入格式）

### Issue 5: View API 端点全部返回 500

- Title: /api/views/{viewId}/config 全部 500
- Team: Team A + Team B
- Scenario: form / other
- Severity: P2
- Blocking pilot: No（前端有 fallback 使用本地数据）
- Repro steps: 登录后访问 /api/views/form1/config、/api/views/grid1/config 等
- Expected: 返回 view 配置
- Actual: `{"success":false,"error":"Internal server error"}`
- Owner: 待定
- Fix target: 24h

### Issue 6: 表单提交失败

- Title: Form view 提交按钮返回 404
- Team: Team A
- Scenario: form
- Severity: P2
- Blocking pilot: No（表单渲染正常，只是后端提交端点缺失）
- Repro steps: 打开 /form → 填写姓名+邮箱 → 点击提交
- Expected: 提交成功
- Actual: alert "Failed to submit form"，`/api/views/form1/submit` 返回 404
- Owner: 待定
- Fix target: 24h

### Issue 7: /api/events 返回 SQL 错误

- Title: Events API column "status" does not exist
- Team: 部署
- Scenario: other
- Severity: P3
- Blocking pilot: No
- Repro steps: GET /api/events
- Expected: 返回事件列表
- Actual: `{"ok":false,"error":{"code":"QUERY_FAILED","message":"column \"status\" does not exist"}}`
- Owner: 待定
- Fix target: backlog

### Issue 8: PM2 直接重启丢失环境变量

- Title: pm2 restart 后 SECRET_NOT_FOUND 错误
- Team: 部署
- Scenario: other (deployment)
- Severity: P2
- Blocking pilot: No（必须通过 bootstrap 脚本启动）
- Repro steps: pm2 delete → pm2 start ecosystem.config.cjs（不 source env）
- Expected: 后端正常启动
- Actual: `Error: Secret not found for key: DATABASE_URL`，快速循环崩溃（16 restarts）
- Owner: 待定
- Fix target: 24h（ecosystem.config.cjs 应内置 env_file 加载或文档说明）

## Daily Decision

- P0 count: 0
- P1 count: 1 (#3 dist 被删除)
- P2 count: 6
- P3 count: 1
- Pilot should continue tomorrow: **Yes**（P1 已有 workaround）
- Hotfix required today: **Yes**
- If yes, exact fix batch: Issue #3（install 脚本加 dist 完整性校验）

## Verified Working Features

| 功能 | 前端渲染 | 后端 API | 备注 |
|------|---------|---------|------|
| 登录/认证 | ✅ | ✅ | JWT token + 会话管理 |
| Grid 表格 | ✅ | N/A（localStorage） | 30×15, 公式栏, 自动保存 |
| 电子表格 | ✅ | N/A | 页面加载正常 |
| 看板 | ✅ | 本地 fallback | 3列5卡片预置数据 |
| 日历 | ✅ | 本地 fallback | 月/周/日/列表视图 |
| 画廊 | ✅ | — | 页面加载正常 |
| 表单 | ✅ | ❌ submit 404 | 字段渲染正常 |
| 用户管理 | ✅ | ✅ | 创建/搜索/角色/会话/踢下线 |
| 角色管理 | ✅ | ✅ | 4个预置角色 |
| 权限管理 | ✅ | ✅ | RBAC 权限 |
| 管理审计 | ✅ | ✅ | 页面加载正常 |
| 插件管理 | ✅ | ✅ | plugin-attendance active |
| PLM | ✅ | ✅ | 产品搜索/BOM/文档/审批/Where-Used/对比/替代件 |
| 考勤 | ✅ | ✅ | 打卡/日历/补卡/汇总/异常/导出 |
| Health API | — | ✅ | dbPool idle=2 |
| 数据库迁移 | — | ✅ | 60+ migrations 全部成功 |

## Notes

- Repeated confusion themes: 部署文档缺少 sslmode 和 bcryptjs 说明
- Copy / UX issues worth fixing without changing contracts: Grid 导入格式提示不清晰
- Risks to watch tomorrow: dist 完整性问题需要在 install 脚本中加入校验

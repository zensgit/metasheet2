# Multitable Internal Pilot Feedback — Day 1

## Pilot Metadata

- Team / workspace: 内部自测（Claude 自动化试点）
- Pilot owner: huazhou
- Business scenario: Multitable On-Prem 全功能验证
- Branch / commit: metasheet-multitable-onprem-v2.5.0-local-20260320
- Environment: macOS 15 (Apple Silicon) / PostgreSQL 16.9 / Node 24.10.0 / nginx 1.29.6 / PM2 6.0.14
- Pilot window: 2026-03-20 ~ 2026-03-26

## Readiness Inputs

- Latest readiness gate result: N/A（首次试点）
- `readiness.md` path: N/A
- `readiness.json` path: N/A
- Smoke report path: `docs/deployment/pilot-day1-triage-20260320.md`
- Profile report path: N/A

## Core Scenario Check

| Capability | Result | Notes |
| --- | --- | --- |
| CSV import | **Fail** | alert "文件格式错误"，不接受 .csv |
| Person assignment | Not used | Grid 为纯表格模式，无人员字段 |
| Attachment upload | Not used | 未在 Grid 中找到附件入口 |
| Grid editing | **Pass** | 公式栏输入 + 自动保存正常，30×15 表格 |
| Form submit | **Fail** | 渲染正常，提交返回 404 (`/api/views/form1/submit`) |
| Link selection | Not used | — |
| Search | **Partial** | 用户管理搜索正常；Grid 无内置搜索 |
| Comment add / resolve | Not used | 未在当前视图中找到评论入口 |
| Conflict recovery | Not used | 单用户测试，未触发冲突 |

## Usability Feedback

- What worked well:
  - 登录流程顺畅，中文本地化完整
  - 看板视图预置数据体验好，3列+5卡片直观
  - 用户管理功能完整：创建用户/角色分配/会话管理/单会话踢下线
  - PLM 模块功能丰富：产品搜索/BOM/Where-Used/对比/替代件/文档/审批
  - 考勤模块完整：打卡/日历/补卡申请/汇总/异常/导出
  - Grid 自动保存 + 版本历史 + 快照功能完备

- Where users hesitated:
  - Grid 导入按钮点击后没有明确提示支持什么格式
  - 表单提交失败时的 alert 只说 "Failed to submit form"，无具体原因
  - PM2 重启后端需要先 source env 文件，文档没有明确说明

- Any wording or UI that felt unclear:
  - 导入按钮的文件格式限制不明确
  - 导航栏 "Attendance" 是英文，其他菜单项是中文（混合语言）

- Which capability felt most valuable:
  - Grid 表格 + 看板 + PLM 三者组合

- Which capability felt least ready:
  - 表单提交（后端 API 缺失）
  - CSV 导入（格式限制未说明）

## Performance Feedback

- Largest table used: 30×15（默认尺寸）
- Perceived grid open speed: 快速（<1秒）
- Perceived search speed: 用户管理搜索 < 1秒
- Any browser lag, jank, or long waits: 无明显卡顿
- Did users hit retries or refresh flows: 是 — dist 被删后 nginx 500，需重新解压恢复

## Bugs And Repro

### Bug 1

1. Title: pnpm add -w 导致预构建 dist 消失
2. Severity: P1
3. Steps to reproduce: 部署完成后执行 `pnpm add -w bcryptjs` → 刷新页面
4. Expected: 前端继续正常显示
5. Actual: nginx 500，`apps/web/dist/` 目录被 pnpm workspace 清理
6. Screenshot / artifact path: N/A
7. Blocking pilot rollout: Yes（已有 workaround：先备份 dist 再装依赖）

### Bug 2

1. Title: DATABASE_URL 缺少 sslmode=disable 说明
2. Severity: P2
3. Steps to reproduce: 使用默认 env template → 执行 migrate.js
4. Expected: 迁移成功
5. Actual: `Error: The server does not support SSL connections`
6. Screenshot / artifact path: N/A
7. Blocking pilot rollout: No

### Bug 3

1. Title: bcryptjs 不在打包依赖中
2. Severity: P2
3. Steps to reproduce: pnpm install --frozen-lockfile → 执行 bootstrap-admin.sh
4. Expected: admin 用户创建成功
5. Actual: `Error: Cannot find module 'bcryptjs'`
6. Screenshot / artifact path: N/A
7. Blocking pilot rollout: No

### Bug 4

1. Title: CSV 导入报格式错误
2. Severity: P2
3. Steps to reproduce: Grid → 导入 → 选择 .csv 文件
4. Expected: 数据导入
5. Actual: alert "导入失败：文件格式错误"
6. Screenshot / artifact path: N/A
7. Blocking pilot rollout: No

### Bug 5

1. Title: View API 全部返回 500
2. Severity: P2
3. Steps to reproduce: GET /api/views/form1/config (或 grid1/kanban1/calendar1/gallery1)
4. Expected: 返回 view 配置 JSON
5. Actual: `{"success":false,"error":"Internal server error"}`
6. Screenshot / artifact path: N/A
7. Blocking pilot rollout: No（前端有 localStorage fallback）

### Bug 6

1. Title: 表单提交 API 不存在
2. Severity: P2
3. Steps to reproduce: /form → 填写 → 点击提交
4. Expected: 提交成功
5. Actual: `/api/views/form1/submit` 返回 404
6. Screenshot / artifact path: N/A
7. Blocking pilot rollout: No

### Bug 7

1. Title: PM2 直接启动不加载 env 文件
2. Severity: P2
3. Steps to reproduce: pm2 delete → pm2 start ecosystem.config.cjs（不 source env）
4. Expected: 后端启动
5. Actual: `Error: Secret not found for key: DATABASE_URL`，循环崩溃
6. Screenshot / artifact path: N/A
7. Blocking pilot rollout: No

### Bug 8

1. Title: /api/events SQL 列缺失
2. Severity: P3
3. Steps to reproduce: GET /api/events
4. Expected: 事件列表
5. Actual: `column "status" does not exist`
6. Screenshot / artifact path: N/A
7. Blocking pilot rollout: No

## Rollout Decision

- Ready to continue pilot: **Yes**
- If no, top blockers: N/A
- Suggested next fix batch:
  1. [P1] install 脚本加 dist 完整性校验（或 bcryptjs 打入 workspace root deps 避免额外 pnpm add）
  2. [P2] env template 加 `?sslmode=disable` 注释
  3. [P2] ecosystem.config.cjs 加 dotenv 加载或文档说明必须通过 bootstrap 脚本启动
  4. [P2] 文档说明 Grid 导入支持的文件格式
- Suggested follow-up team or scenario: Day 2-3 多用户协作测试 + 大数据量导入

## Sign-off

- Pilot owner: huazhou
- Product / engineering reviewer: _待签_
- Decision date: 2026-03-20

# Attendance On-Prem `v2.5.0-run9` 缺陷修复说明（2026-03-12）

适用范围：针对部署团队反馈的 run9 缺陷（无登录入口、模式初始化、401 处理、文档补充）给出的修复说明与验收步骤。

## 缺陷与修复映射

| 缺陷ID | 状态 | 修复内容 | 代码位置 |
| --- | --- | --- | --- |
| BUG-001 前端无登录页面 | ✅ 已修复 | 新增 `/login` 登录页与表单提交流程，支持 token 写入和登录后跳转 | `apps/web/src/views/LoginView.vue` |
| BUG-002 `metasheet_product_mode` 未自动初始化 | ✅ 已修复 | 登录后自动调用 `/api/auth/me` 拉取 `features.mode`，并写入本地缓存；路由守卫优先依赖后端能力模型 | `apps/web/src/views/LoginView.vue`, `apps/web/src/main.ts`, `apps/web/src/stores/featureFlags.ts` |
| BUG-003 401 无全局拦截 | ✅ 已修复 | `apiFetch` 增加 401 统一处理：清理认证状态并重定向 `/login?redirect=...` | `apps/web/src/utils/api.ts` |
| BUG-004 Grid 未登录 alert 轰炸 | ✅ 已修复 | 路由改为默认需要登录；未登录不能进入 Grid，从入口阻断 401 循环触发 | `apps/web/src/main.ts` |
| BUG-005 缺少 Windows 原生部署文档 | ✅ 已有并补充索引 | 现有 `docs/deployment/attendance-windows-onprem-no-docker-20260306.md`、`attendance-windows-onprem-easy-start-20260306.md` 可直接用于 Windows/WSL 场景 | `docs/deployment/*.md` |
| BUG-006 `VITE_API_URL` 文档缺失 | ✅ 已修复 | 明确前端 API 地址解析链：`VITE_API_URL -> VITE_API_BASE -> window.location.origin -> http://localhost:8900` | `apps/web/src/utils/api.ts`, 本文“配置说明” |

## 配置说明（前端 API 地址）

前端运行时 API 基地址解析顺序：

1. `VITE_API_URL`
2. `VITE_API_BASE`
3. `window.location.origin`
4. `http://localhost:8900`

建议：

- 同域反向代理部署：不必设置 `VITE_API_URL`，保持默认同域。
- 前后端分离域名部署：构建前设置 `VITE_API_URL=https://<api-domain>`。

## 验证记录（本地）

在当前修复分支工作区执行：

```bash
pnpm --filter @metasheet/web exec vitest run tests/utils/api.test.ts
pnpm --filter @metasheet/web build
```

预期：

- 单测通过（包含 401 重定向与 token 清理逻辑）。
- 前端构建成功（可产出 `apps/web/dist`）。

## 上线后现场验收清单

1. 首次访问 `http://<host>/login` 显示登录页。
2. 输入管理员账号后可跳转到 `/attendance`。
3. 删除或篡改 token 后刷新任意业务页，应自动回到 `/login`。
4. 未登录访问 `/grid`、`/plm` 等页面，应被重定向到登录页。
5. `PRODUCT_MODE=attendance` 时，登录后默认落地考勤页面。

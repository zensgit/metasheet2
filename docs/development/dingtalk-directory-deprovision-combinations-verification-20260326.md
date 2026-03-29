# 钉钉目录离职策略组合化验证

## 本地验证

已通过：

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/directory-sync.test.ts tests/unit/admin-directory-routes.test.ts`
- `pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/web exec vue-tsc --noEmit`
- `pnpm --filter @metasheet/web build`
- `node scripts/openapi-check.mjs`

## 覆盖点

### 后端

- 旧单值策略可继续解析
- 组合策略会序列化为 JSON 数组字符串写回旧 `text` 字段
- 组合策略会按集合执行停权和停用
- 成员级策略接口接受数组并返回数组
- CSV 导出可输出组合策略

### 前端

- 默认离职策略支持多选
- 成员级覆盖支持多选
- 成员级覆盖支持“沿用集成默认策略”
- 默认策略与成员覆盖都支持一键预设
- 页面可正确渲染数组策略标签
- 保存时会提交数组 payload

### 入口回归

- `attendance` 模式下管理员目录入口继续可用
- 非管理员仍应被拦截

## 待现网验证

## 现网验证

已在 `142.171.239.56` 完成部署与回归：

1. `backend` 镜像：`ghcr.io/local/metasheet2-backend:deprovision-combo-20260326`
2. `web` 镜像：`ghcr.io/local/metasheet2-web:deprovision-combo-20260326`
3. `/health` 返回 `ok=true`
4. 管理员调用 `/api/admin/directory/integrations` 成功，接口已返回数组：
   - `defaultDeprovisionPolicy: ["mark_inactive"]`
5. 普通用户调用 `/api/admin/directory/integrations` 被正确拒绝：
   - `HTTP 403`
   - `FORBIDDEN`
6. 浏览器现网验证：
   - 管理员访问 `/admin/directory`，页面标题为 `Directory Sync - MetaSheet`
   - 页面已显示三项可组合离职策略复选框
   - 普通用户访问 `/admin/directory`，不会进入目录页，实际被前端门控重定向到 `/grid`

## 备注

普通用户现网表现是“被前端门控重定向到首页工作区”，而不是停留在 `403` 页面；后端接口层仍然返回 `403`。这说明“不能访问目录管理”目标已满足。

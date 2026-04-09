# 平台用户组与委派范围验证

日期：2026-04-09  
分支：`codex/dingtalk-pr3-attendance-notify-20260408`

## 验证命令

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-users-routes.test.ts
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web type-check
```

## 验证结果

### 后端单测

命令：

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-users-routes.test.ts
```

结果：

- `44/44` 通过

覆盖到的新场景：

1. 创建平台用户组
2. 给成员加入平台用户组
3. 给插件管理员分配成员组范围
4. 模板复制成员组范围
5. 插件管理员仅凭成员组范围也可对命中成员委派角色

### 后端构建

命令：

```bash
pnpm --filter @metasheet/core-backend build
```

结果：

- 通过

### 前端类型检查

命令：

```bash
pnpm --filter @metasheet/web type-check
```

结果：

- 通过

## 手工检查点

建议后续在 staging 做这几项人工验证：

1. 平台管理员创建平台用户组
2. 将某成员加入平台用户组
3. 将某 `xxx_admin` 成员授权到该用户组范围
4. 用该 `xxx_admin` 账号登录角色委派页，确认只能操作命中该组的成员
5. 创建模板并同时挂部门与成员组，再覆盖应用到另一个插件管理员

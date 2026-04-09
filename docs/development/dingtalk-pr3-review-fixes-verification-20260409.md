# DingTalk PR3 审查修复验证

日期：2026-04-09  
分支：`codex/dingtalk-pr3-attendance-notify-20260408`

## 验证命令

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/notification-service-dingtalk.test.ts
pnpm --filter @metasheet/web exec vitest run tests/roleDelegationView.spec.ts --watch=false
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web type-check
```

## 验证结果

### 后端单测

命令：

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/notification-service-dingtalk.test.ts
```

结果：

- `4/4` 通过

覆盖新增场景：

1. `HTTP 200 + errcode = 0` 正常发送
2. `HTTP 200 + errcode != 0` 记为失败
3. `HTTP 400` 非重试失败仍只请求一次

### 前端视图测试

命令：

```bash
pnpm --filter @metasheet/web exec vitest run tests/roleDelegationView.spec.ts --watch=false
```

结果：

- `3/3` 通过

覆盖新增场景：

1. 搜索成员组后清空失效选择
2. 搜索模板后清空失效选择
3. 搜索成员后清空失效选择

### 构建与类型检查

命令：

```bash
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web type-check
```

结果：

- 全部通过

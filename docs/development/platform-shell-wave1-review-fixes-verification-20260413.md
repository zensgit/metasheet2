# Platform Shell Wave 1 Review Fixes Verification

日期：2026-04-13

## 范围

本次验证只覆盖 PR #852 review fix 增量：

- registry JSON 防御解析
- registry 时间戳 `Date -> ISO string` 映射
- `fetchAppById()` 请求去重与共享 loading/error 状态
- `platform-apps` tenant 解析收紧
- app manifest cache
- launcher action 预计算

## 执行命令

### Backend

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/platform-app-instance-registry.test.ts
pnpm --filter @metasheet/core-backend exec vitest run tests/platform-app-registry.test.ts tests/unit/platform-apps-router.test.ts
```

结果：

- `3` 个测试文件通过
- `12` 个测试通过

### Frontend

```bash
pnpm --filter @metasheet/web exec vitest run tests/usePlatformApps.spec.ts
```

结果：

- `1` 个测试文件通过
- `2` 个测试通过

### PR 定向回归

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/platform-app-registry.test.ts tests/platform-app-instance-registry.test.ts tests/unit/platform-apps-router.test.ts tests/unit/after-sales-plugin-routes.test.ts
pnpm --filter @metasheet/web exec vitest run tests/usePlatformApps.spec.ts tests/platform-app-actions.spec.ts tests/platform-app-shell.spec.ts
```

结果：

- Backend:
  - `4` 个测试文件通过
  - `126` 个测试通过
- Frontend:
  - `3` 个测试文件通过
  - `11` 个测试通过

### Build

```bash
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
```

结果：

- Backend build 通过
- Frontend build 通过

## 断言点

### Backend

- 非法 JSON 字符串不会让 `getPlatformAppInstance()` 抛未捕获异常
- 损坏 JSON 会回退成 `{}``
- `Date` 类型的 `created_at/updated_at` 能被稳定映射为 ISO 字符串
- 缺少认证 tenant 上下文时，`platform-apps` 不再信任裸 header 读取实例
- 同一 loaded plugin 的 manifest 在重复采集时只读盘一次

### Frontend

- 同一个 `appId` 的并发 `fetchAppById()` 只会触发一次 `apiGet`
- 发起单 app 请求前会清理旧错误状态
- 请求进行中 `loading` 为 `true`
- 请求结束后 `loading` 回落为 `false`
- 两次并发调用都能拿到同一个 app 结果，并写回共享缓存
- launcher 模板改动未引入编译回退，前端 build 通过

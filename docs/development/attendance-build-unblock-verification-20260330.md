# Attendance Build Unblock Verification

日期：2026-03-30

## 变更范围

本轮只收口 Attendance 构建基线：

- [timezones.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/utils/timezones.ts)
- [timezones.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/timezones.spec.ts)

未触碰 Attendance 业务流程、导入逻辑或后端接口。

## 本地验证

### 1. 时区工具单测

```bash
pnpm --filter @metasheet/web exec vitest run tests/timezones.spec.ts
```

结果：

- `1` file passed
- `3` tests passed

### 2. 前端生产构建

```bash
pnpm --filter @metasheet/web build
```

结果：通过。

产物摘要：

- `dist/assets/index-B992PqLp.js`
- `dist/assets/index-BZq9hmuE.css`

Vite 仍提示大 chunk 警告，但这是性能提醒，不是构建失败。

## 结论

`AttendanceView.vue -> ../utils/timezones` 的构建阻塞已经解除，并且不再只是“补文件”状态，而是具备：

- 明确工具入口
- 无效时区容错
- 单测覆盖
- 构建级验证

这条 `attendance-build-unblock` 线可视为通过。

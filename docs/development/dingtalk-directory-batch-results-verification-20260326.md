# 钉钉目录批量处理结果验证

日期：2026-03-26

## 变更范围

- 批量操作后新增“本次批量处理结果”卡片
- 支持展示总数、成功数、失败数
- 支持展示失败成员名与失败原因

## 本地验证

执行命令：

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts
pnpm --filter @metasheet/web build
```

结果：

- `vue-tsc --noEmit` 通过
- `directoryManagementView.spec.ts` 共 `23` 项通过
- `web build` 通过

## 关键回归点

1. 批量忽略仍能正常执行
2. 批量开通并授权仍能正常执行
3. 按邮箱批量关联仍能正常执行
4. 批量邮箱关联出现“部分成功、部分失败”时：
   - 页面出现“本次批量处理结果”
   - 显示 `共 2 项，成功 1 项，失败 1 项`
   - 显示失败成员名
   - 显示失败原因
5. 失败清单支持：
   - 复制到剪贴板
   - 导出为 CSV

## 预期上线验证

上线后管理员执行任一批量动作，应能在目录管理页直接看到：

- 最近一次批量操作名称
- 成功/失败统计
- 失败成员与失败原因
- 可直接复制失败清单
- 可直接导出失败 CSV

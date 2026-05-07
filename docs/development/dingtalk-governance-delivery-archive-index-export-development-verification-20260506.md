# DingTalk 治理工作台交付归档包索引导出

## 开发目标

- 补齐最后一份面向归档和复盘的索引文档。
- 把日报、联调包、142 验收、试运行说明、正式交付结论串成一套统一归档入口。
- 让交付后复盘或二次排障时，不需要再手工回忆“当天到底导出了哪些文件”。

## 实现说明

- 在 [UserManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/UserManagementView.vue) 新增 `导出交付归档包索引` 按钮。
- 新增 `exportGovernanceDeliveryArchiveIndex()`，导出内容包含：
  - 归档目的
  - 归档文件清单
  - 建议归档顺序
  - 配套证据
  - 当前基线
  - 关键入口
  - 当前建议

## 验证

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts tests/directoryManagementView.spec.ts --watch=false
git diff --check
```

## 预期结果

- 用户治理工作台可直接导出交付归档包索引 Markdown。
- `userManagementView.spec.ts` 覆盖新增按钮和关键归档字段。
- 目录治理测试不受影响，`git diff --check` 通过。

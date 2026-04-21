# 成员组下游 ACL 联动验证说明 2026-04-19

## 验证范围

- 仍保留原有：
  - field ACL 从一个成员组复制到另一个成员组
  - view ACL 从一个成员组复制到另一个成员组
- 新增：
  - `Sheet Access` 下可一次复制完整 downstream ACL
  - 包括 field + view 两类 override
  - 同步过程中会清理目标成员组多余的旧 override
- 前端构建通过

## 执行命令

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-sheet-permission-manager.spec.ts \
  tests/multitable-record-permission-manager.spec.ts \
  --watch=false

pnpm --filter @metasheet/web build
```

## 结果

### 前端测试

- `2 files passed`
- `23 tests passed`

新增覆盖点：

- 从 `Sheet Access` 直接复制成员组完整 downstream ACL：
  - 复制 field override
  - 复制 view override
  - 清理目标成员组多余旧 override

### 构建

- `pnpm --filter @metasheet/web build`：通过

## 备注

- 构建仍会打印既有 Vite dynamic-import / chunk-size warning
- 以上不影响本轮结论

## 部署内容

- 本轮没有远端部署
- 本轮没有数据库迁移

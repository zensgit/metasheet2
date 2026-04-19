# 成员组 ACL 模板联动验证说明 2026-04-19

## 验证范围

- field ACL 可从一个成员组复制到另一个成员组
- view ACL 可从一个成员组复制到另一个成员组
- 复制过程中会清理目标成员组多余的旧 override
- 前端构建通过

## 执行命令

```bash
pnpm install --frozen-lockfile

pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-sheet-permission-manager.spec.ts \
  tests/multitable-record-permission-manager.spec.ts \
  --watch=false

pnpm --filter @metasheet/web build
```

## 结果

### 前端测试

- `2 files passed`
- `22 tests passed`

新增覆盖点：

- field 模板复制：
  - 从源成员组复制 override 到目标成员组
  - 清理目标成员组旧的多余 field override
- view 模板复制：
  - 从源成员组复制 override 到目标成员组
  - 清理目标成员组旧的多余 view override

### 构建

- `pnpm --filter @metasheet/web build`：通过

## 备注

- 构建仍会打印既有 Vite dynamic-import / chunk-size warning
- 以上不影响本轮结论

## 部署内容

- 本轮没有远端部署
- 本轮没有数据库迁移

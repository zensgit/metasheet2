# 本地环境修复指南（pnpm monorepo 精准版）

## 问题描述
集成测试失败通常与本地依赖、鉴权或路径配置有关（非功能性问题）。

## 推荐修复步骤（不破坏锁文件）

### 1) 清理受影响包并严格安装
```bash
pnpm store prune
rm -rf packages/core-backend/node_modules
pnpm install --frozen-lockfile
```

### 2) 按包安装缺失依赖（仅当必要时）
```bash
# 运行时依赖（安装到后端包）
pnpm -F @metasheet/core-backend add winston prom-client pg

# 测试依赖（devDependencies）
pnpm -F @metasheet/core-backend add -D vitest @vitest/ui socket.io-client @types/node
```

### 3) 运行测试（建议在 test 环境）
```bash
pnpm -F @metasheet/core-backend test
NODE_ENV=test pnpm -F @metasheet/core-backend test:integration
```

### 4) 401 与鉴权问题
- 测试默认在 `NODE_ENV=test` 放宽鉴权；若本地仍 401：
  - 以 `NODE_ENV=test` 运行，或
  - 为测试请求添加 `Authorization: Bearer test`，或
  - 确认 `/api/*` 白名单配置与 CI 一致。

## 一键修复脚本（可选）
```bash
bash scripts/fix-local-core-backend.sh
```
脚本会执行：store 清理 → 后端包 node_modules 清理 → 冻结安装 → 运行单测与集成测试。

## 结果期望
- 集成测试应全部通过（CI 对应环境为绿）。
- 若本地仍失败，多因环境差异；建议在全新 shell/干净 node 版本下重试。

## 避免复发的建议
- 使用 `pnpm install --frozen-lockfile` 固定依赖。
- 仅在对应包使用 `pnpm -F <pkg> add/remove` 管理依赖。
- 提交前例行运行：`pnpm -F @metasheet/core-backend test && test:integration`。

## 附注
PR #89 的修复（结构化日志、优雅关闭、事件时序）已在 CI 和主分支验证通过；若本地有差异，请优先按上述步骤修复环境。

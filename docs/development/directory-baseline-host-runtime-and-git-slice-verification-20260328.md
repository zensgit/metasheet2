# Directory Baseline Host Runtime And Git Slice Verification

日期：2026-03-28

## 变更范围

- `package.json`
- `scripts/ops/git-slice-report.mjs`
- `docs/development/directory-baseline-host-runtime-and-git-slice-design-20260328.md`
- `docs/development/directory-baseline-host-runtime-and-git-slice-verification-20260328.md`
- `docs/development/dingtalk-directory-git-baseline-20260327.md`
- `docs/development/directory-migration-baseline-git-slice-20260328.md`
- `docs/development/directory-migration-baseline-hardening-verification-20260327.md`

## 本地验证

### 1. Git slice 报告

命令：

```bash
node scripts/ops/git-slice-report.mjs --slice directory-migration-baseline
node scripts/ops/git-slice-report.mjs --slice directory-migration-baseline --json
node scripts/ops/git-slice-report.mjs --slice directory-migration-baseline --stage-command
node scripts/ops/git-slice-report.mjs --list-slices
```

结果：

- 均通过
- 已输出：
  - 切片统计
  - bucket 分布
  - stage command
  - 建议提交顺序

### 2. 根脚本入口

命令：

```bash
pnpm verify:git-slice:directory-migration-baseline
pnpm print:git-slice:directory-migration-baseline
pnpm print:git-slice:directory-migration-baseline:stage
```

结果：

- 均通过
- `verify:git-slice:directory-migration-baseline` 返回切片 JSON
- stage 命令可直接生成

### 3. 既有 Git baseline 复核

命令：

```bash
git fetch origin --prune
node scripts/ops/git-baseline-report.mjs
```

结果：

- 当前仍是：
  - `ahead 3 / behind 4`
  - `dirty 263`
- 结论仍是“不能宣称已同步到 GitHub”

## 远端验证

目标环境：`142.171.239.56`

### 4. 宿主机源码目录 ownership

验证结果：

- `/home/mainuser/metasheet2/packages/core-backend`
- `/home/mainuser/metasheet2/packages/core-backend/src`
- `/home/mainuser/metasheet2/packages/core-backend/src/db`
- `/home/mainuser/metasheet2/packages/core-backend/src/db/migrations`

均为：

```text
mainuser mainuser
```

### 5. 宿主机用户态 Node / pnpm

执行结果：

- `node -> v20.20.2`
- `pnpm -> 10.33.0`
- `corepack -> 0.34.6`
- 已落到：
  - `~/.local/lib/node-v20.20.2-linux-x64`
  - `~/.local/lib/node-current`
  - `~/.local/bin/node`
  - `~/.local/bin/pnpm`
  - `~/.local/bin/corepack`
- 仓库脚本 `scripts/ops/install-user-node-runtime.sh` 已同步到远端并实际执行通过

### 6. 宿主机关键源码同步

验证结果：

- 以下文件已同步到正确相对路径：
  - `packages/core-backend/src/db/migrate.ts`
  - `packages/core-backend/src/db/migration-audit.ts`
  - `packages/core-backend/src/db/migration-health.ts`
  - `scripts/ops/git-slice-report.mjs`
  - `scripts/ops/install-user-node-runtime.sh`
  - `scripts/ops/git-baseline-report.mjs`
  - `docs/development/dingtalk-directory-git-baseline-20260327.md`
- 同时确认误同步到仓库根目录的平铺文件已清理

### 7. 远端运行边界复核

验证结果：

- 宿主机 shell 现在已可直接执行 `node` / `pnpm`
- 但 `/home/mainuser/metasheet2` 仍不是 Git 仓库
- 因此：
  - `node scripts/ops/git-baseline-report.mjs --json`
  - `node scripts/ops/git-slice-report.mjs --slice directory-migration-baseline --json`
  现在都会返回结构化错误：

```json
{
  "error": "NOT_A_GIT_REPOSITORY",
  "message": "Current working directory is not a Git working tree."
}
```

- 容器内仍可稳定执行：
  - `node --import tsx /app/packages/core-backend/src/db/migrate.ts --audit --json`

结论：

- 宿主机运行时问题已修复
- Git 脚本在宿主机部署目录里的限制，来自“目录不是 Git clone”，不是来自 Node / pnpm 缺失

## 结论

本轮完成了两项工程收口：

1. 把 migration 基线切片从文档推进成可执行脚本和根命令入口
2. 把 `142.171.239.56` 的宿主机关键源码路径修回可维护状态，并消除了错误平铺同步
3. 给 `mainuser` 安装了用户态 Node / pnpm，并把“非 Git 目录友好失败”补到 Git 基线脚本

但当前 Git 基线仍未收口，后续仍需：

1. 依据切片文档和切片脚本整理 commit
2. 处理当前分支 `behind 4`
3. 再做 GitHub push / PR

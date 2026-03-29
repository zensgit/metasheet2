# Directory Baseline Git Bundle Verification

日期：2026-03-28

## 变更范围

- `package.json`
- `scripts/ops/git-slices.mjs`
- `scripts/ops/git-slice-apply.mjs`
- `scripts/ops/git-slice-bundle.mjs`
- `docs/development/directory-baseline-git-apply-design-20260328.md`
- `docs/development/directory-baseline-git-apply-verification-20260328.md`
- `docs/development/directory-baseline-git-bundle-design-20260328.md`
- `docs/development/directory-baseline-git-bundle-verification-20260328.md`
- `docs/development/directory-migration-baseline-git-slice-20260328.md`
- `docs/development/dingtalk-directory-git-baseline-20260327.md`

## 本地验证

### 1. bundle 正常路径

命令：

```bash
node scripts/ops/git-slice-bundle.mjs --list-slices
node scripts/ops/git-slice-bundle.mjs --slice directory-migration-baseline
node scripts/ops/git-slice-bundle.mjs --slice directory-migration-baseline --json
node scripts/ops/git-slice-bundle.mjs --slice directory-migration-baseline --stage-command
node scripts/ops/git-slice-bundle.mjs --slice directory-migration-baseline --group ops-baseline-tooling --stage-command
```

结果：

- 通过
- 当前 slice bundle 统计：
  - `filesCount=33`
  - `coverage.complete=true`
  - `groups=5`
- 当前每组状态：
  - `core-backend-migration-cli files=5`
  - `directory-iam-migrations files=6`
  - `ops-baseline-tooling files=8`
  - `migration-audit-tests files=2`
  - `migration-baseline-docs files=12`

### 2. bundle verify

命令：

```bash
pnpm verify:git-slice-bundle:directory-migration-baseline
```

结果：

- 通过
- 当前没有重复归组
- 当前没有未覆盖文件
- 当前没有 slice 外额外文件
- 当前 group 内没有缺失文件

### 3. manifest 与 patch 导出

命令：

```bash
node scripts/ops/git-slice-bundle.mjs \
  --slice directory-migration-baseline \
  --write-manifest output/git-slice-bundles/directory-migration-baseline/manual-manifest.json \
  --export-dir output/git-slice-bundles/directory-migration-baseline \
  --json
```

结果：

- 通过
- 已生成：
  - `output/git-slice-bundles/directory-migration-baseline/manifest.json`
  - `output/git-slice-bundles/directory-migration-baseline/core-backend-migration-cli.patch`
  - `output/git-slice-bundles/directory-migration-baseline/directory-iam-migrations.patch`
  - `output/git-slice-bundles/directory-migration-baseline/ops-baseline-tooling.patch`
  - `output/git-slice-bundles/directory-migration-baseline/migration-audit-tests.patch`
  - `output/git-slice-bundles/directory-migration-baseline/migration-baseline-docs.patch`
- patch 允许为空或非空；空 patch 不视为脚本失败，重点是交付分组边界和 manifest

### 4. 非 Git 目录友好失败

命令：

```bash
cd /tmp/metasheet-nongit-check
node /Users/huazhou/Downloads/Github/metasheet2/scripts/ops/git-slice-bundle.mjs --slice directory-migration-baseline --json
```

结果：

- 返回结构化：
  - `error=NOT_A_GIT_REPOSITORY`
  - `message=Current working directory is not a Git working tree.`
- 退出码：`2`

## 远端验证

目标环境：`mainuser@142.171.239.56`

### 5. 宿主机运行时

结果：

- `node -> /home/mainuser/.local/bin/node`
- `node -v -> v20.20.2`
- `pnpm -> /home/mainuser/.local/bin/pnpm`
- `pnpm -v -> 10.33.0`

### 6. 宿主机 bundle 工具行为

命令：

```bash
cd /home/mainuser/metasheet2
node scripts/ops/git-slice-bundle.mjs --slice directory-migration-baseline --json
```

结果：

- 返回结构化 `NOT_A_GIT_REPOSITORY`
- 退出码：`2`
- 说明宿主机现在已经具备执行 Git 基线工具的运行时，剩余边界只是不在 Git clone 内

## 结论

本轮把 migration baseline slice 从“可分析、可判定 upstream 风险”继续推进到“可提交 bundle”：

1. 有正式 commit groups
2. 有每组 stage command
3. 有整体 manifest
4. 有每组 patch 导出
5. 有覆盖完整性校验

这意味着后续真正做 GitHub 收口时，不必再从 200+ dirty 文件里手工挑文件，而是可以直接按 bundle 定义去 stage 和拆提交。 

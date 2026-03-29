# Directory Baseline Git Apply Verification

日期：2026-03-28

## 变更范围

- `package.json`
- `scripts/ops/git-slices.mjs`
- `scripts/ops/git-slice-apply.mjs`
- `docs/development/directory-baseline-git-apply-design-20260328.md`
- `docs/development/directory-baseline-git-apply-verification-20260328.md`
- `docs/development/directory-baseline-git-bundle-verification-20260328.md`
- `docs/development/directory-baseline-git-sync-plan-verification-20260328.md`
- `docs/development/directory-migration-baseline-git-slice-20260328.md`
- `docs/development/dingtalk-directory-git-baseline-20260327.md`

## 本地验证

### 1. apply 正常路径

命令：

```bash
node scripts/ops/git-slice-apply.mjs --list-slices
node scripts/ops/git-slice-apply.mjs --slice directory-migration-baseline --list-groups
node scripts/ops/git-slice-apply.mjs --slice directory-migration-baseline
node scripts/ops/git-slice-apply.mjs --slice directory-migration-baseline --json
node scripts/ops/git-slice-apply.mjs --slice directory-migration-baseline --group ops-baseline-tooling --json
pnpm print:git-slice-apply:directory-migration-baseline:groups
```

结果：

- 通过
- 当前 `selectedGroupsCount=5`
- 当前 `applyMode=alternate-index-dry-run`
- 当前 `verifyPassed=true`
- 当前 group 分布：
  - `core-backend-migration-cli stagedFiles=5`
  - `directory-iam-migrations stagedFiles=6`
  - `ops-baseline-tooling stagedFiles=8`
  - `migration-audit-tests stagedFiles=2`
  - `migration-baseline-docs stagedFiles=12`

### 2. apply verify

命令：

```bash
pnpm verify:git-slice-apply:directory-migration-baseline
node scripts/ops/git-slice-apply.mjs --slice directory-migration-baseline --verify --json
```

结果：

- 通过
- 说明当前 5 个 commit group 都能在 alternate index 中被真实 stage
- 当前每组都返回：
  - `hasStagedChanges=true`
  - `patchEmpty=false`
  - `treeHash`
  - `stageCommand`

### 3. apply 导出产物

命令：

```bash
node scripts/ops/git-slice-apply.mjs \
  --slice directory-migration-baseline \
  --export-dir output/git-slice-applies/directory-migration-baseline \
  --json
pnpm export:git-slice-apply:directory-migration-baseline
```

结果：

- 通过
- 已生成：
  - `output/git-slice-applies/directory-migration-baseline/apply-manifest.json`
  - `output/git-slice-applies/directory-migration-baseline/core-backend-migration-cli.staged.patch`
  - `output/git-slice-applies/directory-migration-baseline/directory-iam-migrations.staged.patch`
  - `output/git-slice-applies/directory-migration-baseline/ops-baseline-tooling.staged.patch`
  - `output/git-slice-applies/directory-migration-baseline/migration-audit-tests.staged.patch`
  - `output/git-slice-applies/directory-migration-baseline/migration-baseline-docs.staged.patch`

### 4. 持久 alternate index

命令：

```bash
node scripts/ops/git-slice-apply.mjs \
  --slice directory-migration-baseline \
  --group ops-baseline-tooling \
  --apply \
  --index-file output/git-slice-applies/persisted/ops.index \
  --json
```

结果：

- 通过
- 返回：
  - `selectedGroupsCount=1`
  - `applyMode=alternate-index-persisted`
  - `groups[0].indexFile=.../output/git-slice-applies/persisted/ops.index`
- 说明当前工具已经支持把单个 commit group 持久写入 alternate index，而不触碰 live repo index

### 5. 安全门禁

命令：

```bash
node scripts/ops/git-slice-apply.mjs --slice directory-migration-baseline --use-current-index --json
node scripts/ops/git-slice-apply.mjs --slice directory-migration-baseline --apply --use-current-index --json
```

结果：

- 第一条返回：
  - `error=CURRENT_INDEX_REQUIRES_APPLY`
- 第二条返回：
  - `error=CURRENT_INDEX_REQUIRES_GROUP`
- 说明直接写入当前 index 的危险路径仍被显式拦住

### 6. 非 Git 目录友好失败

命令：

```bash
mkdir -p /tmp/metasheet-nongit-check
cd /tmp/metasheet-nongit-check
node /Users/huazhou/Downloads/Github/metasheet2/scripts/ops/git-slice-apply.mjs --slice directory-migration-baseline --json
```

结果：

- 返回结构化：
  - `error=NOT_A_GIT_REPOSITORY`
  - `message=Current working directory is not a Git working tree.`
- 退出码：`2`

### 7. 缺失文件边界

命令：

```bash
tmpdir=$(mktemp -d /tmp/git-apply-missing-XXXXXX)
cp scripts/ops/git-slice-apply.mjs "$tmpdir/git-slice-apply.mjs"
cat > "$tmpdir/git-slices.mjs" <<'EOF'
export const SLICES = {
  'missing-check': {
    description: 'missing file check',
    commitGroups: [
      {
        id: 'docs',
        message: 'docs: missing',
        files: ['package.json', 'docs/development/__missing_apply_probe__.md'],
      },
    ],
  },
}
EOF
node "$tmpdir/git-slice-apply.mjs" --slice missing-check --verify --json
```

结果：

- 返回结构化：
  - `error=MISSING_GROUP_FILES`
  - `message=Commit group docs contains missing files: docs/development/__missing_apply_probe__.md`
- 退出码：`1`
- 说明缺失文件现在会在脚本层直接被识别，而不是回落到 Git 的原始 `pathspec` 报错

## 远端验证状态

目标环境：`mainuser@142.171.239.56`

### 8. 本轮远端同步与验证

命令：

```bash
rsync -azR ... mainuser@142.171.239.56:/home/mainuser/metasheet2/
ssh -o BatchMode=yes mainuser@142.171.239.56 true
```

结果：

- 本轮阻塞
- 当前返回：
  - `Permission denied (publickey,password)`
- 这说明本轮不是 `git-slice-apply` 工具逻辑失败，而是 `mainuser@142.171.239.56` 的 SSH 认证已经失效

### 9. 当前可确认的远端前提

基于上一轮已完成验证，仍可确认：

- `mainuser` 宿主机登录 shell 已具备用户态 `node / pnpm / corepack`
- 宿主机部署目录不是 Git clone 时，现有 baseline 工具会友好返回 `NOT_A_GIT_REPOSITORY`

但 `git-slice-apply` 这轮新增脚本尚未在远端宿主机重新实测，需要等 SSH 认证恢复后补跑。

## 结论

本轮把 migration baseline 这条线从“可定义 commit groups、可导出 patch”推进到了“可安全预演 stage”：

1. 默认 alternate index，不污染当前真实 index
2. 支持按 group 单独验证
3. 可对单个 group 持久写入 alternate index
4. 危险的 current-index 写入路径被显式门禁拦住
5. 可导出 staged patch 与 apply manifest
6. 远端宿主机这轮被 SSH 认证阻塞，需恢复 `mainuser` 登录后再补最后一跳

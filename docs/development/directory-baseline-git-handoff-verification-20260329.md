# Directory Baseline Git Handoff Verification

日期：2026-03-29

## 变更范围

- `scripts/ops/git-slice-handoff.mjs`
- `scripts/ops/handoff-remote-git-slice.sh`
- `scripts/ops/git-slices.mjs`
- `package.json`
- `docs/development/directory-baseline-git-handoff-design-20260329.md`
- `docs/development/directory-baseline-git-handoff-verification-20260329.md`
- `docs/development/remote-git-slice-handoff-design-20260329.md`
- `docs/development/remote-git-slice-handoff-verification-20260329.md`
- `docs/development/dingtalk-directory-git-baseline-20260327.md`
- `docs/development/directory-migration-baseline-git-slice-20260328.md`
- `docs/verification-index.md`

## 本地验证

### 1. CLI 可用性

命令：

```bash
node scripts/ops/git-slice-handoff.mjs --list-slices
node scripts/ops/git-slice-handoff.mjs --slice directory-migration-baseline --list-groups
bash -n scripts/ops/handoff-remote-git-slice.sh
```

结果：

- 全部通过
- `directory-migration-baseline` 当前仍是 `5` 个 commit groups
- 当前 slice 已扩展到 `63` 个文件

### 2. 刷新本地 materialize / promote 来源

命令：

```bash
pnpm materialize:git-slice:directory-migration-baseline
pnpm promote:git-slice:directory-migration-baseline
```

结果：

- materialized branch：
  - `materialized/directory-migration-baseline-2026-03-28-171207596z-70062-9a9665`
- materialized head：
  - `402047aba8df99a78c4d7dacf20971094ef07829`
- promoted branch：
  - `promoted/directory-migration-baseline-2026-03-28-171211339z-70930-6bc354`
- promoted head：
  - `b2c55366e41dce8ae8687a3fcf670e534d81ca88`
- 当前 promote manifest：
  - `output/git-slice-promotions/directory-migration-baseline/manifest.json`

### 3. verify handoff

命令：

```bash
pnpm verify:git-slice-handoff:directory-migration-baseline
```

结果：

- 通过
- source branch：
  - `promoted/directory-migration-baseline-2026-03-28-171211339z-70930-6bc354`
- source head：
  - `b2c55366e41dce8ae8687a3fcf670e534d81ca88`
- verify output：
  - `output/git-slice-handoffs/verify-directory-migration-baseline`
- bundle：
  - `output/git-slice-handoffs/verify-directory-migration-baseline/directory-migration-baseline.bundle`
- bundle SHA-256：
  - `3bdcaa6b1e0a8fcda7c3b34a0f660bb1040bc09e7028d9bf06ce4532dfeeed93`
- patch 数量：
  - `5`
- 关键输出：
  - `manifest.json`
  - `README.md`
  - `commit-summary.md`
  - `patches/*.patch`
- `verifyPassed=true`

生成的 patch SHA-256：

- `0001`：
  - `f42b9fe6c145fcffc757f53d4fc91114a8d09ad72e5139b682ffb476d6cfe803`
- `0002`：
  - `2c7006e88ed46b9860748a5c6eea6398b23d43ff85bfe274b6e2f48abd912869`
- `0003`：
  - `d039e909a0512c12e40e1dcc9fe01d2383e44c9639b1fad5661fca7a978b042f`
- `0004`：
  - `f53ee437f2b77213165070148eb4053987bb89e407ff8211a2258c3b2b5e57d2`
- `0005`：
  - `aba1f98a6854e7ad25068358e48096b77b90f6bcbdeb4f24b131bb1ee417d947`

### 4. 正式 handoff

命令：

```bash
pnpm handoff:git-slice:directory-migration-baseline
node scripts/ops/git-slice-handoff.mjs \
  --slice directory-migration-baseline \
  --manifest output/git-slice-promotions/directory-migration-baseline/manifest.json
```

结果：

- 通过
- output：
  - `output/git-slice-handoffs/directory-migration-baseline`
- bundle SHA-256：
  - `3bdcaa6b1e0a8fcda7c3b34a0f660bb1040bc09e7028d9bf06ce4532dfeeed93`
- human summary 已正确打印：
  - `bundle_path`
  - `bundle_sha256`
  - `readme_path`
  - `commit_summary_path`
  - `5` 个 group -> patch 的映射

### 5. 组级边界验证

命令：

```bash
node scripts/ops/git-slice-handoff.mjs \
  --slice directory-migration-baseline \
  --manifest output/git-slice-promotions/directory-migration-baseline/manifest.json \
  --group ops-baseline-tooling \
  --json
```

结果：

- 预期失败
- 错误码：
  - `GROUP_HANDOFF_REQUIRES_GROUP_SOURCE`

说明：

- 当前 full-slice promoted branch 不允许伪装成单个 group handoff
- 如果要交接单个 group，必须先拿到已经缩窄到该 group 的 source branch 或 manifest

## 结论

这轮验证说明 handoff 已经从“promote 之后还要手工拼 bundle/patch/README”，推进成正式工具：

1. 可以直接消费 promoted manifest
2. 可以稳定导出 `bundle + patch series + manifest + README + commit summary`
3. 能对 full-slice / group-source 做显式边界校验
4. 交接产物已和 `63` 文件 slice 对齐

## 实际执行命令

```bash
node scripts/ops/git-slice-handoff.mjs --list-slices
node scripts/ops/git-slice-handoff.mjs --slice directory-migration-baseline --list-groups
bash -n scripts/ops/handoff-remote-git-slice.sh
pnpm materialize:git-slice:directory-migration-baseline
pnpm promote:git-slice:directory-migration-baseline
pnpm verify:git-slice-handoff:directory-migration-baseline
pnpm handoff:git-slice:directory-migration-baseline
node scripts/ops/git-slice-handoff.mjs --slice directory-migration-baseline --manifest output/git-slice-promotions/directory-migration-baseline/manifest.json
node scripts/ops/git-slice-handoff.mjs --slice directory-migration-baseline --manifest output/git-slice-promotions/directory-migration-baseline/manifest.json --group ops-baseline-tooling --json
```

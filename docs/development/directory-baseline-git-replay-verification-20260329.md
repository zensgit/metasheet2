# Directory Baseline Git Replay Verification

日期：2026-03-29

## 变更范围

- `scripts/ops/git-slice-replay.mjs`
- `scripts/ops/replay-remote-git-slice.sh`
- `scripts/ops/git-slice-handoff.mjs`
- `scripts/ops/git-slices.mjs`
- `package.json`
- `docs/development/directory-baseline-git-replay-design-20260329.md`
- `docs/development/directory-baseline-git-replay-verification-20260329.md`
- `docs/development/remote-git-slice-replay-design-20260329.md`
- `docs/development/remote-git-slice-replay-verification-20260329.md`

## 本地验证

### 1. CLI 可用性

命令：

```bash
node scripts/ops/git-slice-replay.mjs --list-slices
node scripts/ops/git-slice-replay.mjs --slice directory-migration-baseline --list-groups
```

结果：

- 全部通过
- `directory-migration-baseline` 当前仍是 `5` 个 commit groups
- 当前 slice 已扩展到 `63` 个文件

### 2. 首次 replay 暴露的真实边界

首次直接执行：

```bash
pnpm verify:git-slice-replay:directory-migration-baseline
```

真实失败：

- 错误码：`REPLAY_PATCH_SHA_MISMATCH`

根因复核：

- replay 后重新导出的 patch 内容与 handoff patch 只有 `index` 行缩写宽度不同
- 这会导致 SHA-256 不同，但不属于语义差异

收口措施：

- `git-slice-materialize.mjs`
- `git-slice-promote.mjs`
- `git-slice-handoff.mjs`
- `git-slice-replay.mjs`

统一改为：

```bash
git format-patch --full-index --binary --abbrev=40
```

这样不同环境下 patch 哈希就稳定了。

### 3. 刷新本地 materialize / promote / handoff 来源

命令：

```bash
pnpm materialize:git-slice:directory-migration-baseline
pnpm promote:git-slice:directory-migration-baseline
pnpm handoff:git-slice:directory-migration-baseline
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
- handoff output：
  - `output/git-slice-handoffs/directory-migration-baseline`
- handoff bundle SHA-256：
  - `3bdcaa6b1e0a8fcda7c3b34a0f660bb1040bc09e7028d9bf06ce4532dfeeed93`

### 4. verify replay

命令：

```bash
pnpm verify:git-slice-replay:directory-migration-baseline
```

结果：

- 通过
- source branch：
  - `promoted/directory-migration-baseline-2026-03-28-171211339z-70930-6bc354`
- source head：
  - `b2c55366e41dce8ae8687a3fcf670e534d81ca88`
- replay branch：
  - `replayed/directory-migration-baseline-2026-03-28-171215047z-72090-f15f84`
- replayed head：
  - `b2c55366e41dce8ae8687a3fcf670e534d81ca88`
- verify output：
  - `output/git-slice-replays/verify-directory-migration-baseline`
- `verifyPassed=true`

patch SHA 全量一致：

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

### 5. 正式 replay

命令：

```bash
pnpm replay:git-slice:directory-migration-baseline
```

结果：

- 通过
- replay branch：
  - `replayed/directory-migration-baseline-2026-03-28-171226369z-72977-456544`
- replayed head：
  - `b2c55366e41dce8ae8687a3fcf670e534d81ca88`
- output：
  - `output/git-slice-replays/directory-migration-baseline`
- `verifyPassed=true`
- cleanup：
  - `replayRepoRemoved=true`
  - `branchDeleted=true`
  - `tempParentRemoved=true`

## 结论

这轮验证说明 `replay` 已经把 Git baseline 工具链正式推进到下一层：

1. handoff 产物不只是“可交接”
2. 它现在还能在 fresh Git 环境里独立重放
3. 并且能证明 replay 后的 patch 与 handoff patch 完全一致

当前链路已推进为：

1. report
2. sync-plan
3. bundle
4. apply
5. materialize
6. promote
7. handoff
8. replay

## 实际执行命令

```bash
node scripts/ops/git-slice-replay.mjs --list-slices
node scripts/ops/git-slice-replay.mjs --slice directory-migration-baseline --list-groups
pnpm materialize:git-slice:directory-migration-baseline
pnpm promote:git-slice:directory-migration-baseline
pnpm handoff:git-slice:directory-migration-baseline
pnpm verify:git-slice-replay:directory-migration-baseline
pnpm replay:git-slice:directory-migration-baseline
```

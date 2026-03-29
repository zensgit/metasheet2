# Directory Baseline Git Land Verification

日期：2026-03-29

## 验证范围

验证 `git-slice-land` 是否能够在本地：

- 读取 `submit manifest`
- 生成 landed branch
- 在 verify 模式下清理 branch/worktree
- 输出 landed patch、summary、commands
- 给出 `branchReadyForPush`

## 执行命令

```bash
pnpm verify:git-slice-land:directory-migration-baseline
pnpm land:git-slice:directory-migration-baseline
```

## 结果

全部通过。

关键输出目录：

- verify：`output/git-slice-landings/verify-directory-migration-baseline`
- landed：`output/git-slice-landings/directory-migration-baseline`

关键结果：

- `baseRef=origin/codex/attendance-pr396-pr399-delivery-md-20260310`
- `baseSha=86d709e0247125d91753e85caaa07e0db892091d`
- `sourcePromotedBranch=promoted/directory-migration-baseline-2026-03-28-182924769z-4734-97fa6d`
- `sourcePromotedHead=a143b8f3691df6698fba4ce563da682427e4e849`
- `sliceFilesCount=82`
- verify landed branch：`landed/directory-migration-baseline/2026-03-28-183520669z/13994/ca400e`
- verify landed head：`2fe680756ef5c61114d7c5542f69125661894f2b`
- 正式 landed branch：`landed/directory-migration-baseline/2026-03-28-183418305z/12387/a9f2f3`
- 正式 landed head：`3bcdbc87f237195041be461ca45f01b8b9d63578`
- `aheadCount=5`
- `behindCount=0`
- `dirty=false`
- `treeMatchesPromotedHead=true`
- `branchReadyForPush=true`
- `currentBranchIsLandedBranch=true`

verify 额外确认：

- `cleanup.worktreeRemoved=true`
- `cleanup.branchDeleted=true`

产物：

- `manifest.json`
- `README.md`
- `land-summary.md`
- `land-commands.sh`
- `patches/*.patch`

## 结论

本地链路已经推进到：

- `materialize -> promote -> handoff -> replay -> attest -> submit -> land`

并且 landed branch 已被证明是 clean push-candidate。

补充边界：

- 当前主工作树仍然是 `ahead 3 / behind 4 / dirty=true`
- 所以这里能证明“slice 已经 landed”，但仍不能宣称“当前代码已同步到 GitHub”

# Directory Baseline Git Submit Verification

日期：2026-03-29

## 验证范围

验证 `git-slice-submit` 是否能够在本地把：

- promote
- handoff
- replay
- attest

四阶段结果收拢成最终 submit packet，并明确区分：

- `sliceReadyForSubmission`
- `currentWorktreeReadyForPush`

## 执行命令

```bash
node scripts/ops/git-slice-submit.mjs --list-slices
node scripts/ops/git-slice-submit.mjs --slice directory-migration-baseline --list-groups
pnpm verify:git-slice-submit:directory-migration-baseline
pnpm submit:git-slice:directory-migration-baseline
```

## 结果

全部通过，且 submit packet 已被后续 `land` 实际消费。

关键输出目录：

- verify：`output/git-slice-submissions/verify-directory-migration-baseline`
- submit：`output/git-slice-submissions/directory-migration-baseline`

关键结果：

- `baseRef=origin/codex/attendance-pr396-pr399-delivery-md-20260310`
- `baseSha=86d709e0247125d91753e85caaa07e0db892091d`
- `promotedBranch=promoted/directory-migration-baseline-2026-03-28-182924769z-4734-97fa6d`
- `promotedHead=a143b8f3691df6698fba4ce563da682427e4e849`
- `sliceFilesCount=82`
- `handoffBundleSha256=4803d2f588ec6fe5cfbe83d551dd39638ae153bdf3a94ee4ca4837f6756f99c6`
- `replayedBranch=replayed/directory-migration-baseline-2026-03-28-182929331z-5509-d99f4e`
- `replayedHead=a143b8f3691df6698fba4ce563da682427e4e849`
- `sliceReadyForSubmission=true`
- `currentWorktreeReadyForPush=false`
- `githubSyncReady=false`

当前主工作树状态：

- 分支：`codex/attendance-pr396-pr399-delivery-md-20260310`
- `ahead=3`
- `behind=4`
- `dirty=true`
- `changedFileCount=370`
- `modifiedTrackedCount=91`
- `untrackedCount=279`

组级 `patchId` 已通过 attestation 贯通到 submit：

- `core-backend-migration-cli`: `6e20c9ab781c260e9b911ce55b6cf3bc96af68cc`
- `directory-iam-migrations`: `151ac579d7ae2aa6fd873e394198ad5639bf0466`
- `ops-baseline-tooling`: `afb3a24a11cdf6ed43f978c9a8921964460da58c`
- `migration-audit-tests`: `5e51604a434073280906c6d3e7ebe0ce6ee6b979`
- `migration-baseline-docs`: `14a8ccdf412bc996efcd0c969c60bed013777939`

## 产物

- `manifest.json`
- `README.md`
- `submit-summary.md`
- `submit-commands.sh`

所在目录：

- `output/git-slice-submissions/verify-directory-migration-baseline`
- `output/git-slice-submissions/directory-migration-baseline`

## 结论

结论成立：

- 该 slice 已经具备正式交接资格
- 本地 `submit` 结果已被 `git-slice-land` 成功消费
- 但当前主工作树仍不能宣称“已同步到 GitHub”

也就是说，本地链路现在已经推进到“可正式交接”，但后续 Git 收口仍需基于 clean promoted / handoff 产物继续进行，而不能直接拿当前 dirty 工作树去 push。

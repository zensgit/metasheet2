# Directory Baseline Git Publish Verification

日期：2026-03-29

## 验证范围

验证 `git-slice-publish` 是否能够在本地：

- 读取 `land manifest`
- 生成 publish bundle / request-pull / commands / summary
- 在 verify 模式下推到临时 bare repo 完成验真
- 在 landed branch 尚未 push GitHub 时，正确降级到本地 preview

## 执行命令

```bash
pnpm verify:git-slice-publish:directory-migration-baseline
pnpm publish:git-slice:directory-migration-baseline
```

## 结果

全部通过。

关键输出目录：

- verify：`output/git-slice-publishes/verify-directory-migration-baseline`
- publish：`output/git-slice-publishes/directory-migration-baseline`

关键结果：

- `baseRef=origin/codex/attendance-pr396-pr399-delivery-md-20260310`
- `baseSha=86d709e0247125d91753e85caaa07e0db892091d`
- `sliceFilesCount=82`
- 正式 landed branch：`landed/directory-migration-baseline/2026-03-28-183418305z/12387/a9f2f3`
- 正式 landed head：`3bcdbc87f237195041be461ca45f01b8b9d63578`
- `bundleSha256=8ff26f9c4de57120a84461b528b6b08763782fc91fadce6f5bd8eadf746c8c54`
- `requestPullRemoteReady=false`
- `requestPullMode=local-repo-fallback`
- `verifyPushSucceeded=true`
- `publishReady=true`
- verify 模式临时 bare repo：`/var/folders/23/dzwf05nn7nvgxc1fz30kn5gh0000gn/T/git-slice-publish-verify-LeBGfL/publish-verify.git`

补充说明：

- `git request-pull` 在 landed branch 尚未真正 push 到 GitHub 前，远端 URL 预览会正常失败。
- 当前实现已把这类失败收口为本地 preview fallback，而不是 publish 失败。
- 相关 warning 已写入：
  - `output/git-slice-publishes/verify-directory-migration-baseline/request-pull-warning.txt`
  - `output/git-slice-publishes/directory-migration-baseline/request-pull-warning.txt`

产物：

- `manifest.json`
- `README.md`
- `publish-summary.md`
- `publish-commands.sh`
- `request-pull.txt`
- `request-pull-warning.txt`
- `publish.bundle`
- `bundle-verify.txt`

## 结论

本地链路现在已经推进到：

- `materialize -> promote -> handoff -> replay -> attest -> submit -> land -> publish`

并且当前 `directory-migration-baseline` 这条切片已经具备正式交接与 push-candidate publish 能力。

补充边界：

- 当前主工作树仍然是 `ahead 3 / behind 4 / dirty=true`
- 因此这里能证明“slice publish 已成立”，但仍然不能宣称“当前代码已同步到 GitHub”

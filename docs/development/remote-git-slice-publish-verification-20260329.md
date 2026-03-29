# Remote Git Slice Publish Verification

日期：2026-03-29

## 验证范围

验证 `142.171.239.56` 上的正式 baseline clone 是否能够：

- 读取 remote land manifest
- 在远端 baseline clone 中生成 publish packet
- 回收到本地形成正式 publish 交付目录

## 执行命令

```bash
pnpm verify:remote-git-slice-publish:directory-migration-baseline
pnpm ops:publish-remote-git-slice:directory-migration-baseline
```

## 结果

全部通过。

本地回收目录：

- verify：`output/remote-git-slice-publishes/directory-migration-baseline/verify`
- publish：`output/remote-git-slice-publishes/directory-migration-baseline/publish`

关键结果：

- `baseRef=origin/codex/attendance-pr396-pr399-delivery-md-20260310`
- `baseSha=86d709e0247125d91753e85caaa07e0db892091d`
- verify landed branch：`landed/directory-migration-baseline/2026-03-28-183341547z/270567/c3133a`
- verify landed head：`4df980d0db6a8fbbe8a2472f812313af24c826de`
- 正式 landed branch：`landed/directory-migration-baseline/2026-03-28-183151974z/268607/316253`
- 正式 landed head：`42598eb31e36a506a39b88c21d3291b8065ac22f`
- `sliceFilesCount=82`
- verify `bundleSha256=f8f1a8dd960a2dd5658e4aa0bad33de017f4912c471d3a5bf3c531c5dffd9529`
- 正式 `bundleSha256=18d219ae659389d8b5bc5464d9f8cd80f06f3683f39b4b4784e063ac11ceeb63`
- `requestPullRemoteReady=false`
- `requestPullMode=local-repo-fallback`
- `verifyPushSucceeded=true`
- `publishReady=true`
- verify 模式临时 bare repo：`/tmp/git-slice-publish-verify-eYIgS7/publish-verify.git`
- `requestPullFallbackUrl=/home/mainuser/metasheet2-git-baseline`

远端 baseline clone 当前状态：

- 分支：`codex/attendance-pr396-pr399-delivery-md-20260310`
- `head=86d709e0247125d91753e85caaa07e0db892091d`
- `ahead=0`
- `behind=0`
- `dirty=false`
- `deployDirIsGitRepo=false`

补充边界：

- 远端正式 baseline clone 已能生成 verify / 正式 publish packet
- 远端现网部署目录 `/home/mainuser/metasheet2` 仍然不是 Git 仓库
- `request-pull` 的远端 URL 预览仍然会因为 landed branch 未 push 到 GitHub 而退化到本地 preview，这属于当前设计预期

## 结论

远端链路已经推进到：

- `bootstrap -> materialize -> promote -> handoff -> replay -> attest -> submit -> land -> publish`

也就是：远端正式 baseline clone 现在已经不仅能验证和 landed 同一条切片，还能生成完整 publish 交付包，并保留对 GitHub 未 push 场景的稳定降级。

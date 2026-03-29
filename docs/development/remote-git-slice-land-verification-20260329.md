# Remote Git Slice Land Verification

日期：2026-03-29

## 验证范围

验证 `142.171.239.56` 上的正式 baseline clone 是否能够：

- 读取 remote submit manifest
- 在远端 baseline clone 中生成 landed branch
- 回收到本地形成正式 landed 交付目录

## 执行命令

```bash
pnpm verify:remote-git-slice-land:directory-migration-baseline
pnpm ops:land-remote-git-slice:directory-migration-baseline
```

## 结果

全部通过。

本地回收目录：

- verify：`output/remote-git-slice-landings/directory-migration-baseline/verify`
- landed：`output/remote-git-slice-landings/directory-migration-baseline/landed`

关键结果：

- `baseRef=origin/codex/attendance-pr396-pr399-delivery-md-20260310`
- `baseSha=86d709e0247125d91753e85caaa07e0db892091d`
- `sourcePromotedBranch=promoted/directory-migration-baseline-2026-03-28-183029056z-266422-1eaad8`
- `sourcePromotedHead=c47651b048d02f594801d5572f1b3405bb8d7f97`
- `sliceFilesCount=82`
- remote verify landed branch：`landed/directory-migration-baseline/2026-03-28-183550715z/272572/e4c2b3`
- remote verify landed head：`1e9a3f3c5ef1158c3dbc79c9c8a4480fc9e596cc`
- remote 正式 landed branch：`landed/directory-migration-baseline/2026-03-28-183341547z/270567/c3133a`
- remote 正式 landed head：`4df980d0db6a8fbbe8a2472f812313af24c826de`
- `aheadCount=5`
- `behindCount=0`
- `dirty=false`
- `treeMatchesPromotedHead=true`
- `branchReadyForPush=true`

远端 baseline clone 当前状态：

- 分支：`codex/attendance-pr396-pr399-delivery-md-20260310`
- `head=86d709e0247125d91753e85caaa07e0db892091d`
- `ahead=0`
- `behind=0`
- `dirty=false`
- `githubSyncReady=true`

补充边界：

- 远端 baseline clone 已能把 submit packet 推进成 clean landed branch
- 现网部署目录 `/home/mainuser/metasheet2` 仍然不是 Git 仓库

## 结论

远端链路已经推进到：

- `bootstrap -> materialize -> promote -> handoff -> replay -> attest -> submit -> land`

也就是：远端正式 baseline clone 现在已经不仅能证明语义等价，还能把这条 slice 真正落地为 clean landed branch。

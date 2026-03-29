# Remote Git Slice Submit Verification

日期：2026-03-29

## 验证范围

验证 `142.171.239.56` 上的正式 baseline clone 是否能够：

- 读取 remote promote / handoff / replay / attest 产物
- 在远端 baseline clone 内生成 submit packet
- 回收到本地形成正式交付目录

## 执行命令

```bash
pnpm verify:remote-git-slice-submit:directory-migration-baseline
pnpm ops:submit-remote-git-slice:directory-migration-baseline
```

## 结果

全部通过，且 remote submit packet 已被后续 `remote land` 实际消费。

本地回收目录：

- verify：`output/remote-git-slice-submissions/directory-migration-baseline/verify`
- submit：`output/remote-git-slice-submissions/directory-migration-baseline/submit`

关键结果：

- `promotedBranch=promoted/directory-migration-baseline-2026-03-28-183029056z-266422-1eaad8`
- `promotedHead=c47651b048d02f594801d5572f1b3405bb8d7f97`
- `sliceFilesCount=82`
- `bundleSha256=ab9b6414c4fb538d73cfe7343ed1be608a1244bb38621d1e5cfe962b03dcb507`
- `sliceReadyForSubmission=true`
- `currentWorktreeReadyForPush=false`

远端 baseline clone 当前状态：

- 分支：`codex/attendance-pr396-pr399-delivery-md-20260310`
- `head=86d709e0247125d91753e85caaa07e0db892091d`
- `ahead=0`
- `behind=0`
- `dirty=false`
- `githubSyncReady=true`

补充边界：

- 远端 baseline clone 是 Git 仓库且 clean
- 远端现网部署目录 `/home/mainuser/metasheet2` 仍然不是 Git 仓库
- 每次远端 `submit-runs` 目录都带时间戳，最新精确路径以回收的 `report.json` 为准
- 这说明 submit 报告已经能正确区分“远端基线 clean”和“现网部署目录不是 Git clone”这两个事实

## 回收产物

每个模式下都已回收：

- `report.json`
- `exit-code`
- `artifacts/manifest.json`
- `artifacts/README.md`
- `artifacts/submit-summary.md`
- `artifacts/submit-commands.sh`

## 结论

远端链路已成立：

- `materialize -> promote -> handoff -> replay -> attest -> submit -> land`

并且远端正式 baseline clone 现在已经不仅能生成和验证 slice，还能把 submit packet 继续推进为 landed branch，同时给出“远端当前已经 GitHub ready”的正式结构化结论。

# Directory Baseline Git Deliver Verification

日期：2026-03-29

## 验证范围

验证 `git-slice-deliver` 是否能够在本地：

- 读取 `publish manifest`
- 在 verify 模式下推送到临时 bare repo 并验回远端 head
- 在正式模式下把 landed branch 推送到目标 repo URL
- 生成 `request-pull-remote / compare-url / commands / summary`

## 执行命令

```bash
pnpm verify:git-slice-deliver:directory-migration-baseline
pnpm deliver:git-slice:directory-migration-baseline
```

## 结果

待执行并回填。

## 结论

待执行并回填。

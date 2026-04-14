# DingTalk Directory Stack PR Comment

## Goal

Post a concise reviewer note on `#873` that:

- explains how this PR relates to the broader Feishu-gap complete report
- makes the narrower DingTalk admin/ops scope explicit
- points reviewers at the highest-signal review boundaries

## Comment Body

```md
补充一条 review 范围说明，避免把这条 PR 和完整的飞书差距总报告混在一起看。

仓库里的 [metasheet-feishu-gap-complete-report-20260414.md](/Users/chouhua/Downloads/Github/metasheet2/docs/development/metasheet-feishu-gap-complete-report-20260414.md:1) 记录的是更大的 16 PR / ~685 测试总览；`#873` 只是其中一个更窄的 DingTalk admin/ops 子切片，不是那份完整报告的替代物。

- 这条 PR 的直接范围是：directory review queue、recent alerts、batch bind / unbind、bulk DingTalk grant / namespace admission、schedule observation。
- 这条 PR 不包含：runtime scheduler 真正接线、DingTalk OAuth callback 改动、以及与本主题无关的 backend type-fix 清理。
- review 时请重点看 3 件事：batch 操作是按条处理而不是跨条事务回滚；schedule card 是观测面不是自动调度证明；本 PR 的验证应看它自己的 admin-path 测试与 caveat，不要直接套完整总报告里的总测试数。
```

## Notes

- The comment intentionally avoids hype or roadmap recap.
- The goal is reviewer framing, not change summary duplication.

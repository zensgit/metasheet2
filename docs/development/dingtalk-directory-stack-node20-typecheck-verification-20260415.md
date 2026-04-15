# DingTalk Directory Stack Node20 Typecheck Verification

Date: `2026-04-15`
Branch: `codex/feishu-gap-rc-integration-202605`
PR: `#873`

## Failure Evidence

Reviewed failed job log:

- `gh run view 24413571229 --job 71316651968 --log-failed`

Observed error:

```text
apps/web type-check: src/multitable/components/MetaAutomationRuleEditor.vue(183,25): error TS2322
```

## Local Verification

Command:

```bash
cd /tmp/metasheet2-dingtalk-stack/apps/web
node /Users/chouhua/Downloads/Github/metasheet2/node_modules/.pnpm/vue-tsc@3.1.4_typescript@5.8.3/node_modules/vue-tsc/bin/vue-tsc.js --noEmit
```

Result:

- command completed successfully with exit code `0`

Note:

- the isolated worktree does not have a stable local `.bin/vue-tsc`, so verification used the main workspace's pinned `vue-tsc` entrypoint against the worktree sources

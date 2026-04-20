# DingTalk Public Form Rollforward Development

- Date: 2026-04-20
- Branch: `codex/dingtalk-public-form-allowlist-20260420`

## Scope

This round did not add new runtime feature code. It focused on:

1. promoting the protected public-form hotfix chain into `main`
2. rebasing the allowlist branch onto the updated `main`
3. adding two long-lived DingTalk documentation guides

## Mainline progression

### `#931` merged

Pull request [#931](https://github.com/zensgit/metasheet2/pull/931) was merged into `main`.

That promotion carried the protected public-form runtime changes:

- token-gated public form API access
- DingTalk-protected public-form modes
- public-form auth bootstrap and gating

### `#933` rebased onto `main`

After `#931` landed, [#933](https://github.com/zensgit/metasheet2/pull/933) no longer needed a stacked base.

This round:

- rebased `codex/dingtalk-public-form-allowlist-20260420` onto `origin/main`
- force-pushed the rebased branch
- updated the PR base from `codex/public-form-auth-hotfix-20260420` to `main`

This keeps the allowlist slice reviewable as a direct mainline change.

## Documentation deliverables

Added:

- [docs/dingtalk-capability-guide-20260420.md](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-protected-public-form-20260420/docs/dingtalk-capability-guide-20260420.md:1)
- [docs/dingtalk-admin-operations-guide-20260420.md](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-protected-public-form-20260420/docs/dingtalk-admin-operations-guide-20260420.md:1)

These capture the current DingTalk product line after:

- directory and identity integration
- group and person notifications
- protected public forms
- local user/member-group allowlists

## Claude Code CLI

This round used Claude Code CLI in read-only mode for two narrow drafting/safety checks:

- outline for the two DingTalk docs
- safest operational guidance for temporary admin-token handoff

The final repo changes were still written and verified directly in the worktree.

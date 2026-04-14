# DingTalk Identity Stack Handoff Development

Date: 2026-04-14
Branch: `codex/dingtalk-identity-integration-20260414`

## Goal

Prepare the DingTalk identity work for merge as three isolated lanes:

1. backend/runtime
2. frontend consumption
3. integration/docs handoff

## Lanes

### Runtime

- Branch: `codex/dingtalk-identity-runtime-20260414`
- Commit: `80864ac61`
- Scope:
  - shared DingTalk runtime status helper
  - richer `/api/auth/dingtalk/launch?probe=1`
  - richer `/api/admin/users/:userId/dingtalk-access`

### Frontend

- Branch: `codex/dingtalk-identity-frontend-20260414`
- Commit: `7060a2f30`
- Scope:
  - login page consumes structured probe payload
  - admin user management page displays backend runtime status

### Integration / Docs

- Branch: `codex/dingtalk-identity-integration-20260414`
- Commit introducing stack summary: `c4769d58b`
- Scope:
  - combined verification summary
  - merge order recommendation
  - handoff/checklist docs

## Recommended Merge Order

1. `codex/dingtalk-identity-runtime-20260414`
2. `codex/dingtalk-identity-frontend-20260414`
3. `codex/dingtalk-identity-integration-20260414`

Reason:

- frontend lane consumes the new backend `server` runtime-status block
- integration lane is documentation-only and should reflect the final merged order

## PR Checklist

### Runtime PR

- confirm probe payload shape is documented
- confirm launch/callback success path behavior is unchanged
- confirm admin DingTalk access response stays backward-compatible

### Frontend PR

- confirm login page hides the DingTalk button when `available !== true`
- confirm login page shows a stable reason hint for unavailable probe states
- confirm user management page surfaces server runtime status, corpId, and allowlist context

### Integration / Docs PR

- include links to runtime/frontend verification docs
- include merge order
- include explicit note that main worktree had unrelated DingTalk/admin changes and they were not touched

## Claude Code CLI Use

Claude Code CLI is available locally and authenticated.

Recommended use:

- isolated worktree only
- docs, backend, contract, or verification lanes
- narrow prompts with one output file or one bounded backend task

Avoid:

- long mixed frontend/backend editing tasks
- concurrent edits against the same working tree as Codex

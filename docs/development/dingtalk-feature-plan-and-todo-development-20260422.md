# DingTalk Feature Plan And TODO Development

- Date: 2026-04-22
- Branch: `codex/dingtalk-feature-plan-todo-20260422`
- Scope: planning and execution tracking documentation

## Context

The DingTalk work now spans group robot delivery, direct person delivery, DingTalk-protected public forms, directory sync, no-email local user creation, and remote smoke validation. A single actionable TODO document is needed so parallel implementation lanes can proceed without rediscovering the same decisions.

## Changes

Added `docs/development/dingtalk-feature-plan-and-todo-20260422.md` with:

- P0 stack stabilization tasks.
- P1 DingTalk group standard workflow tasks.
- P2 form access and assigned filler tasks.
- P3 direct person messaging and DingTalk user sync tasks.
- P4 documentation and remote smoke tasks.
- Parallel lane ownership guidance.
- Acceptance criteria and standard verification commands.

## Non-Goals

- No runtime behavior changes.
- No API contract changes.
- No frontend behavior changes.
- No database migration changes.

## Expected Effect

Future DingTalk PRs can be cut from this plan as small, independently verifiable slices, while preserving the product decisions already made: group first, person second, and local users/member groups as the source of fill permission.

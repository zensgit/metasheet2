# DingTalk No-Email Admission Docs Development

- Date: 2026-04-22
- Branch: `codex/dingtalk-no-email-docs-20260422`
- Scope: docs-only correction for DingTalk synced-account local-user admission

## Context

The DingTalk status and synced-account guides still described no-email local-user admission as pending or blocked by email requirements.

That description no longer matches the current implementation:

- Manual admission accepts `name` plus at least one identifier: `email`, `username`, or `mobile`.
- Manual no-email admission can return a temporary password and onboarding packet.
- Department-scoped auto-admission can create no-email users with generated usernames.
- Auto-admission returns onboarding packets for no-email users instead of email invite links.

## Changes

- Updated `docs/dingtalk-capability-status-matrix-20260420.md`.
- Updated `docs/dingtalk-synced-account-local-user-guide-20260420.md`.
- Changed no-email synced-account admission from `Pending` to `Implemented`.
- Clarified the manual admission requirement as `name + email/username/mobile`.
- Clarified that auto-admission generates usernames and onboarding packets for no-email accounts.
- Replaced stale local worktree absolute links in touched docs with repository-relative links.

## Non-Goals

- No backend runtime changes.
- No frontend runtime changes.
- No API contract changes.
- No migration changes.

## Code Evidence

- Manual admission route accepts an optional email payload and forwards username/mobile.
- `admitDirectoryAccountUser` enforces `name` plus at least one of email, username, or mobile.
- Auto-admission builds deterministic usernames when email is missing.
- No-email auto-admission records onboarding packets with temporary passwords.

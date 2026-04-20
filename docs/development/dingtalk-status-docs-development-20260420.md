# DingTalk Status Docs Development

- Date: 2026-04-20
- Branch: `codex/dingtalk-status-docs-20260420`
- Scope: documentation-only follow-up on current `main`

## Goal

Add two explicit DingTalk documents that answer:

1. which DingTalk capabilities are already complete on current `main`, which still have constraints, and which are still pending
2. whether DingTalk-synced directory accounts can become local MetaSheet users, and under what current-main constraints

## Files added

- [docs/dingtalk-capability-status-matrix-20260420.md](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/docs/dingtalk-capability-status-matrix-20260420.md:1)
- [docs/dingtalk-synced-account-local-user-guide-20260420.md](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/docs/dingtalk-synced-account-local-user-guide-20260420.md:1)

## What was documented

### Capability status matrix

The matrix was written against current `main`, not branch memory, and split into:

- implemented
- implemented with constraints
- pending

It explicitly captures current-main boundaries such as:

- manual admission exists
- department-scoped auto-admission exists
- protected public-form allowlists are now in `main`
- DingTalk group/person notifications are in `main`
- no-email synced-account admission is still not a current-main capability
- group destinations are still manually registered and not yet a shared org-wide catalog

### Synced account -> local user guide

This guide was written to answer the operational question directly and without product ambiguity:

- yes, synced directory accounts can become local users
- yes, both manual and auto-admission paths exist
- yes, generated-password onboarding is supported
- but current `main` still requires email for the local-user creation path

## Method

- reused the existing top-level DingTalk docs as framing context
- re-checked the actual current-main code paths for:
  - manual admission
  - auto-admission
  - onboarding outputs
  - forced password change
  - member-group projection
  - protected public-form allowlists
- kept the new docs narrow and operational, instead of re-explaining the entire DingTalk stack

## Claude Code CLI

Used read-only in this round to draft two short outlines for the new docs.

The actual documents, code-path validation, and final content were written and checked manually against the repository.

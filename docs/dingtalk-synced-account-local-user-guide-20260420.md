# DingTalk Synced Accounts To Local Users Guide

- Date: 2026-04-20
- Scope: current `main`
- Audience: admins, implementation owners, support

## Purpose

This guide answers one concrete question:

- can a DingTalk-synced directory account become a local MetaSheet user?

On current `main`, the answer is:

- yes, for manual admission
- yes, for department-scoped auto-admission
- with one important current constraint: email is still required

## Core model

The authority subject remains the local MetaSheet user.

The DingTalk-synced directory account is:

- an upstream directory identity
- a review and admission source
- a pre-bind source for later DingTalk login and notification delivery

It is not the primary user record for the product.

The resulting local user still lives in `users`, and the DingTalk account is linked to that local user.

## Supported paths on current `main`

### 1. Manual admission from the directory review UI

Supported.

Admin flow:

1. Open the directory management page.
2. Find a synced DingTalk directory account.
3. Choose the manual admission action.
4. Enter:
   - `name`
   - `email`
   - optional `mobile`
   - optional password
5. Submit.

Backend behavior:

- creates a local row in `users`
- generates a temporary password if no password was supplied
- sets `must_change_password = true` when the password was generated
- binds the local user to the directory account
- enables DingTalk grant by default unless explicitly disabled
- issues invite/onboarding outputs

Key references:

- [admin-directory.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/packages/core-backend/src/routes/admin-directory.ts:380)
- [directory-sync.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/packages/core-backend/src/directory/directory-sync.ts:3337)
- [DirectoryManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/apps/web/src/views/DirectoryManagementView.vue:66)

### 2. Department-scoped auto-admission during sync

Supported.

Admin flow:

1. Configure department-scoped auto-admission in the directory integration.
2. Run sync.
3. Matching accounts in the selected scope are created and bound automatically.

Backend behavior:

- evaluates whether the synced account is inside the selected department scope
- skips excluded child departments
- creates local users for eligible accounts
- binds them immediately
- records invite/onboarding outputs

Key references:

- [directory-sync.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/packages/core-backend/src/directory/directory-sync.ts:2014)
- [directory-sync.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/packages/core-backend/src/directory/directory-sync.ts:2051)
- [DirectoryManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/apps/web/src/views/DirectoryManagementView.vue:2258)

### 3. What is created locally

When admission succeeds, the system creates or updates all of the following:

- a local user in `users`
- a directory-account link
- optional DingTalk grant enablement
- onboarding outputs:
  - temporary password when applicable
  - invite token
  - onboarding packet

Relevant references:

- [directory-sync.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/packages/core-backend/src/directory/directory-sync.ts:3427)
- [auth.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/packages/core-backend/src/routes/auth.ts:622)
- [admin-users.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/packages/core-backend/src/routes/admin-users.ts:2891)

## Current constraints on `main`

### Email is still required

Current `main` still enforces:

- manual admission requires `name + email`
- auto-admission skips missing-email accounts

Evidence:

- [directory-sync.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/packages/core-backend/src/directory/directory-sync.ts:3349)
- [directory-sync.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/packages/core-backend/src/directory/directory-sync.ts:2083)
- [DirectoryManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/apps/web/src/views/DirectoryManagementView.vue:2274)

So the current operational answer is:

- synced DingTalk users can become local users
- but not when the synced account has no usable email on current `main`

### DingTalk account identity still needs bindable keys

Manual admission also expects the synced account to have a usable DingTalk identity key for later pre-bind/login flow.

Evidence:

- [directory-sync.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/packages/core-backend/src/directory/directory-sync.ts:3361)

### This does not create a second local org tree

The current design does not copy the entire DingTalk department hierarchy into a second internal org tree.

Instead:

- synced departments can project into `platform_member_groups`

Evidence:

- [directory-sync.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/packages/core-backend/src/directory/directory-sync.ts:740)
- [DirectoryManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/apps/web/src/views/DirectoryManagementView.vue:191)

## Operational recommendations

### Use manual admission when

- you want to review one account at a time
- you want to override the entered name/email/mobile
- you need the onboarding outputs immediately

### Use auto-admission when

- a department clearly maps to “admit these users automatically”
- you want repeatable onboarding from a stable DingTalk org scope

### Expect forced password change for generated-password users

This is intentional:

- generated credentials are onboarding credentials, not long-term passwords

Evidence:

- [auth.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/packages/core-backend/src/routes/auth.ts:433)
- [ForcePasswordChangeView.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/apps/web/src/views/ForcePasswordChangeView.vue:1)

## What is not yet true on current `main`

- you cannot yet directly admit missing-email synced accounts through the current `main` flow
- you do not authorize raw DingTalk users directly
- you do not create a second internal department tree just because DingTalk sync exists

## Short answer

If someone asks:

- “Can DingTalk-synced users become local MetaSheet users?”

The current short answer is:

- yes, through manual admission and department-scoped auto-admission
- but current `main` still requires email for the local-user creation path

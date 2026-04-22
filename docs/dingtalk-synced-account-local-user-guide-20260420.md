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
- email is optional when another local identifier is available

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
   - optional `email`
   - optional `username`
   - optional `mobile`
   - optional password
5. Ensure at least one identifier is present:
   - `email`
   - `username`
   - `mobile`
6. Submit.

Backend behavior:

- creates a local row in `users`
- generates a temporary password if no password was supplied
- sets `must_change_password = true` when the password was generated
- binds the local user to the directory account
- enables DingTalk grant by default unless explicitly disabled
- issues invite/onboarding outputs
- issues an email invite only when an email exists
- returns an onboarding packet with the temporary password for no-email users

Key references:

- [admin-directory.ts](../packages/core-backend/src/routes/admin-directory.ts)
- [directory-sync.ts](../packages/core-backend/src/directory/directory-sync.ts)
- [DirectoryManagementView.vue](../apps/web/src/views/DirectoryManagementView.vue)

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
- generates a username when the DingTalk account has no email
- binds them immediately
- records invite/onboarding outputs
- returns no-email onboarding packets for accounts without email

Key references:

- [directory-sync.ts](../packages/core-backend/src/directory/directory-sync.ts)
- [DirectoryManagementView.vue](../apps/web/src/views/DirectoryManagementView.vue)

### 3. What is created locally

When admission succeeds, the system creates or updates all of the following:

- a local user in `users`
- a directory-account link
- optional DingTalk grant enablement
- onboarding outputs:
  - temporary password when applicable
  - invite token when email exists
  - onboarding packet

Relevant references:

- [directory-sync.ts](../packages/core-backend/src/directory/directory-sync.ts)
- [auth.ts](../packages/core-backend/src/routes/auth.ts)
- [admin-users.ts](../packages/core-backend/src/routes/admin-users.ts)

## Current constraints on `main`

### At least one local account identifier is required

Current `main` accepts email-less admission, but it does not create anonymous local users.

Manual admission requires:

- `name`
- at least one of `email`, `username`, or `mobile`

Auto-admission uses:

- the DingTalk email when available
- a generated username when email is missing
- the DingTalk mobile when available

Evidence:

- [directory-sync.ts](../packages/core-backend/src/directory/directory-sync.ts)
- [DirectoryManagementView.vue](../apps/web/src/views/DirectoryManagementView.vue)

So the current operational answer is:

- synced DingTalk users can become local users
- synced DingTalk users without email can also become local users if another identifier exists or auto-admission can generate a username

### DingTalk account identity still needs bindable keys

Manual admission also expects the synced account to have a usable DingTalk identity key for later pre-bind/login flow.

Evidence:

- [directory-sync.ts](../packages/core-backend/src/directory/directory-sync.ts)

### This does not create a second local org tree

The current design does not copy the entire DingTalk department hierarchy into a second internal org tree.

Instead:

- synced departments can project into `platform_member_groups`

Evidence:

- [directory-sync.ts](../packages/core-backend/src/directory/directory-sync.ts)
- [DirectoryManagementView.vue](../apps/web/src/views/DirectoryManagementView.vue)

## Operational recommendations

### Use manual admission when

- you want to review one account at a time
- you want to override the entered name/email/mobile
- you need to create a no-email user with a known username or mobile
- you need the onboarding outputs immediately

### Use auto-admission when

- a department clearly maps to “admit these users automatically”
- you want repeatable onboarding from a stable DingTalk org scope

### Expect forced password change for generated-password users

This is intentional:

- generated credentials are onboarding credentials, not long-term passwords
- no-email users rely on the onboarding packet and temporary password instead of an email invite

Evidence:

- [auth.ts](../packages/core-backend/src/routes/auth.ts)
- [ForcePasswordChangeView.vue](../apps/web/src/views/ForcePasswordChangeView.vue)

## What is not yet true on current `main`

- you do not authorize raw DingTalk users directly
- you do not create a second internal department tree just because DingTalk sync exists
- you do not send email invite links for users that have no email

## Short answer

If someone asks:

- “Can DingTalk-synced users become local MetaSheet users?”

The current short answer is:

- yes, through manual admission and department-scoped auto-admission
- email is optional; `name + email/username/mobile` is enough for manual admission
- department-scoped auto-admission can create no-email users with generated usernames and temporary-password onboarding packets

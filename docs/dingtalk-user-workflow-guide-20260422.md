# DingTalk User Workflow Guide

- Date: 2026-04-22
- Audience: table owners, automation authors, support users

## Purpose

This guide explains the operating workflow after DingTalk is configured by an administrator:

- bind one table to one or more DingTalk group robot destinations
- send DingTalk group or person messages from automation rules
- include public form links or internal processing links
- choose form access levels safely
- understand what end users can and cannot do after clicking a DingTalk message

## Core rule

DingTalk is a sign-in and delivery channel.

The system still authorizes:

- local MetaSheet users
- local MetaSheet member groups

A DingTalk group message does not grant form-fill permission by itself.

## Table owner workflow

### 1. Bind DingTalk groups to a table

1. Open the target table.
2. Open `API Tokens / Webhooks / DingTalk Groups`.
3. Add one destination per DingTalk group robot.
4. Use `Test send` before using the destination in automation.

Notes:

- one table can bind multiple DingTalk groups
- a destination belongs to the table where it was created
- the destination stores the group robot webhook, not the DingTalk group roster
- binding a group does not import group members

### 2. Create a DingTalk group message automation

1. Open automation management for the table.
2. Create a rule with action `Send DingTalk group message`.
3. Select one or more bound DingTalk group destinations.
4. Write the title and body templates.
5. Optionally select:
   - a public form link for new submissions
   - an internal processing link for local operators
6. Check the access summary before saving.

Use this for broad broadcast, such as asking a group to fill a form.

### 3. Create a DingTalk person message automation

1. Open automation management for the table.
2. Create a rule with action `Send DingTalk person message`.
3. Select local users or local member groups.
4. Confirm recipient status warnings.
5. Write the title and body templates.
6. Optionally select a public form or internal processing link.

Use this for exact handling requests.

Delivery behavior:

- bound and active local users receive the DingTalk person message
- inactive or unbound local users are skipped
- skipped recipients appear in person delivery history as `skipped`
- skipped recipients do not block delivery to other bound recipients

## Form access levels

### Public

Meaning:

- anyone with the link can submit

Use only when:

- the form is intentionally open
- no DingTalk identity check is required

### DingTalk-bound

Meaning:

- the visitor must sign in through DingTalk
- the DingTalk identity must be bound to a local user

Use when:

- you need DingTalk identity proof
- all bound DingTalk local users may submit

### DingTalk-authorized

Meaning:

- the visitor must sign in through DingTalk
- the DingTalk identity must be bound to a local user
- the local user must have an enabled DingTalk grant

Use when:

- only administrator-authorized DingTalk users should submit

### Local allowlist

For `DingTalk-bound` or `DingTalk-authorized` forms, table owners can add:

- allowed local users
- allowed local member groups

If an allowlist exists, the visitor must pass both:

- DingTalk access mode
- local allowlist check

This is the standard model for:

- send a message to a large DingTalk group
- allow only selected local users or member groups to fill

## End-user flow

### Opening a public form link

The user clicks the DingTalk message link.

Depending on access mode:

- public forms open directly
- DingTalk-bound forms require DingTalk sign-in and local binding
- DingTalk-authorized forms also require an enabled DingTalk grant
- allowlisted forms require the local user or one of their local member groups to be allowed

### Opening an internal processing link

The user clicks the DingTalk message link.

The user must already have local permission to the table and view.

Message delivery does not grant internal table access.

## Common messages and actions

| What the user sees | Meaning | Action |
| --- | --- | --- |
| Sign-in required | The form needs a DingTalk identity check | sign in through DingTalk |
| DingTalk binding required | DingTalk identity is not bound to a local user | ask an admin to bind or create the local user from directory sync |
| DingTalk grant required | The form requires administrator-enabled DingTalk access | ask an admin to enable the DingTalk grant |
| Not in allowlist | The local user is not directly allowed and is not in an allowed member group | ask the table owner to update the form allowlist |
| Internal link forbidden | The user lacks local table/view permission | ask the table owner to grant local access or use a public form |

## Delivery history checks

Table owners can inspect:

- group delivery history for webhook delivery issues
- person delivery history for recipient-level status

Person delivery statuses:

- `success`: sent
- `failed`: send attempted but failed
- `skipped`: local user was inactive or not bound to DingTalk

Use skipped status to decide whether to bind a synced DingTalk account, enable a user, or remove the user from recipient selection.

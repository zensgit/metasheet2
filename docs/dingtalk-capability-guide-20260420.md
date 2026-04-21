# DingTalk Capability Guide

- Date: 2026-04-20
- Audience: product, engineering, implementation owners

## Purpose

This document describes how DingTalk integrates with MetaSheet as:

- an identity and sign-in channel
- a directory sync source
- a notification delivery channel
- a gated entry point for public forms

The core rule is consistent across all features:

- the authority subject is always the local MetaSheet user or local member group
- DingTalk is used for authentication, identity binding, and message delivery

## Capability map

### 1. DingTalk sign-in and account binding

Supported:

- DingTalk sign-in bootstrap
- binding a local user to a DingTalk identity
- using DingTalk identity as a protected public-form gate

Implication:

- users can be recognized by DingTalk
- access decisions still resolve against local users, roles, member groups, and grants

### 2. Directory sync and governance

Supported:

- syncing DingTalk departments and members into the directory mirror
- review/bind/unbind governance
- creating local users from synced members
- auto-admission by department scope
- excluding child departments from auto-admission
- projecting DingTalk departments into `platform_member_groups`

This means DingTalk can feed:

- local user creation
- member-group governance
- downstream ACL and notification targeting

### 3. DingTalk group notifications

Supported:

- group destination management with webhook + optional secret
- test send
- automation action: `send_dingtalk_group_message`
- delivery history
- rule-level group delivery viewer

Current behavior:

- one rule targets one group destination
- one table can target multiple groups by using multiple rules
- destinations are manually registered; groups are not auto-imported from DingTalk

### 4. DingTalk person notifications

Supported:

- automation action: `send_dingtalk_person_message`
- recipient selection by local user
- DingTalk work-notification delivery after local user -> bound DingTalk identity resolution
- delivery history

Current model:

- you choose local users
- the system resolves their DingTalk bindings
- unbound users cannot receive DingTalk person delivery

### 5. Public forms and DingTalk-protected public forms

Supported access modes:

- `public`
- `dingtalk`
- `dingtalk_granted`

Meaning:

- `public`: anyone with the link can submit
- `dingtalk`: the visitor must sign in with DingTalk and be bound to a local user
- `dingtalk_granted`: the visitor must also hold an enabled DingTalk grant

Protected forms still use the existing create-only public-form model:

- public form = submit new data only
- public form != view the internal table
- public form != edit existing records

### 6. Protected public-form allowlists

Implemented in the current protected-public-form branch:

- `allowedUserIds`
- `allowedMemberGroupIds`

This enables the precise model:

- send a form link to a DingTalk group or DingTalk user
- only selected local users or local member groups can fill it
- DingTalk verifies identity, but local allowlists decide access

### 7. Internal processing links

Supported:

- internal deep links from notifications into multitable views and records

Behavior:

- users with local permissions can open and process
- users without local permission cannot use the internal link

This preserves the boundary:

- notification scope does not grant data access

## Access boundary rules

These rules are product-defining and should stay fixed.

### Rule 1: Notification is not authorization

Sending a message to:

- a DingTalk group
- a DingTalk user

does not grant permission to the underlying table or record.

### Rule 2: Public form is not internal table access

A public form link allows:

- create-only submission

It does not allow:

- opening the internal table
- browsing records
- editing an existing record

### Rule 3: DingTalk is not the primary authority subject

We do not authorize “raw DingTalk users” directly.

We authorize:

- local users
- local member groups

DingTalk is only:

- the sign-in identity proof
- the delivery channel

### Rule 4: Internal processing stays under local ACL

Internal links continue to respect:

- table permissions
- view permissions
- field permissions
- record permissions
- member-group ACL

## Recommended usage patterns

### Pattern A: Broadcast a fill request to a group

Use:

- `send_dingtalk_group_message`
- a public form view
- protected mode + allowlist when needed

Best for:

- data collection
- issue reporting
- request intake
- periodic status capture

### Pattern B: Send a handling request to specific people

Use:

- `send_dingtalk_person_message`
- an internal processing link

Best for:

- owners
- approvers
- operators
- delegated managers

### Pattern C: Notify a group, but allow only selected people to fill

Use:

- DingTalk group message
- protected public form
- `allowedUserIds` and/or `allowedMemberGroupIds`

This is the preferred implementation for:

- “the whole group sees the message, but only specific people can submit”

## Current limitations

### DingTalk groups

Not yet supported:

- auto-syncing DingTalk group rosters
- browsing a live DingTalk group list from OAuth

Currently supported:

- one rule can target multiple configured DingTalk group destinations
- one rule can also resolve DingTalk group destination IDs from record field paths
- authoring warns when record field paths point to user/member-group fields instead of group-destination ID fields

Current workaround for live DingTalk group discovery:

- manually register DingTalk robot webhook destinations per table

### Public-form precision beyond allowlists

Not yet supported as first-class authoring:

- assign one row to one user
- assign one field set to one user
- assign a single cell to one user

Recommended future direction:

- row ownership
- field-level assignees
- avoid generalized cell-level ACL as the first model

### Group destination sharing

Current destination management is still closer to creator-scoped configuration than a fully shared organization-wide destination catalog.

Recommended future direction:

- organization/shared destination governance

## Near-term roadmap

Recommended next steps after the current branch chain lands:

1. merge and deploy the current dynamic destination and form-link guardrail slices
2. add shared/group-governed DingTalk destinations
3. add row/field-level fill assignment
4. add richer notification governance such as approval-oriented presets and review templates

## Summary

MetaSheet’s DingTalk integration is already sufficient for the practical flow:

- table trigger
- DingTalk group or person message
- click public form link
- DingTalk identity verification
- local user/member-group access decision
- successful submission

The remaining work is mostly governance refinement, not foundational capability.

# DingTalk Admin Operations Guide

- Date: 2026-04-20
- Audience: table owners, workspace admins, operations admins

## Scope

This guide explains the management-side UI flow for:

- configuring DingTalk group delivery
- configuring DingTalk person delivery
- configuring table-triggered automation
- configuring public form sharing
- using protected public-form modes and allowlists

It does not cover end-user filling behavior beyond the links they receive.

## Quick entry

- Send a table-triggered message to a DingTalk group: see [C. Configure a DingTalk group notification rule](#c-configure-a-dingtalk-group-notification-rule).
- Send a form link that users can fill: see [D. Configure a public form](#d-configure-a-public-form).
- Send to a DingTalk group while only selected local users or member groups can fill: see [E. Configure protected public-form allowlists](#e-configure-protected-public-form-allowlists) and [Scenario 2](#scenario-2-broadcast-to-a-group-but-only-selected-users-can-fill).

## Before you start

You need all of the following:

- access to the target table
- permission to manage automation or form sharing on that table
- a DingTalk group robot webhook if you want group delivery
- DingTalk-bound local users if you want person delivery or DingTalk-protected public forms

## A. Configure a DingTalk group destination

Management-side UI path:

1. Open the target table.
2. Open `API Tokens / Webhooks / DingTalk Groups`.
3. Go to the `DingTalk Groups` tab.
4. Create a destination with:
   - group name
   - webhook URL
   - optional secret
   - enabled state
5. Use `Test send` to verify delivery.

Notes:

- this is a management-side page, not a normal end-user page
- the current model manually registers a group webhook; it does not auto-import your DingTalk groups

## B. Configure a DingTalk person notification rule

Management-side UI path:

1. Open the table’s automation area.
2. Create or edit a rule.
3. Choose action `Send DingTalk person message`.
4. Search and add local users.
5. Configure:
   - title template
   - body template
   - optional public form view
   - optional internal processing view
6. Save the rule.

Notes:

- recipients are selected as local users, not raw DingTalk user IDs
- the selected local users must be bound to DingTalk to receive person delivery

## C. Configure a DingTalk group notification rule

Management-side UI path:

1. Open the table’s automation area.
2. Create or edit a rule.
3. Choose action `Send DingTalk group message`.
4. Choose one or more configured DingTalk group destinations.
5. Configure:
   - title template
   - body template
   - optional public form view
   - optional internal processing view
6. Save the rule.

Dynamic routing:

- a rule can combine manually selected group destinations and record field paths
- record field paths must resolve to DingTalk group destination IDs
- the editor warns if a selected record field is a user/member-group field instead of a group-destination ID field

## D. Configure a public form

Management-side UI path:

1. Open the table.
2. Open the form share manager.
3. Enable public form sharing.
4. Choose or confirm the public form view.
5. Copy the generated public form link or let automation include it in a DingTalk message.

Automation authoring guardrail:

- if a selected public form view is not shared, has no public token, or has expired, the automation editor warns and disables save
- if a selected internal processing view is no longer in the current sheet, the automation editor warns and disables save
- if a DingTalk group rule links to a fully public form, the automation editor warns that anyone with the message link can submit
- if a DingTalk group rule links to a DingTalk-protected form without allowed users or member groups, the editor warns that all bound or authorized DingTalk users can submit
- the message summary and rule card show `Public form access`, including fully public, bound DingTalk users, authorized DingTalk users, and allowlist-constrained states
- the message summary and rule card also show `Allowed audience`, derived from local allowlist users/member groups when the form is DingTalk-protected
- the warning is advisory; runtime delivery still performs the backend validation before sending the link
- runtime DingTalk messages include `表单访问` and `允许范围` lines below the public form fill link, so recipients can see the access mode before opening the form
- runtime DingTalk messages include `处理权限` below internal processing links, so group recipients know the link still requires system login and table/view permission
- automation create/update APIs reject invalid public form or internal processing links before saving
- runtime delivery refuses non-form public views and expired public-form shares before sending DingTalk messages
- runtime delivery refuses missing internal processing views before sending DingTalk messages

Supported access modes:

- `Anyone with the link`
- `Bound DingTalk users only`
- `Authorized DingTalk users only`

Meaning:

- `Anyone with the link`: open submission
- `Bound DingTalk users only`: DingTalk sign-in + bound local user required
- `Authorized DingTalk users only`: DingTalk sign-in + bound local user + enabled DingTalk grant required

## E. Configure protected public-form allowlists

This is the management flow for “send to a DingTalk group, but only selected people can fill”.

Management-side UI path:

1. Open the table’s form share manager.
2. Enable sharing.
3. Set access mode to:
   - `Bound DingTalk users only`, or
   - `Authorized DingTalk users only`
4. Use the allowlist area to search and add:
   - local users
   - local member groups
5. Save the allowlist.

Behavior:

- the visitor must pass the selected DingTalk protection mode first
- the system then resolves the local user
- the local user must be directly allowed or belong to an allowed member group
- without an allowlist, `Bound DingTalk users only` admits all bound DingTalk local users and `Authorized DingTalk users only` admits all locally authorized DingTalk users
- the form share manager shows `Local allowlist limits` so owners can confirm whether no local limit is set or how many local users/member groups can fill after DingTalk checks
- the automation editor and rule cards show the same local allowlist audience as `Allowed audience`, so authors can verify it without reopening the form share manager
- the actual DingTalk message uses the same access-mode and local allowlist data in its runtime `允许范围` text

Important rule:

- if an allowlist is configured, do not switch back to fully public until the allowlist is cleared

## F. Choose between public form and internal link

Use a public form link when you want:

- new submissions
- create-only intake
- group-wide data collection

Use an internal processing link when you want:

- owners or operators to open an existing record
- approvers to handle a task
- users with local permission to review or edit existing data

Remember:

- public form link != internal table access
- internal link still obeys local ACL
- DingTalk recipients without local access can see the message but cannot use the internal processing link to open the table/view

## G. Delivery history and troubleshooting

### Group delivery

You can inspect:

- destination-level delivery history
- rule-level group delivery history

Use this when checking:

- webhook signature issues
- keyword blocking from DingTalk robots
- wrong destination selection
- repeated failures from the same rule

### Person delivery

You can inspect person delivery history from the automation management UI.

Use this when checking:

- recipient is not bound to DingTalk
- recipient selection is wrong
- template or target link is wrong

## H. Common operating scenarios

### Scenario 1: Broadcast a fill request to a group

Use:

- DingTalk group rule
- public form link
- open access or protected access depending on sensitivity

### Scenario 2: Broadcast to a group, but only selected users can fill

Use:

- DingTalk group rule
- protected public form
- allowlist of local users or member groups

Authoring guardrail:

- if the selected form is still fully public, the DingTalk group rule editor warns before save
- if the selected protected form has no allowed users or member groups, the DingTalk group rule editor warns before save
- check `Public form access` and `Allowed audience` in the automation message summary, plus `Local allowlist limits` in form sharing before saving
- switch the form to `Bound DingTalk users only` or `Authorized DingTalk users only` before relying on allowlists

### Scenario 3: Notify specific staff only

Use:

- DingTalk person rule
- selected local users
- public form link or internal processing link

### Scenario 4: Multi-group routing from one table

Use:

- one rule with multiple configured DingTalk groups
- optional record group field paths when each row should choose one or more group destinations dynamically

## I. What ordinary users see

Ordinary users do not manage:

- group destinations
- automation rules
- form-share security modes

Ordinary users only:

- receive DingTalk messages
- open public form links
- or open internal processing links if they already have local permission

## J. Current limitations

Current gaps to be aware of:

- DingTalk group roster is not auto-imported
- row/field-specific fill assignment is not yet first-class
- precise protected-form allowlists depend on local user/member-group governance, not raw DingTalk identities
- `Allowed audience` and `Local allowlist limits` are derived from local allowlist users/groups; they do not infer or sync DingTalk group members

## K. Operational recommendations

Recommended default policy:

1. use DingTalk group delivery for broad broadcast
2. use DingTalk person delivery for exact handling
3. use protected public forms for any sensitive intake
4. use local allowlists when a group message should only be fillable by selected people
5. use internal links only for users who should already have local table access

## Summary

The current management-side UI already supports the practical operating loop:

- configure DingTalk destination
- configure automation rule
- attach public or internal link
- protect the form with DingTalk if needed
- narrow the allowed fillers to selected local users/member groups when required

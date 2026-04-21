# DingTalk Automation Create Editor Entry Development Notes

Date: 2026-04-21

## Scope

This change makes the primary automation creation entry open the advanced `MetaAutomationRuleEditor`.

Affected paths:

- `apps/web/src/multitable/components/MetaAutomationManager.vue`
- `apps/web/tests/multitable-automation-manager.spec.ts`

## Problem

Automation editing already uses the advanced rule editor, which supports:

- Rich triggers.
- Conditions.
- Multi-step actions.
- DingTalk group messages.
- DingTalk person messages.
- Public form links.
- Internal processing links.

The primary `+ New Automation` entry still opened the older inline quick form, so users could only discover the full DingTalk automation workflow after creating or editing an existing rule.

## Implementation

The automation manager now renders two creation entries:

- Primary `+ New Automation`: opens `MetaAutomationRuleEditor`.
- Secondary `Quick legacy form`: keeps the existing inline form available for compatibility.

The old inline form remains in place to reduce risk and preserve existing quick-form tests. A follow-up can remove it once the advanced editor is the only supported creation path.

## Behavior

Users who click `+ New Automation` now start in the same advanced editor used for edits. This makes DingTalk group/person notification configuration, form links, and internal processing links available immediately during creation.

Existing quick-form behavior remains accessible through the secondary button.

## Main-target delivery note

The source branch for this change was stacked on a non-`main` base. For final delivery, the single create-entry commit was cherry-picked onto `main` after the preceding DingTalk service validation work landed, so the PR contains only the automation manager entry-point change and its focused tests/docs.

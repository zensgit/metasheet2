# DingTalk Automation Action Config Validation Development Notes

Date: 2026-04-21

## Scope

This change adds backend write-time validation for DingTalk automation action configs.

Affected areas:

- `POST /api/multitable/sheets/:sheetId/automations`
- `PATCH /api/multitable/sheets/:sheetId/automations/:ruleId`
- Legacy `actionType/actionConfig`
- V1 `actions[]`

## Problem

The automation routes already validate DingTalk public-form and internal-view links before persistence, but they did not validate the basic executable DingTalk action config. A caller could bypass the frontend and persist a rule missing effective destinations, recipients, title templates, or body templates.

Runtime execution would fail later, but the invalid rule was already stored.

## Implementation

Added synchronous DingTalk config validation in `dingtalk-automation-link-validation.ts`:

- Group message actions require at least one effective static destination or record destination field path.
- Person message actions require at least one effective recipient source: static user IDs, member group IDs, record user field paths, or record member-group field paths.
- Both DingTalk actions require executable `titleTemplate` and `bodyTemplate`.
- Empty separator-only values like `,` or `record.` are parsed as empty.

For compatibility with older callers, DingTalk configs with `title/content` are normalized to `titleTemplate/bodyTemplate` before validation and persistence.

The create/update routes now validate normalized DingTalk configs before existing link validation and before calling the automation service.

## Notes

Enable-only PATCH requests still avoid revalidating DingTalk config and links, preserving the existing behavior for toggling a rule without loading related view state.

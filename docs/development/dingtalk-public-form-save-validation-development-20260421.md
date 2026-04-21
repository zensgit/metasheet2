# DingTalk Public Form Save Validation Development 2026-04-21

## Scope

This change moves DingTalk public form link validation into the back-end automation save path. Front-end and runtime guardrails already existed; create/update APIs now reject invalid `publicFormViewId` values before rules are persisted.

## Changes

- Added `packages/core-backend/src/multitable/dingtalk-automation-link-validation.ts`.
- The helper scans both legacy single-action payloads and V1 `actions[]`.
- Back-end save validation now rejects DingTalk group/person automation links when:
  - the public form view is missing from the target sheet
  - the selected view is not a `form` view
  - public form sharing is disabled or not configured
  - `publicToken` is missing or blank
  - `expiresAt` or `expiresOn` is expired
- Existing internal processing link validation now uses the same helper.
- `univer-meta.ts` uses the shared helper for `POST /sheets/:sheetId/automations` and `PATCH /sheets/:sheetId/automations/:ruleId`.
- Front-end public form selectors now filter to current-sheet form views, matching the back-end same-sheet save rule.

## Design Notes

- Fully public links remain allowed at save time; they are still surfaced as advisory warnings in the group-message UI.
- DingTalk-protected public forms with or without allowlists remain allowed at save time; allowlist absence remains an advisory risk warning.
- Runtime delivery validation remains in place as the final enforcement layer.
- The automation payload schema is unchanged.

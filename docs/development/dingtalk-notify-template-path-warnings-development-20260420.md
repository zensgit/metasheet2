# DingTalk Notify Template Path Warnings Development 2026-04-20

## Goal

Extend DingTalk notification template linting from syntax-only checks to path-aware checks so admins get warned when a placeholder is well-formed but still unknown or incomplete.

## Scope

- Frontend only
- No backend/API changes
- No migration changes

## Changes

### Path-aware linting

Updated:

- `apps/web/src/multitable/utils/dingtalkNotificationTemplateLint.ts`

Added:

- known token allow-list:
  - `recordId`
  - `sheetId`
  - `actorId`
- record path rule:
  - allow `record.<fieldName>`
  - reject incomplete or malformed paths such as `record`, `record.`, or `record..name`

New warning shape:

- `Unknown placeholder {{...}}. Use {{recordId}}, {{sheetId}}, {{actorId}}, or {{record.fieldName}}.`

### Existing authoring surfaces

No new UI surface was introduced. The new warning is surfaced through the existing warning areas in:

- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/src/multitable/components/MetaAutomationManager.vue`

### Tests

Updated:

- `apps/web/tests/multitable-automation-rule-editor.spec.ts`
- `apps/web/tests/multitable-automation-manager.spec.ts`

Added focused coverage for:

- typo placeholder: `{{recoredId}}`
- incomplete record path: `{{record}}`

## Claude Code CLI

This slice was selected after a read-only `claude -p` suggestion pass. The implementation itself remained local in the repo worktree.

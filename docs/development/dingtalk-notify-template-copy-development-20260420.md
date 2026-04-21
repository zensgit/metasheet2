# DingTalk Notify Template Copy Development 2026-04-20

## Goal

Add one-click copy actions for rendered DingTalk notification examples so admins can quickly reuse the rendered title/body text while authoring automation rules.

## Scope

- Frontend only
- No backend/API changes
- No migration changes

## Changes

### Rule editor

Updated:

- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`

Changes:

- rendered title/body lines now include `Copy` actions
- copy buttons switch to `Copied` after successful clipboard writes
- applies to:
  - `send_dingtalk_group_message`
  - `send_dingtalk_person_message`

### Inline automation manager

Updated:

- `apps/web/src/multitable/components/MetaAutomationManager.vue`

Changes:

- inline rendered examples now include the same `Copy` action pattern
- copy state is local to the current authoring surface

### Styling

Added small preview-line and copy-button styles to keep rendered examples readable while preserving the existing summary card layout.

### Tests

Updated:

- `apps/web/tests/multitable-automation-rule-editor.spec.ts`
- `apps/web/tests/multitable-automation-manager.spec.ts`

New coverage verifies clipboard writes for rendered DingTalk examples in both authoring surfaces.

## Claude Code CLI

Used `claude -p` as a read-only assist to choose the next smallest high-value frontend-only slice. The implementation itself remained local in this repo worktree.

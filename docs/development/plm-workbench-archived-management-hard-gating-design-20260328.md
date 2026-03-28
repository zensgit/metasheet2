# PLM Workbench Archived Management Hard Gating Design

## Context

Several PLM collaborative handlers already treated archived entries as restore-first:

- share
- rename
- transfer owner
- set default
- clear default

But shared actionability helpers still allowed explicit permissions like `canShare: true` or `canRename: true` to leak through for archived entries. That created a UI/runtime split: controls could remain enabled even though the handler would immediately reject the action.

## Problem

- Archived entries could still look manageable in button/input state.
- The drift came from shared helpers, not from any single screen.
- Explicit permission flags were overriding archived restore-first semantics.

## Decision

Make archived state a hard blocker in shared management helpers for:

1. `canSharePlmCollaborativeEntry(...)`
2. `canRenamePlmCollaborativeEntry(...)`
3. `canSetDefaultPlmCollaborativeEntry(...)`
4. `canTransferTarget`
5. `canClearDefault`

`delete` and `duplicate` are intentionally left alone because they do not share the same restore-first contract.

## Expected Result

- Archived entries no longer expose share/rename/transfer/default controls as enabled.
- Button state and handler state match across team views and team presets.
- Explicit permission flags can no longer bypass archived restore-first gating for management actions.

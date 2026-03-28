# PLM Workbench No-op Actionability Hard Gating Design

## Background

`usePlmCollaborativePermissions.ts` already hard-blocked archived entries for apply/share/rename/transfer/default-management in several places, but four toggles still trusted stale explicit permission bits too much:

- `archive`
- `restore`
- `set default`
- `clear default`

That left two kinds of no-op drift:

- archived entries could still look archivable
- non-archived entries could still look restorable
- already-default entries could still look set-default-able
- non-default entries could still look clear-default-able

## Decision

Promote entry state to a hard gate before explicit permission flags for those no-op-sensitive actions.

## Scope

- `canArchive`: false when `isArchived`
- `canRestore`: false when `!isArchived`
- `canSetDefaultPlmCollaborativeEntry`: false when `isArchived || isDefault`
- `canClearDefault`: false when `isArchived || !isDefault`

## Why

These actions are state transitions, not just capability checks. Even if a stale payload says the capability bit is true, a no-op target should not stay actionable.

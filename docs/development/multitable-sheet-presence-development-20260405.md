# Multitable Sheet Presence Development Report

Date: 2026-04-05
Branch: `codex/multitable-sheet-presence-20260405`

## Scope

This slice adds sheet-level active collaborator presence to the multitable workbench.

The goal is to surface when other users are actively viewing the same sheet, without changing the existing comment inbox, comment realtime, or sheet operation realtime semantics.

## Runtime Changes

### Backend sheet presence broadcasts

Updated `/packages/core-backend/src/services/CollabService.ts` so sheet room joins and leaves now maintain a deduplicated active-user map per sheet room.

The websocket layer now broadcasts:

- `sheet:presence`

Payload:

- `sheetId`
- `activeCount`
- `users: [{ id }]`

The implementation deduplicates multiple sockets from the same user, so separate sheet/comment/presence websocket connections do not inflate collaborator counts.

### Frontend sheet presence composable

Added `/apps/web/src/multitable/composables/useMultitableSheetPresence.ts`.

This composable:

- joins the current `join-sheet` room
- listens for `sheet:presence`
- tracks the current sheet presence summary
- excludes the current user when computing visible collaborator count

### Workbench presence chip

Updated `/apps/web/src/multitable/views/MultitableWorkbench.vue` to show a presence chip in the action bar when other active collaborators exist on the current sheet.

The chip displays:

- collaborator count
- singular/plural label
- user ids in the hover title as a minimal first-pass summary

### Frontend type support

Updated `/apps/web/src/multitable/types.ts` with:

- `MultitableSheetPresenceUser`
- `MultitableSheetPresence`

## Test Updates

Updated:

- `/packages/core-backend/tests/integration/rooms.basic.test.ts`
- `/apps/web/tests/multitable-sheet-presence.spec.ts`
- `/apps/web/tests/multitable-workbench-view.spec.ts`

These now verify:

- `join-sheet` presence broadcasts are deduplicated by user id
- current user is excluded from displayed collaborator count
- the workbench shows the presence chip only when other active collaborators exist

# Yjs Awareness Presence Development

Date: 2026-04-16
Branch: `codex/yjs-awareness-presence-20260415`

## Scope

Follow up on the merged Yjs record-level POC with a minimal awareness/presence layer:

- record-level presence snapshots on `/yjs`
- field-level active editor hints for the current text field
- reusable frontend awareness state for future rollout
- a minimal presentation chip, without wiring it into the main workbench yet

## Backend changes

Updated [packages/core-backend/src/collab/yjs-websocket-adapter.ts](/tmp/metasheet2-yjs-awareness/packages/core-backend/src/collab/yjs-websocket-adapter.ts:1):

- added `yjs:presence` socket event
- track per-record socket presence as `recordId -> socketId -> { userId, fieldId }`
- emit deduplicated `yjs:presence` snapshots back to the room
- clean up cached presence on `unsubscribe` and `disconnect`
- expose minimal metrics for active docs/sockets

Added backend test coverage in [packages/core-backend/tests/unit/yjs-awareness.test.ts](/tmp/metasheet2-yjs-awareness/packages/core-backend/tests/unit/yjs-awareness.test.ts:1) for:

- record presence publication
- field-level presence updates
- unsubscribe cleanup
- unsubscribed presence rejection

## Frontend changes

Updated [apps/web/src/multitable/composables/useYjsDocument.ts](/tmp/metasheet2-yjs-awareness/apps/web/src/multitable/composables/useYjsDocument.ts:1):

- track `presence`
- expose `activeUsers`, `activeCollaborators`, `activeCollaboratorCount`
- expose `getFieldCollaborators(fieldId)`
- expose `setActiveField(fieldId | null)` to publish field focus over `/yjs`
- load `currentUserId` and filter self out of collaborator summaries

Updated [apps/web/src/multitable/composables/useYjsTextField.ts](/tmp/metasheet2-yjs-awareness/apps/web/src/multitable/composables/useYjsTextField.ts:1):

- optional `setActiveField()` integration
- marks the field as active when bound
- clears active field on cleanup

Added [apps/web/src/multitable/components/MetaYjsPresenceChip.vue](/tmp/metasheet2-yjs-awareness/apps/web/src/multitable/components/MetaYjsPresenceChip.vue:1):

- compact collaborator chip
- optional field filter
- excludes current user when provided

Updated [apps/web/src/multitable/index.ts](/tmp/metasheet2-yjs-awareness/apps/web/src/multitable/index.ts:1) to export:

- `useYjsDocument`
- `useYjsTextField`
- `MetaYjsPresenceChip`

Added frontend test coverage in [apps/web/tests/yjs-awareness-presence.spec.ts](/tmp/metasheet2-yjs-awareness/apps/web/tests/yjs-awareness-presence.spec.ts:1) for:

- presence snapshot consumption
- self filtering
- field collaborator filtering
- active field emission
- chip rendering

## Notes

- This change intentionally does not wire awareness UI into the main multitable workbench yet.
- It stays within the Yjs POC boundary: single-record collaboration with text-field awareness hints.

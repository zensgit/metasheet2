# Plugin Permission Model

This document explains how plugin permissions are declared, validated, and used in MetaSheet v2.

## Overview
- Plugins declare permissions in `plugin.json` under `permissions: []`.
- The backend validates against a whitelist; unknown entries fail with `PLUGIN_004`.
- Runtime access is still controlled by `CoreAPI` and any RBAC present.

## Whitelist (server-side)
- Source: `packages/core-backend/src/types/plugin.ts` (`PERMISSION_WHITELIST`)
- Categories:
  - Database: `database.read`, `database.write`
  - HTTP: `http.addRoute`
  - WebSocket: `websocket.broadcast`, `websocket.join`, `websocket.leave`, `websocket.broadcastTo`, `websocket.sendTo`
  - Events: `events.emit`, `events.on`, `events.once`, `events.off`
  - File/Storage: `file.read`, `file.write`, `file.delete`
  - Cache: `cache.read`, `cache.write`, `cache.delete`, `cache.clear`
  - Queue: `queue.push`, `queue.process`, `queue.cancel`

## Permission Groups (for build-time convenience)
- Source: `packages/core-backend/src/types/plugin.ts` (`PERMISSION_GROUPS`)
- Groups:
  - `readonly`: minimal read/observe (database.read, file.read)
  - `basic`: typical utility plugins (+ events.emit, notification.send)
  - `standard`: common business plugins (+ write, http, websocket, queue)
  - `advanced`: elevated capabilities (includes database.*, http.request)
- Note: plugin.json must list explicit permissions; groups are for TypeScript/build tooling to expand.

### Group Usage Example
```typescript
import { PERMISSION_GROUPS } from '@metasheet/core-backend'

// Development reference
const manifest = {
  name: "my-plugin",
  permissions: [...PERMISSION_GROUPS.standard]
}
// Build tool expands to: ["database.read", "database.write", ...]
```

## Validation
- Location: `packages/core-backend/src/core/plugin-loader.ts` (`checkPermissions`)
- Behavior: non-whitelisted permission → throw `PLUGIN_004` (Permission denied)

## How to request new permissions
- Prefer the least-privilege option; justify the need.
- Add the permission to `PERMISSION_WHITELIST`, include tests, and update this doc.
- Example PR checklist:
  - [ ] Add to whitelist constants
  - [ ] Add acceptance test
  - [ ] Update docs/permissions.md
  - [ ] Note risk/rollback in PR description

## Examples
```json
{
  "name": "@metasheet/plugin-example",
  "version": "1.0.0",
  "engines": { "metasheet": ">=2.0.0" },
  "permissions": [
    "database.read",
    "events.emit",
    "websocket.broadcast"
  ]
}
```

## Notes
- Permissions are not RBAC roles; they allow calling specific `CoreAPI` surfaces.
- Sensitive operations should still enforce user-level authorization.

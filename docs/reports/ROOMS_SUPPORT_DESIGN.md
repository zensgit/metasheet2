# Socket.IO Rooms Support — Design Summary

## Goals
- Provide scoped realtime via rooms with minimal API surface.
- Keep default behavior unchanged; additive and backward-compatible.

## API
- `websocket.join(room, { userId? | socketId? })`
- `websocket.leave(room, { userId? | socketId? })`
- `websocket.broadcastTo(room, event, data)`

Notes:
- Room name length ≤ 128; allowed chars `[a-zA-Z0-9:_-]` (enforced loosely in v1).
- Selector must specify exactly one: `userId` or `socketId`.

## Permissions
- Whitelist additions: `websocket.join`, `websocket.leave`, `websocket.broadcastTo`.
- Guarded by existing plugin-context permission checks.

## Server Behavior
- On `connection`, if `?userId=alice` is present in query (dev/test), socket joins room `alice`.
- `join/leave` operate on either a user’s sockets or a single socket.
- `broadcastTo` emits to targeted room only.

## Testing
- Integration: two clients (user a/b), join a to room, broadcast, assert only a receives; leave then assert none.
- Sandbox: reuse preflight listen guard to skip tests in environments without listen permission; CI runs full.

## Future Work
- Namespacing helper `makeRoom(pluginName, local)` to avoid collisions.
- Rate limiting, max rooms per user/socket.
- Redis adapter for multi-node.

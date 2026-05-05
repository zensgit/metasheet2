# Multitable Yjs Contract Development

- Date: 2026-05-05
- Branch: `codex/multitable-yjs-contract-20260505`
- Scope: realtime contract documentation and parity guard for `/yjs`

## Context

The multitable REST contract is covered by OpenAPI, but the record-level Yjs collaboration channel uses Socket.IO on the `/yjs` namespace. That event surface was documented in design notes and tests, but it did not have a small machine-readable contract artifact or a release gate that catches accidental event-name drift.

This is intentionally separate from OpenAPI because the API is event-based:

- Socket.IO namespace: `/yjs`
- Handshake auth: `auth.token` JWT
- Client events: `yjs:subscribe`, `yjs:message`, `yjs:update`, `yjs:presence`, `yjs:unsubscribe`
- Server events: `yjs:message`, `yjs:update`, `yjs:presence`, `yjs:error`, `yjs:invalidated`

## Implementation

Added `docs/api/multitable-yjs-events.asyncapi.json` as a compact AsyncAPI-style contract for the Socket.IO namespace.

Added `scripts/ops/multitable-yjs-contract-parity.test.mjs`, a dependency-free Node test that checks:

- the contract declares `/yjs` as a Socket.IO namespace;
- client and server event names match the backend adapter;
- frontend `useYjsDocument` connects to `/yjs`, emits client events, and handles server events;
- the error-code set stays `UNAUTHENTICATED`, `NOT_FOUND`, `FORBIDDEN`;
- `yjs:invalidated` preserves the `rest-write` reason;
- presence payloads keep `recordId`, `activeCount`, and `users`.

Added root script:

```bash
pnpm verify:multitable-yjs:contract
```

## Non-goals

- No runtime behavior changes.
- No OpenAPI changes; this is not an HTTP contract.
- No generated SDK changes.


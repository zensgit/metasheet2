feat(core): wire Socket.IO Redis adapter (flagged)

Summary
- Wire optional Socket.IO Redis adapter for rooms fanout behind env flag.
- Default remains local adapter; no behavior change unless enabled.

Scope
- Env: `WS_REDIS_ENABLED=true`, `WS_REDIS_URL=redis://127.0.0.1:6379` (default).
- When enabled: init `@socket.io/redis-adapter`, set health: `wsAdapter: 'redis'`, `redis: { enabled: true, attached: true }`.
- Metrics/logs: connect/ready/error counters; info logs on attach/detach.

Testing
- Unit: adapter init success/failure via mocked redis clients.
- Integration (flagged): start core with `WS_REDIS_ENABLED=true` and assert health shows redis attached.

Rollout
- Phase 1: visibility only (merged via PR #116).
- Phase 2: adapter wiring (this PR).
- Phase 3: perf/soak tests and fallback validation.

Risks
- Redis availability in CI. Mitigate with flag off by default and conditional/spec-tagged tests.

Notes
- No client API changes; rooms APIs already present: `join`, `leave`, `broadcastTo`.

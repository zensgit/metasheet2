# PR #89 Merge Checklist — WebSocket Event Tests Fix

- CI status: All checks green (unit + integration + lint).
- Integration: WebSocket event test waits for connect; no flakiness observed.
- Observability (V2 Strict): P99 < 0.1s remains true.
- API contract: `/api/plugins` unchanged; no breaking changes.
- Server lifecycle: `stop()` cleanly closes Socket.IO then HTTP.
- Logs: Console replaced with structured logger (debug/error).
- Local smoke: `pnpm -F @metasheet/core-backend test:integration` passes.
- Optional: rerun strict workflow manually after merge.

Notes: This PR is test-focused and operationally safe; no prod behavior change expected.


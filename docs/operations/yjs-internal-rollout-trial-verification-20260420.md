# Yjs Internal Rollout Trial — Verification Report

Date: 2026-04-20
Environment: `http://142.171.239.56` (internal staging)
Trial window: 2026-04-20T08:31:46Z → 08:46:21Z (~10 minutes wall clock)
Executor: Claude (automation) + 1 human operator

---

## 1. Executive Summary

| Layer | Status |
|---|---|
| Backend `/yjs` namespace | ✅ Enabled, initialized, healthy |
| Backend status endpoint (`/api/admin/yjs/status`) | ✅ Reachable via admin token |
| Backend auth gate + persistence + bridge | ✅ Ready (per code audit + unit tests) |
| Admin monitoring + ops scripts | ✅ Working |
| **Frontend record editor → `/yjs` connection** | ❌ **Not wired** |
| **Real browser two-user collaboration** | ❌ **Not validated** |

**Honest conclusion**: the Yjs stack is fully ready on the server, but the frontend editor has never been wired to consume it. During a 10-minute human editing trial, zero Yjs activity was observed on the backend — confirming that user edits in the browser continue to go through the legacy REST path, not Yjs.

This matches the deliberate scope decision in earlier reviews: `MetaYjsPresenceChip` was built as a building block and left **not wired** into the actual record editor.

---

## 2. What Was Verified

### 2.1 Backend readiness

```bash
$ YJS_BASE_URL=http://142.171.239.56:8081 \
  YJS_ADMIN_TOKEN=<admin-token> \
  node scripts/ops/check-yjs-rollout-status.mjs

Yjs rollout status: HEALTHY
Enabled: true
Initialized: true
Active docs: 0
Pending writes: 0
Flush successes: 0
Flush failures: 0
Active records: 0
Active sockets: 0
```

### 2.2 Admin token + API access

- JWT verifier accepted the admin token
- `/api/admin/yjs/status` returned structured response with sync/bridge/socket sub-objects
- Poll at 3-second interval completed without auth errors (only 2 transient errors out of 200 requests)

### 2.3 Infrastructure access paths

| Path | Status |
|---|---|
| Frontend UI | `http://142.171.239.56:8082/` ✅ |
| Backend direct | `http://142.171.239.56:8081/api/*` ✅ |
| Port 80 (reverse proxy) | ⚠️ Empty reply — known issue, unrelated to Yjs |

---

## 3. What Was NOT Verified

### 3.1 Polling evidence

Over 10 minutes with 1 human actively opening, editing text fields, and closing records:

```
Total samples: 200 (3-second interval)
Duration: 2026-04-20T08:31:46Z → 08:46:21Z

All samples:
  activeDocCount    = 0  (never moved)
  activeSocketCount = 0  (never moved)
  flushSuccessCount = 0  (never moved)
  flushFailureCount = 0  (never moved)
  observedDocCount  = 0  (never moved)
  pendingWriteCount = 0  (never moved)
```

Not a single metric moved off zero during real user editing. Confirms no Yjs client connected to `/yjs`.

### 3.2 Code audit

```bash
$ grep -rn "useYjsDocument\|useYjsTextField" apps/web/src/ --include="*.vue" --include="*.ts"
apps/web/src/multitable/composables/useYjsDocument.ts:41:export function useYjsDocument(...)
apps/web/src/multitable/composables/useYjsTextField.ts:13:export function useYjsTextField(...)
apps/web/src/multitable/index.ts:11:export { useYjsDocument } ...
apps/web/src/multitable/index.ts:12:export { useYjsTextField } ...
```

The Vue composables are **defined and exported**, but **zero components import or call them**. No Vue component invokes `useYjsDocument()`, which means no socket connection to `/yjs` is ever established from the frontend.

### 3.3 Consequence

The claim "Yjs collaborative editing is working end-to-end" is **not supported by evidence**. What IS supported:

- Backend accepts Yjs connections when they come
- Admin can observe metrics
- Docs, scripts, tests are in place
- Unit tests validate backend logic in isolation

What is NOT supported:

- Two users editing the same text field → character-level merge (untested in browser)
- Disconnect/reconnect recovery (untested in browser)
- Real Presence UI showing who is editing (untested in browser)

---

## 4. Alternative Paths to Close the Validation Gap

### Option A — Node.js Yjs client (30-45 min, recommended next)

Write a Node.js script that:
- Authenticates as a real user
- Connects to `/yjs` namespace via Socket.IO
- Creates a Y.Doc, subscribes to a record
- Makes text edits via Y.Text

This proves the backend pipeline actually works end-to-end when a Yjs client shows up. It does NOT validate the frontend UX, but it removes uncertainty about the server side.

### Option B — Wire Yjs into record editor (half-day to day)

Make the actual `MetaGridTable` / record edit flow use `useYjsTextField` for `text` fields. This is a product-visible change and should go through:
- Design review (which text fields, which editors)
- Opt-in gating (Yjs still gated by a feature check, not auto-on for all text fields)
- Parallel run with REST path
- New tests for the integration

### Option C — Defer

Record the current state, leave Yjs at "backend ready, frontend opt-in pending", return to next-phase-backlog.

---

## 5. Recommendation

1. Accept this report as the current state of record. Do not claim end-to-end validation.
2. Run Option A as a **low-cost sanity proof** that the backend plumbing actually carries Yjs traffic as designed.
3. Treat Option B as a **separate product decision** — not a verification task. If/when the team decides to wire the editor, it should own its own review cycle.

---

## 6. Artifacts

- Baseline snapshot: `output/yjs-rollout/trial-20260420/monitoring/t0-before.json`
- Full poll log (200 samples): `output/yjs-rollout/trial-20260420/monitoring/poll-log.ndjson`
- Trial start marker: `output/yjs-rollout/trial-20260420/trial-start.txt`

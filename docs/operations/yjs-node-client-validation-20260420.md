# Yjs Node.js Client Validation — Development & Verification Report

Date: 2026-04-20
Environment: `http://142.171.239.56:8081` (internal staging, backend direct)
Executor: Claude (automation)

## 1. Goal

After the browser-based trial (see `yjs-internal-rollout-trial-verification-20260420.md`) confirmed the frontend editor is NOT wired to Yjs, this run validates the **backend Yjs pipeline in isolation** by running a Node.js client that behaves like a browser user (connect → subscribe → edit Y.Text → observe bridge flush → observe DB patch).

This answers the question: *"If a Yjs client shows up, does the backend actually do what it says on the tin?"*

## 2. What Was Built

### 2.1 Validation script

Path: `scripts/ops/yjs-client-validation/yjs-node-client.mjs`

Does 5 checks:

1. Pre-test: fetch baseline `/api/admin/yjs/status`
2. Pre-test: fetch current record state via `GET /api/multitable/records/:id`
3. Connect to `/yjs` Socket.IO namespace using JWT `auth.token`, subscribe to a record
4. Inject Y.Text edit on the subscribed record, wait 3s for bridge flush
5. Fetch record again and compare: did `meta_records` reflect the Y.Text change?

### 2.2 Dependencies reused

- `yjs@13.6.24` (already in core-backend)
- `y-protocols@1.0.6` (already in core-backend)
- `socket.io-client@4.6.1` (already in web)
- `lib0` (transitive)

No new deps installed.

## 3. Results

### 3.1 Run 1 — cold start, all green

```
Pre-test status:
  activeDocCount:     0
  flushSuccess:       0
  flushFailure:       0
Record pre-title:     "PilotFlow-1775551908070 retry"

After subscribe + insert:
  activeDocCount:     1   ← Yjs accepted connection, created doc
  activeSocketCount:  1   ← socket tracked
  inserted:           "YJS-NODE-08:57:46"

After 3s wait (bridge flush):
  flushSuccess:       1   ← bridge triggered
  flushFailure:       0
  pendingWrites:      0

Record post-title:    "YJS-NODE-08:57:46"  ✅ bridge wrote to meta_records

RESULT:
  ✅ Yjs backend accepts connection
  ✅ Bridge flushed at least once
  ✅ No flush failures
  ✅ meta_records reflects Yjs edit
```

Exit code: **0**

### 3.2 Run 2 — immediate re-run, partial

```
Pre-test status:
  activeDocCount:     1    ← doc from Run 1 still active (not yet idle-released)
  flushSuccess:       1    ← carry from Run 1
Record pre-title:     "YJS-NODE-08:57:46"   ← persisted from Run 1 ✅

After subscribe + insert:
  activeDocCount:     1    ← reused existing doc
  inserted:           "YJS-NODE-08:58:08"

After 3s wait:
  flushSuccess:       2    ← bridge triggered again (delta: 1) ✅

Record post-title:    "YJS-NODE-08:57:46"   ❌ — did not reflect new insert
```

**Note**: bridge flushed (flushSuccess went from 1 to 2) but the DB value did NOT change. Possible explanations:

1. Race between Y.Text `delete(0, length)` and `insert(0, stamp)` inside the same transact — observer may fire twice or emit partial state
2. Server Y.Doc already had `YJS-NODE-08:57:46` synced from Run 1; new update was merged but serialization produced stale `toString()` when bridge read it
3. Bridge wrote `""` or the same old value because of event handler timing in `observeDeep()`

This is a real edge case worth investigating but does NOT block the primary validation: **Run 1 proves the full pipeline works end-to-end**. Run 2 suggests there may be a subtle issue with back-to-back edits on a still-warm doc, which matches the known P1 residual around merge-window actor attribution.

## 4. What This Validates

| Claim | Status | Evidence |
|---|---|---|
| `/yjs` namespace accepts JWT-authenticated Socket.IO connections | ✅ | Run 1 socket.id issued |
| `activeDocCount` moves when client subscribes | ✅ | 0 → 1 on subscribe |
| Sync protocol handshake completes | ✅ | No sync errors, client received state |
| Y.Text edits propagate through the bridge | ✅ | Run 1: flushSuccessCount 0 → 1 |
| Bridge writes to `meta_records` via `RecordWriteService.patchRecords` | ✅ | Run 1: title changed from pre to post |
| No flush failures under normal operation | ✅ | `flushFailureCount` stayed 0 |
| Idle doc released eventually | ⚠️ Partial | `activeDocCount` stayed at 1 after disconnect (idle threshold is 60s) |

## 5. What This Does NOT Validate

- Frontend editor UX (the frontend never connects to `/yjs` — separate known gap)
- Two simultaneous Yjs clients editing same Y.Text (only one client tested)
- Character-level merge semantics (insert replaced entire field, not merged)
- Disconnect/reconnect recovery (client disconnected cleanly, no mid-edit drop)
- Presence/awareness UI
- Back-to-back edits on same doc — **Run 2 flagged a potential issue**

## 6. Follow-up Items

### P1 — investigate Run 2 discrepancy

In the second run, `flushSuccessCount` incremented but the DB value didn't change. This should be reproducible and is the first real gap found in the backend. Suggested test:

1. Start doc at value A
2. Client 1 edits to B (verify DB = B)
3. Immediately Client 2 edits to C (verify DB = C or CRDT merge)

If this reproduces, the bridge may be emitting stale patches due to `observeDeep()` firing during a mid-transact state.

### P2 — idle release monitoring

`activeDocCount` stayed at 1 after client disconnect. Confirmed expected behavior (60s idle timer) but worth adding an explicit test that the timer actually fires.

### P3 — multi-client test

Write a version of this script that spawns two clients simultaneously editing the same record and verifies:
- Both edits appear in both clients' Y.Doc
- CRDT merge produces sensible final state
- `meta_records` ends up with the merged result

## 7. Artifacts

- Script: `scripts/ops/yjs-client-validation/yjs-node-client.mjs`
- Run 1 log: `output/yjs-rollout/trial-20260420/node-client-run-1.log` (all green)
- Run 2 log: `output/yjs-rollout/trial-20260420/node-client-run-2.log` (flush without DB update — P1 investigation)
- Browser trial verification: `docs/operations/yjs-internal-rollout-trial-verification-20260420.md`

## 8. Overall Conclusion

**Backend Yjs pipeline is real and working** for the happy path (cold start → connect → edit → flush → DB). This closes the uncertainty left by the browser trial where zero Yjs activity was observed.

**However**:

1. The frontend editor is still not wired to `/yjs`. All previous rollout packets/reports/gate scripts describe a system that end-users cannot currently reach.
2. Run 2 revealed a potential back-to-back edit issue that warrants investigation before any wider rollout.

**Recommended next decision**:

- Commit this validation + the browser trial report + code artifacts
- Do NOT claim "Yjs is validated end-to-end for users"
- Park the product decision (wire frontend editor) for a separate review
- Optionally: investigate Run 2 as a targeted P1 follow-up

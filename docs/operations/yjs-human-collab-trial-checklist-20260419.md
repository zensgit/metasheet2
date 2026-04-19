# Yjs Human Collaboration Trial Checklist

Date: 2026-04-19

## Baseline

- Environment: internal remote pilot
- Remote image tag: `20260419-yjs-rollout-r4`
- `ENABLE_YJS_COLLAB=true`
- Runtime evidence:
  - `output/yjs-rollout/remote-yjs-rollout-r4-20260419-104604/status.json`
  - `output/yjs-rollout/remote-yjs-rollout-r4-20260419-104604/retention.json`
  - `output/yjs-rollout/remote-yjs-rollout-r4-20260419-104604/report/yjs-rollout-report-2026-04-19T02-58-34-616Z.md`
  - `output/yjs-rollout/remote-yjs-rollout-r4-20260419-104604/gate/reports/yjs-rollout-report-2026-04-19T02-58-38-313Z.md`
- Current signoff draft:
  - `output/yjs-rollout/remote-yjs-rollout-r4-20260419-104604/gate/yjs-internal-rollout-signoff-prefilled.md`

## Participants

- Trial owner:
- Editor A:
- Editor B:
- Observer / recorder:
- Trial window:

## Preconditions

- Both editors can open the same pilot sheet.
- Pilot sheet is non-critical and has at least:
  - one plain text field
  - one longer multiline text field
  - one numeric or status field
- Browser devtools console is open on at least one client.
- Observer can capture timestamps and screenshots if needed.

## Execution Matrix

| Scenario | Steps | Expected Result | Actual | Notes |
| --- | --- | --- | --- | --- |
| 1. Same field concurrent edit | A and B open the same row and type into the same text field for 30-60s. | No hard error; final text converges; no data loss after stop typing. | | |
| 2. Different fields concurrent edit | A edits field X while B edits field Y on the same row. | Both edits appear quickly and persist after refresh. | | |
| 3. Different rows concurrent edit | A edits row 1, B edits row 2. | No cross-row corruption; both rows persist. | | |
| 4. Refresh / reopen | A edits, then refreshes the page; B keeps editing. | A reloads successfully and sees latest shared state. | | |
| 5. Disconnect / reconnect | A disconnects network for 15-30s, B keeps editing, then A reconnects. | A resyncs and converges to latest state without duplicate writes. | | |
| 6. Presence / awareness | A and B remain on the same sheet for several minutes. | Presence indicator is stable and does not flicker or stick after leave. | | |
| 7. Idle then resume | Both leave the sheet idle for 5+ minutes, then continue editing. | Editing resumes normally; no stale-lock behavior. | | |
| 8. Save persistence spot check | After scenarios 1-7, reload both browsers and reopen the same sheet. | Latest values are still present after full reload. | | |

## Observer Notes

- First symptom timestamp:
- Any console error:
- Any websocket disconnect loop:
- Any duplicate / reverted text:
- Any visible presence bug:

## Immediate Rollback Criteria

Trigger `NO-GO` and disable `ENABLE_YJS_COLLAB` immediately if any of these occur:

- repeated write failures visible to users
- repeated flush failures or persistence errors
- text divergence that does not self-heal after refresh
- reconnect loop that prevents continued editing
- data loss after both editors reload

## Post-Trial Commands

Run after the human trial window:

```bash
node scripts/ops/check-yjs-rollout-status.mjs
node scripts/ops/check-yjs-retention-health.mjs
node scripts/ops/capture-yjs-rollout-report.mjs
node scripts/ops/run-yjs-rollout-gate.mjs
```

Then fill:

- `output/yjs-rollout/remote-yjs-rollout-r4-20260419-104604/gate/yjs-internal-rollout-signoff-prefilled.md`


# Yjs Signoff Prefill Automation Verification

Date: 2026-04-19

## Verification Commands

Executed from the clean worktree:

```bash
node --test scripts/ops/prefill-yjs-rollout-signoff.test.mjs scripts/ops/capture-yjs-rollout-report.test.mjs
node scripts/ops/export-yjs-rollout-packet.mjs --output-dir artifacts/yjs-rollout-packet-prefill-test
node scripts/ops/run-yjs-rollout-gate.mjs --print-plan
YJS_TRIAL_ENVIRONMENT=internal \
YJS_TRIAL_OWNER=ops \
YJS_TRIAL_REVIEWER=review \
YJS_TRIAL_WINDOW='2026-04-19T10:00:00+08:00/2026-04-19T11:00:00+08:00' \
YJS_TRIAL_SHEETS='sheet-a,sheet-b' \
YJS_TRIAL_USERS='2 internal users' \
YJS_TRIAL_USER_COUNT=2 \
node scripts/ops/prefill-yjs-rollout-signoff.mjs \
  --status-json output/yjs-rollout/remote-yjs-rollout-r4-20260419-104604/status.json \
  --retention-json output/yjs-rollout/remote-yjs-rollout-r4-20260419-104604/retention.json \
  --report-json output/yjs-rollout/remote-yjs-rollout-r4-20260419-104604/report/yjs-rollout-report-2026-04-19T02-58-34-616Z.json \
  --packet-dir output/yjs-rollout/remote-yjs-rollout-r4-20260419-104604/gate/packet \
  --output-path output/yjs-rollout/remote-yjs-rollout-r4-20260419-104604/gate/yjs-internal-rollout-signoff-prefilled.md
```

## Results

### Script Tests

- `prefill-yjs-rollout-signoff.test.mjs`: passed
- `capture-yjs-rollout-report.test.mjs`: passed
- combined node test run: `3 pass / 0 fail`

### Packet Export

- packet export completed successfully
- generated README now includes:
  - `scripts/ops/prefill-yjs-rollout-signoff.mjs`
  - updated recommended order step: `Prefill the signoff draft from current evidence`

### Gate Plan

`run-yjs-rollout-gate.mjs --print-plan` now reports:

1. `check-yjs-rollout-status.mjs`
2. `check-yjs-retention-health.mjs`
3. `export-yjs-rollout-packet.mjs`
4. `capture-yjs-rollout-report.mjs`
5. `prefill signoff draft into gate output directory`

### Real Artifact Prefill

The prefill script was executed against the real `r4` rollout artifacts and wrote:

- `output/yjs-rollout/remote-yjs-rollout-r4-20260419-104604/gate/yjs-internal-rollout-signoff-prefilled.md`

The generated file correctly included:

- rollout context values from environment inputs
- runtime evidence path: `../status.json`
- retention evidence path: `../retention.json`
- report path: `../report/yjs-rollout-report-2026-04-19T02-58-34-616Z.json`
- packet path: `packet`
- runtime snapshot:
  - `enabled: true`
  - `initialized: true`
  - `activeDocCount: 0`
  - `pendingWriteCount: 0`
  - `flushFailureCount: 0`
  - `activeSocketCount: 0`
- retention snapshot:
  - `statesCount: 0`
  - `updatesCount: 0`
  - `orphanStatesCount: 0`
  - `orphanUpdatesCount: 0`
  - hottest record: `none`

## Conclusion

The rollout packet now produces a useful signoff draft instead of an empty template.
This is sufficient for the next step:

- run the human collaborative trial;
- fill the `User Validation` and `Decision` sections;
- attach the completed signoff to the rollout evidence bundle.

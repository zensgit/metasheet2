# Yjs Rollout Report Capture

Date: 2026-04-16

## Command

```bash
YJS_BASE_URL=http://localhost:3000 \
YJS_ADMIN_TOKEN=$ADMIN_TOKEN \
YJS_DATABASE_URL=$DATABASE_URL \
node scripts/ops/capture-yjs-rollout-report.mjs
```

## Output

The script writes two artifacts under `artifacts/yjs-rollout/`:

- `yjs-rollout-report-<timestamp>.json`
- `yjs-rollout-report-<timestamp>.md`

## Purpose

This is the smallest repeatable way to capture one rollout checkpoint that includes:

- runtime health
- retention/orphan health
- hottest records by update volume

It is intended for pilot signoff, not for continuous monitoring.

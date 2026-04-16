# Yjs Rollout Packet Export

Date: 2026-04-16

## Command

```bash
node scripts/ops/export-yjs-rollout-packet.mjs
```

## Output

Default output directory:

```text
artifacts/yjs-rollout-packet/
```

Included:

- rollout checklist
- rollout execution guide
- ops runbook
- retention policy
- rollout report capture guide
- runtime status check script
- retention health check script
- rollout report capture script
- generated `README.md`

## Purpose

This export is for pilot owners who need one artifact folder containing the exact docs and scripts required to execute and record a limited Yjs internal rollout.

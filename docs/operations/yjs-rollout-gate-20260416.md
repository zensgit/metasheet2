# Yjs Rollout Gate

Date: 2026-04-16

## Command

```bash
YJS_BASE_URL=http://localhost:3000 \
YJS_ADMIN_TOKEN=$ADMIN_TOKEN \
YJS_DATABASE_URL=$DATABASE_URL \
node scripts/ops/run-yjs-rollout-gate.mjs
```

## What It Does

This is the one-command internal rollout gate.

It runs:

1. runtime status check
2. retention health check
3. packet export
4. rollout report capture
5. signoff draft copy

## Output

Default output directory:

```text
artifacts/yjs-rollout-gate/
```

Contents:

- `packet/`
- `reports/`
- `yjs-internal-rollout-signoff.md`

## Dry Run

```bash
node scripts/ops/run-yjs-rollout-gate.mjs --print-plan
```

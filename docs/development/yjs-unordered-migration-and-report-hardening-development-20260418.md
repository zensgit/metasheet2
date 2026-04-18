# Yjs Unordered Migration And Report Hardening Development

Date: 2026-04-18

## Summary

This change set closes two rollout blockers that showed up on the live Yjs validation path:

1. some deployed databases had already executed later `zzzz20260413*` migrations before a newly-added earlier-named migration was introduced, which caused the stock Kysely migration order check to hard-fail before the Yjs tables could be created;
2. `capture-yjs-rollout-report.mjs` trusted whatever JSON it got back from the runtime/retention child scripts, which allowed incomplete retention payloads to be rendered as a healthy report.

## Code Changes

### 1. Allow unordered migration histories in the main migrator

Updated `packages/core-backend/src/db/migrate.ts` to initialize `Migrator` with:

- `allowUnorderedMigrations: true`

This keeps the migration runner compatible with environments where:

- `zzzz20260413130000_create_formula_dependencies`
  had already been recorded as executed;
- a later mainline sync then introduced
  `zzzz20260413120000_create_automation_rules`;
- the default Kysely prefix-order check would otherwise reject all future migrations, including
  `zzzz20260501100000_create_yjs_state_tables`.

The change is intentionally narrow:

- migration names are still loaded from the same folder;
- underscore-prefixed helper files are still filtered out;
- only the strict executed-prefix validation is relaxed.

### 2. Fail closed when rollout report payloads are incomplete

Updated `scripts/ops/capture-yjs-rollout-report.mjs` so it now validates both child payloads before writing any report artifact:

- runtime payload must include `baseUrl`, `metrics`, and the expected boolean/number fields;
- retention payload must include a `stats` object with numeric
  `statesCount`, `updatesCount`, `orphanStatesCount`, and `orphanUpdatesCount`;
- missing/partial payloads now terminate the script with exit code `1`
  and a clear error instead of producing a misleading healthy report.

This specifically protects against the live validation case where a retention execution path returned:

- `failures: []`
- `stats: {}`

and the old script would still render:

- `status: HEALTHY`
- `states count: undefined`

### 3. Add a focused script test

Added `scripts/ops/capture-yjs-rollout-report.test.mjs` with two cases:

- complete runtime + retention payloads write JSON and Markdown report files;
- missing retention stats fails closed and does not write an output directory.

## Scope

This change does not alter:

- Yjs runtime logic;
- Yjs websocket behavior;
- retention SQL thresholds;
- the rollout gate decision policy itself.

It only restores migration continuity and hardens the report capture boundary so the rollout evidence cannot silently degrade.

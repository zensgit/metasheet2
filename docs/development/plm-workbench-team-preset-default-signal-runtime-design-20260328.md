# PLM Workbench Team Preset Default Signal Runtime Design

## Background

`team preset` list and mutation routes already return `lastDefaultSetAt`, and source OpenAPI already documents the field. The frontend model also accepts it through `PlmTeamFilterPreset`.

The remaining gap was the web runtime mapper:

- `mapTeamPreset(...)` normalized most collaborative fields
- but silently dropped `lastDefaultSetAt`

That made `team preset` default signals weaker than `team view`, even though backend and contract layers were already aligned.

## Goal

Preserve `lastDefaultSetAt` end-to-end in the web PLM client so list/default actions surface the same hydrated default signal that backend routes already emit.

## Design

Add one explicit pass-through in `mapTeamPreset(...)`:

- if `record.lastDefaultSetAt` is a string, keep it
- otherwise normalize it to `undefined`

No other mapping logic changes. This keeps the fix narrow and aligned with the already-correct `mapTeamView(...)` behavior.

## Why this is correct

- matches backend payloads already under test
- matches OpenAPI contract
- matches frontend type shape
- restores parity between `team preset` and `team view` default signals

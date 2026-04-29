# Wave M-Feishu-2 Formula Runtime Parity Design

Date: 2026-04-29

Branch: `codex/mfeishu2-formula-runtime-parity-20260429`

Base: `origin/main@6a99c117d`

Related PR: #1227 (`feat(multitable): add formula editor view builder and gantt view`)

## Context

#1227 exposes formula editor guidance for common Feishu-style functions. Backend formula runtime already supports almost all functions listed in that editor:

- `SUM`
- `AVERAGE`
- `MIN`
- `MAX`
- `IF`
- `AND`
- `OR`
- `CONCAT`
- `LEN`
- `TODAY`

The only mismatch found during parallel review was `DATEDIFF`. The backend had Excel-style `DATEDIF(start, end, unit)` but no `DATEDIFF(end, start)` alias, while the editor docs expose `DATEDIFF(end_date, start_date)`.

## Change

Add `DATEDIFF` as a narrow alias in `FormulaEngine`:

- Signature: `DATEDIFF(endDate, startDate)`
- Semantics: day difference only
- Implementation: delegates to existing `datedif(startDate, endDate, 'D')`

This keeps runtime behavior conservative:

- No parser rewrite.
- No new date unit syntax.
- Existing `DATEDIF` behavior remains unchanged.
- Existing formulas remain backwards compatible.

## Files

- `packages/core-backend/src/formula/engine.ts`
- `packages/core-backend/tests/unit/multitable-formula-engine.test.ts`

## Deferred

- Full Feishu/Airtable formula parity is still out of scope.
- Rich date functions such as `DATEADD`, `WORKDAY`, `NETWORKDAYS`, and locale-aware formatting should be separate formula-runtime slices.
- Formula editor autocomplete can later read a shared manifest instead of duplicating frontend docs and backend registrations.


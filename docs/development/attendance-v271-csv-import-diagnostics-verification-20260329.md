# Attendance v2.7.1 CSV Import Diagnostics Verification

Date: 2026-03-29
Branch: `codex/attendance-v271-followup-20260329`

## Verified scope

- preview returns CSV header diagnostics via `csvWarnings`
- commit returns a header-aware empty-row message instead of generic `No rows to import`
- diagnostics stay within the current backend contract and reuse the existing warning surface

## Commands

### Focused backend integration

```bash
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "serves attendance import templates as JSON and CSV|surfaces CSV header diagnostics during preview and clarifies header-only commit failures|supports request item lookup, update, and delete aliases for self-service follow-up|supports holiday item lookup and rejects invalid holiday date/type payloads before write|supports approval flow, rule set, and payroll cycle item lookup while keeping missing item semantics stable|rejects negative leave type daily_minutes aliases, empty holiday names, and exposes holiday type fields" --reporter=dot
```

Result: pass

Expected assertions:

- preview `csvWarnings` includes detected / recognized / missing / unmapped column hints
- header-only commit returns `400 VALIDATION_ERROR`
- the empty-row message includes `CSV contains the header row but no non-empty data rows were parsed`

### Backend type check

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result: pass

### Source integrity

```bash
git diff --check
```

Result: pass

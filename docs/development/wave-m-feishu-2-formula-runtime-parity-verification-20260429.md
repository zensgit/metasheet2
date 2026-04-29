# Wave M-Feishu-2 Formula Runtime Parity Verification

Date: 2026-04-29

Branch: `codex/mfeishu2-formula-runtime-parity-20260429`

Base: `origin/main@6a99c117d`

## Automated Verification

### Focused Formula Runtime Spec

Command:

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/multitable-formula-engine.test.ts \
  --reporter=verbose
```

Result:

```text
Test Files  1 passed (1)
Tests       22 passed (22)
```

Coverage added:

- `DATEDIFF("2024-01-31","2024-01-01") -> 30`
- invalid `DATEDIFF` dates return `#VALUE!`

Regression covered:

- Existing `DATEDIF` day/month/year cases still pass.
- Existing `CONCAT`, `COUNTA`, `SWITCH`, field reference extraction, field evaluation, lookup, and formula recalc tests still pass.

### Backend Type Check

Command:

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result:

```text
EXIT 0
```

## Risk

Low. `DATEDIFF` is an additive function registration that delegates to existing `DATEDIF`; it does not alter parser or existing function behavior.


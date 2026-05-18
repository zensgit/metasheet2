# Multitable Home Recents And Favorites Verification

Date: 2026-05-18

Branch: `codex/multitable-home-recents-favorites-20260518`

## Result

PASS. The `/multitable` home Base list now supports browser-local favorite pins and recent-open ordering without backend changes.

## Commands

```bash
pnpm install --frozen-lockfile --ignore-scripts
```

Result: PASS.

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-base-local-state.spec.ts \
  tests/multitable-home-view.spec.ts \
  --watch=false
```

Result: PASS, 2 files / 10 tests.

```bash
pnpm --filter @metasheet/web exec eslint \
  src/views/MultitableHomeView.vue \
  src/multitable/utils/base-local-state.ts \
  tests/multitable-base-local-state.spec.ts \
  tests/multitable-home-view.spec.ts
```

Result: PASS.

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Result: PASS.

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result: PASS.

## Coverage

- Favorite toggle persists a Base ID and promotes the card above non-favorites.
- Recent-open state is recorded after a successful open and promotes the Base below favorites.
- Search still filters the sorted list and keeps the no-match state separate from the empty-list state.
- Corrupted localStorage payloads fail closed to empty state.
- Unknown/stale stored Base IDs are ignored during sorting.

## Scope Check

- No backend source changes.
- No database migration changes.
- No OpenAPI changes.
- No route or permission changes.
- No Data Factory, K3, DingTalk, Attendance, or Phase 3 TODO status changes.

## Final Checks

```bash
git diff --check
```

Result: PASS.

Secret-pattern scan over the touched source, test, and documentation files:

Result: PASS after removing a self-referential example scan pattern from this verification document. No credential-like values remain in the changed files.

## Install Noise Cleanup

```bash
git diff --name-only | rg '(^plugins/.*/node_modules|^tools/cli/node_modules)' | xargs git restore --
```

Result: PASS. The only remaining changed files are the intended source, test, and documentation files.

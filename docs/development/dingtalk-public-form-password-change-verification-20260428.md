# DingTalk Public Form Password-Change Guard Verification

- Date: 2026-04-28
- Scope: `jwt-middleware`, public form route metadata, public form page copy

## Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/jwt-middleware.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/public-multitable-form.spec.ts tests/multitable-embed-route.spec.ts tests/multitable-phase4.spec.ts --watch=false
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
git diff --check
```

## Regression Coverage

- `jwt-middleware.test.ts` covers public-form context and submit requests with `publicToken` hydrating a `must_change_password` user instead of returning `PASSWORD_CHANGE_REQUIRED`.
- `jwt-middleware.test.ts` also covers the negative case: the same public-form context path without `publicToken` still returns `PASSWORD_CHANGE_REQUIRED`.
- `multitable-embed-route.spec.ts` covers `skipShellBootstrap: true` on the public form route.
- `public-multitable-form.spec.ts` covers the neutral loading subtitle before form context is loaded.

## Results

Backend JWT middleware unit test:

```text
Test Files  1 passed (1)
Tests       16 passed (16)
```

Frontend public form route/view/API tests:

```text
Test Files  3 passed (3)
Tests       18 passed (18)
```

Builds:

```text
pnpm --filter @metasheet/core-backend build
# pass

pnpm --filter @metasheet/web build
# pass
```

Diff hygiene:

```text
git diff --check
# pass
```

## Non-Gating Observations

- The frontend Vitest run printed Vite websocket/socket warnings and a jsdom navigation warning from DingTalk redirect tests. Exit code was 0.
- The frontend production build printed existing dynamic-import and large-chunk warnings. Exit code was 0.

# Views Consolidation Navigation Positioning Verification

Date: 2026-05-18

Branch: `codex/views-consolidation-nav-positioning-20260518`

## Result

Status: PASS

This verification covers the frontend-only navigation positioning slice for views consolidation.

## Commands

### V1 - Platform Shell Navigation Spec

Command:

```sh
pnpm --filter @metasheet/web exec vitest run tests/platform-shell-nav.spec.ts --watch=false
```

Result:

```text
Test Files  1 passed (1)
Tests       4 passed (4)
```

Coverage:

- Multitable remains visible in platform shell navigation.
- `/grid` and `/spreadsheets` remain absent from top-level shell links.
- `/kanban`, `/calendar`, `/gallery`, and `/form` are no longer top-level shell links.
- `/grid`, `/kanban`, `/calendar`, `/gallery`, and `/form` still have registered route records with `requiresAuth: true` and `deprecated: true`.

### V2 - Targeted Frontend Lint

Command:

```sh
pnpm --filter @metasheet/web exec eslint src/App.vue src/router/appRoutes.ts src/router/types.ts tests/platform-shell-nav.spec.ts
```

Result:

```text
Exit code 0
0 errors
10 warnings
```

The warnings are existing Vue test-fixture style warnings in `platform-shell-nav.spec.ts` for inline mocked `router-view` / `router-link` components. No lint errors remain.

### V3 - Frontend Type Check

Command:

```sh
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Result:

```text
Exit code 0
```

### V4 - Backend Type Check

Command:

```sh
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result:

```text
Exit code 0
```

### V5 - Diff Hygiene

Command:

```sh
git diff --check
```

Result:

```text
Exit code 0
```

### V6 - Secret Scan

Command:

```sh
git diff --cached -U0 -- <changed-files> | rg -n <secret-patterns> --no-heading
```

Result:

```text
0 matches
```

The concrete pattern set covered token-shaped, JWT-shaped, API-key-shaped, DingTalk-secret-shaped, credential-field, and query-token values. The literal pattern is intentionally not embedded in this verification note so the note does not match its own scan.

## What This Does Not Verify

- It does not execute a browser smoke against a running dev server.
- It does not test legacy view rendering because those routes remain unchanged.
- It does not verify Spreadsheets behavior because this PR does not change Spreadsheets.
- It does not verify `/grid` data migration or route-gate behavior because that is explicitly deferred.

## Final Verdict

PASS.

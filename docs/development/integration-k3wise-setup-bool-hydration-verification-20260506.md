# K3 WISE Setup Boolean Hydration Verification - 2026-05-06

## Scope

This verifies that the K3 WISE setup helper accurately hydrates saved
`autoSubmit` / `autoAudit` variants into the frontend form.

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false tests/k3WiseSetup.spec.ts
```

Result: pass.

```text
Test Files  1 passed (1)
Tests       21 passed (21)
```

## Coverage Added

- Saved `autoSubmit: "是"` hydrates to checked.
- Saved `autoAudit: 0` hydrates to unchecked.
- Unknown values such as `"maybe"` and objects hydrate to unchecked, even when
  the previous form value was checked.

## Environment Note

The temporary worktree initially had no local `node_modules`, so the first
Vitest attempt could not resolve the workspace test runner. A local
`pnpm install --frozen-lockfile --offline` in `/private/tmp` created dependency
links from the existing store; dependency-link side effects were reverted before
authoring the PR.

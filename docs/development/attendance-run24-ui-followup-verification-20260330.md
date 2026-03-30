# Attendance Run24 UI Follow-up Verification

## Commands

```bash
git diff --check
pnpm --filter @metasheet/web exec vitest run tests/attendance-admin-anchor-nav.spec.ts tests/attendance-admin-regressions.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
```

## Expectations

- Admin console no longer renders a `data-admin-focus-toggle` control.
- Legacy local-storage `focused_mode=false` is normalized back to focused mode.
- The active section still scrolls into view and recent shortcuts still work.
- Action-cell `td` elements expose a non-collapsing `min-width`.
- Structured rule builder and preview headers wrap without squeezing content.

## Results

- `git diff --check`: pass
- `pnpm --filter @metasheet/web exec vitest run tests/attendance-admin-anchor-nav.spec.ts tests/attendance-admin-regressions.spec.ts --watch=false`: pass (`26/26`)
- `pnpm --filter @metasheet/web exec vue-tsc --noEmit`: pass
- `pnpm --filter @metasheet/web build`: pass

## Notes

- The DOM-level regression tests lock the retired `data-admin-focus-toggle` out of the UI and verify that legacy local-storage values are normalized back to focused mode.
- jsdom does not compute real browser layout for the action-cell width collapse, so the button-column fix is validated here through the scoped CSS change plus the focused regression suite. Final confirmation still belongs to browser smoke on the deployed package.

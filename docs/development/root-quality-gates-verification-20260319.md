# Root quality gates verification report

Date: 2026-03-19

## Verification commands

```bash
CI=true pnpm install --ignore-scripts
pnpm lint
pnpm type-check
```

## Expected CI behavior

- `Plugin System Tests` workflow runs `pnpm lint` under `test (20.x)`.
- `Plugin System Tests` workflow runs `pnpm type-check` under `test (20.x)`.
- Root `pnpm lint` fails on any backend ESLint warning because `--max-warnings 0` is now enabled.

## Notes

- This change intentionally reuses the existing plugin test workflow instead of adding a separate quality-gate workflow, so the enforcement lands in an already-established PR check path.

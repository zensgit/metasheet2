# Root quality gates development report

Date: 2026-03-19

## Scope

Harden repository-level quality gates so the recent backend lint cleanup cannot silently regress.

Changed files:

- `package.json`
- `.github/workflows/plugin-tests.yml`

## Implementation summary

### Root lint script

- Updated `lint:backend` to run ESLint with `--max-warnings 0`.
- This converts root `pnpm lint` from a soft warning collector into a true failing gate for backend lint regressions.

### PR CI enforcement

- Updated `Plugin System Tests` workflow so the existing `test (20.x)` matrix job runs:
  - `pnpm lint`
  - `pnpm type-check`
- Chose Node 20 only for these gates to avoid duplicate work across both matrix legs while still making the check blocking inside an already-required PR workflow.

## Expected outcome

- New lint warnings now fail local `pnpm lint`.
- PR CI now executes both `pnpm lint` and `pnpm type-check` as blocking checks through the existing plugin test workflow.

# Attendance Record Timeline Request Bridge Verification

## Commands

```bash
git diff --check
pnpm --filter @metasheet/web exec vitest run tests/attendance-record-timeline.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
```

## Focused Test Result

The timeline spec now verifies three paths:

- timeline detail lazy-load and cached reopen behavior
- inline unsupported-endpoint fallback on `404`
- `Use in request form` prefilling work date, request type, and timeline-derived timestamps

Observed result:

- `3 passed`

## Typecheck / Build

- `vue-tsc --noEmit` passed
- `@metasheet/web build` passed

## Behavioral Summary

Verified outcomes for this slice:

- expanded record timeline rows now expose a direct bridge into the request form
- the bridge preselects `time_correction`
- the request form receives the current work date plus the inferred first-in / last-out values
- the page scrolls back to the request form so the operator stays in one correction flow

## Claude Code Status

Claude Code was successfully made callable in this restarted environment by invoking it through `/usr/local/bin/node` with the local CLI package. It was used here only as runtime capability validation, not as the implementation source.

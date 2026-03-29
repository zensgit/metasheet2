# Attendance Record Timeline Request Type Verification

## Commands

```bash
git diff --check
pnpm --filter @metasheet/web exec vitest run tests/attendance-record-timeline.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
```

## Focused Test Result

The record timeline spec now covers:

- lazy-load and cached reopen behavior
- unsupported-endpoint inline fallback
- bridge to the request form
- request-type inference for one-sided timelines

Observed result:

- `4 passed`

## Typecheck / Build

- `vue-tsc --noEmit` passed
- `@metasheet/web build` passed

## Behavioral Summary

Verified outcomes for this slice:

- timelines with only `check_in` now prefill `missed_check_out`
- timelines with only `check_out` would analogously prefill `missed_check_in`
- one-sided inferred requests leave the missing timestamp blank
- two-sided timelines still use `time_correction`

## Claude Code Status

Claude Code remained callable in this environment through `/usr/local/bin/node` plus the local CLI package. Its long-running review prompt still did not return a timely boundary conclusion, so this slice was accepted on the basis of focused tests and local verification.

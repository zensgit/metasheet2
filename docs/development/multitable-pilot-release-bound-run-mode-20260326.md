# Multitable Pilot Release-Bound Run Mode

Date: 2026-03-26
Repo: `/Users/huazhou/Downloads/Github/metasheet2-multitable-next`

## Goal

Finish the pilot runner mode promotion by carrying `RUN_MODE=staging` through the final release-bound wrappers.

Target scripts:

- `scripts/ops/multitable-pilot-ready-release-bound.sh`
- `scripts/ops/multitable-pilot-handoff-release-bound.sh`

## Problem

After the previous slice:

- readiness, handoff, and release-bound artifacts understood `pilotRunner.runMode`
- staging had its own `ready-staging` wrapper
- but the final release-bound wrappers still defaulted to the local-only path and example text

That left one last mismatch:

- `RUN_MODE=staging` was not used to select `ready-staging`
- `handoff-release-bound` did not forward the runner mode into `multitable-pilot-handoff.mjs`
- operator error messages still preferred local examples

## Design

### 1. Dispatch ready-release-bound by run mode

`multitable-pilot-ready-release-bound.sh` now selects:

- local: `scripts/ops/multitable-pilot-ready-local.sh`
- staging: `scripts/ops/multitable-pilot-ready-staging.sh`

and adjusts its example command accordingly.

### 2. Forward run mode into handoff-release-bound

`multitable-pilot-handoff-release-bound.sh` now accepts `RUN_MODE` and passes:

- `PILOT_RUN_MODE=${RUN_MODE}`

to `multitable-pilot-handoff.mjs`.

This ensures the final handoff artifact can keep reporting the correct runner mode.

### 3. Keep operator output mode-aware

Both wrappers now print:

- `run_mode=...`

and their help examples distinguish local and staging release-bound flows.

## Verification

The slice is verified by focused script tests and syntax checks:

- `multitable-pilot-release-bound-wrapper.test.mjs` locks staging dispatch and handoff forwarding
- shell syntax checks confirm both wrappers remain valid bash scripts

## Outcome

The pilot chain now keeps `runMode` intact all the way to the release-bound wrappers. Staging is no longer just a mid-pipeline special case; it is a first-class release-bound execution mode.

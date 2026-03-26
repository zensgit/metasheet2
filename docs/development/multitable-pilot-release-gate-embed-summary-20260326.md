# Multitable Pilot Release Gate Embed Summary

Date: 2026-03-26
Repo: `/Users/huazhou/Downloads/Github/metasheet2-multitable-next`

## Goal

Raise `scripts/ops/multitable-pilot-release-gate.sh` to the same evidence level as readiness, handoff, and release-bound:

- emit a human-readable `report.md`, not only `report.json`
- extract embed-host evidence directly from the live-smoke artifact
- make skipped smoke reuse still fail the canonical gate report when the reused smoke artifact is missing required embed-host evidence

## Problem

Before this slice:

- pilot `release-gate` only emitted step-level `report.json`
- live smoke was recorded as one black-box step
- embed-host protocol / navigation protection / busy deferred replay were promoted later in readiness and handoff, but not visible in the canonical gate artifact
- when `SKIP_MULTITABLE_PILOT_SMOKE=true`, the gate could still look green even if the reused smoke artifact lacked required embed-host evidence

That made `gates/report.json` weaker than the artifacts generated later in the same pilot chain.

## Design

### 1. Reuse the existing readiness evidence shape

`multitable-pilot-release-gate.sh` now summarizes the same three embed-host categories already used downstream:

- `embedHostProtocol`
- `embedHostNavigationProtection`
- `embedHostDeferredReplay`

and derives:

- `embedHostAcceptance`

The summary shape matches the later artifacts closely:

- `available`
- `ok`
- `requiredWhenPresent`
- `observedChecks`
- `missingChecks`

### 2. Treat reused smoke as a first-class gate input

When `PILOT_SMOKE_REPORT` exists, the gate now parses it directly and records:

- `liveSmoke.available`
- `liveSmoke.ok`
- `liveSmoke.report`
- `liveSmoke.checkCount`
- `liveSmoke.failingChecks`

If the smoke artifact is present and embed-host evidence is present but incomplete, the gate report now flips to:

- `ok: false`
- `failingEvidence: [...]`

This is stronger than the previous behavior, where a skipped smoke step could still leave the canonical gate artifact green.

### 3. Always emit a readable gate markdown summary

If `REPORT_JSON` is configured, the gate now also writes `report.md` next to it by default.

The markdown contains:

- overall PASS/FAIL
- exit code and failed step
- step table as a flat checklist
- live smoke artifact summary
- embed-host acceptance summary
- protocol / navigation / deferred-replay sections

This makes the local gate artifact directly consumable by staging or pilot operators without opening raw JSON.

### 4. Surface the markdown path from ready-local

`scripts/ops/multitable-pilot-ready-local.sh` now sets:

- `gates/report.json`
- `gates/report.md`

and prints both paths at the end of the run.

## Verification

I ran:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
bash -n scripts/ops/multitable-pilot-release-gate.sh scripts/ops/multitable-pilot-ready-local.sh
node --test scripts/ops/multitable-pilot-release-gate.test.mjs
pnpm --filter @metasheet/web exec tsc --noEmit --pretty false
pnpm --filter @metasheet/web build
```

Results:

- shell syntax checks passed
- `multitable-pilot-release-gate.test.mjs` passed
- frontend `tsc --noEmit` passed
- frontend build passed

New regression coverage:

- success path now verifies `report.md` plus top-level embed-host evidence in `report.json`
- failure path still verifies canonical gate artifact emission on step failure
- new skipped-smoke regression verifies incomplete embed-host evidence flips the canonical gate report to `ok: false`

## Outcome

`release-gate` is no longer a weaker black-box artifact than readiness or handoff. It now carries the same embed-host signal directly, and skipped smoke reuse can no longer silently mask a broken embed-host acceptance chain.

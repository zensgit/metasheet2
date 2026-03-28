# Attendance Daily Gate Signal Channel Contract Hardening

Date: 2026-03-28
Branch: `codex/attendance-daily-gate-signal-channels-20260328`

## Context

The first `attendance daily gate signal channels` slice added:

- `gates.<remoteGate>.signalChannels`
- additive `gateFlat.<remoteGate>` signal summary fields
- a markdown table showing scheduled vs manual recovery evidence

That slice was intentionally additive, but the existing dashboard validator did not yet lock those new fields. This left a gap:

- report generation could drift
- contract fixtures would still pass without checking the new remote channel shape

## Goal

Lock the new remote signal fields into the existing dashboard contract tooling without changing dashboard health evaluation logic.

## Scope

In scope:

- `scripts/ops/attendance-validate-daily-dashboard-json.sh`
- `scripts/ops/attendance-run-gate-contract-case.sh`
- focused docs for the new contract surface

Out of scope:

- changing how remote gates are evaluated
- changing escalation policy
- changing workflow schedules or run selection

## Design

### 1. Validate additive remote signal fields when present

For remote gates:

- `preflight`
- `metrics`
- `storage`
- `cleanup`

the dashboard validator now checks the new additive fields if present:

- `gateFlat.<gate>.latestScheduledRunId`
- `gateFlat.<gate>.latestScheduledConclusion`
- `gateFlat.<gate>.latestManualRunId`
- `gateFlat.<gate>.latestManualConclusion`
- `gateFlat.<gate>.manualRecovery`
- `gates.<gate>.signalChannels.*`

### 2. Cross-check flat vs nested values

When both shapes exist, the validator now enforces consistency between:

- `gateFlat.*`
- `gates.*.signalChannels.*`

This avoids silent divergence between the compact machine-readable summary and the richer nested run evidence.

### 3. Extend the dashboard contract case

`dashboard.valid.json` now includes valid remote signal channel fields.

A new negative fixture, `dashboard.invalid.remote-channels.json`, mutates `gateFlat.preflight.manualRecovery` to an invalid value to ensure the validator fails on contract drift.

## Expected outcome

Future changes to the remote signal channel summary cannot silently regress:

- the focused contract case will fail
- the dashboard validator will reject malformed additive remote-channel fields

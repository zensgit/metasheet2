# Attendance Daily Gate Signal Channels

Date: 2026-03-28
Branch: `codex/attendance-daily-gate-signal-channels-20260328`

## Context

`Attendance Daily Gate Dashboard` currently evaluates each gate against the latest completed run on the target branch. That is correct for the gate's PASS/FAIL status, but it hides an operationally important recovery pattern:

- the latest scheduled remote gate failed, and
- a newer manual replay already succeeded on the same branch.

This gap showed up during the recent remote preflight / metrics / storage recovery loop. Operators could see the dashboard recover, but they could not tell from the report alone whether recovery came from a fresh scheduled signal or from a newer manual replay.

## Goal

Add a channel-aware remote signal summary that:

- keeps the existing gate evaluation unchanged,
- shows the latest completed scheduled run for each remote gate,
- shows the latest completed manual replay for each remote gate,
- highlights when a newer successful manual replay follows a failed scheduled signal.

## Scope

In scope:

- `scripts/ops/attendance-daily-gate-report.mjs`
- new helper for run-channel selection
- focused helper test
- markdown/JSON report enrichment for remote gates:
  - `Remote Preflight`
  - `Host Metrics`
  - `Storage Health`
  - `Upload Cleanup`

Out of scope:

- changing PASS/FAIL evaluation logic
- changing escalation issue rules
- touching non-remote gates
- altering workflow schedules

## Design

### 1. Keep gate health based on the current logic

`evaluateGate()` still consumes the existing `latestCompleted` run and existing lookback rules. The new slice is purely explanatory and does not change whether a gate is `PASS` or `FAIL`.

### 2. Add a small run-channel helper

Introduce `scripts/ops/attendance-daily-gate-signal-channels.mjs` to compute:

- `latestScheduledCompleted`
- `latestManualCompleted`
- `manualRecovery`

`manualRecovery=true` only when:

- the latest scheduled completed run is not `success`,
- the latest manual completed run is `success`,
- the manual replay is newer than the scheduled failure.

### 3. Attach remote signal channels onto remote gate objects

For the four remote gates, the report now stores:

- `gates.<gate>.signalChannels.latestScheduledCompleted`
- `gates.<gate>.signalChannels.latestManualCompleted`
- `gates.<gate>.signalChannels.manualRecovery`

This keeps the richer object under `gates.*` where downstream tooling can inspect it without changing the existing top-level gate evaluation contract.

### 4. Surface the new view in Markdown and flat JSON

Markdown gets a new `## Remote Signal Channels` section with one row per remote gate.

`gateFlat.*` gets compact scalar summaries:

- `latestScheduledRunId`
- `latestScheduledConclusion`
- `latestManualRunId`
- `latestManualConclusion`
- `manualRecovery`

These are additive fields only.

## Expected outcome

Operators reading the daily dashboard can immediately distinguish:

- still failing remote gates,
- recovered gates whose newest evidence is a manual replay,
- gates whose scheduled and manual channels are already aligned.

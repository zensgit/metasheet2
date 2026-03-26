# Multitable Operator Contract Artifact Promotion

Date: 2026-03-26

## Goal

Promote the machine-readable release-gate operator contract beyond canonical gate output so downstream pilot artifacts can consume it without reparsing markdown.

## Problem

The previous release-gate slice wrote:

- `operatorCommands`
- `operatorChecklist`

into canonical `gates/report.json`, but downstream artifacts still treated the helper as mostly path-only evidence.

That left a gap:

- `handoff.json` and `handoff.md` did not carry the structured operator contract forward
- `release-bound` could point to helper files, but could not restate the command/checklist contract in its own top-level payload

## Design

### 1. Promote operator contract through handoff

`scripts/ops/multitable-pilot-handoff.mjs` now lifts readiness gate operator data into:

- `readinessGateOperatorContract.helper`
- `readinessGateOperatorContract.operatorCommandEntries`
- `readinessGateOperatorContract.operatorChecklist`

and also mirrors the entry/checklist arrays under `artifactChecks.readinessGate` so the contract stays visible beside other promoted artifacts.

### 2. Surface the same contract in handoff markdown

`handoff.md` now includes a dedicated `## Readiness Gate Operator Contract` section with:

- helper presence/path
- operator command names
- operator checklist summary

This keeps the human-readable handoff aligned with the structured JSON shape.

### 3. Promote operator contract into release-bound

`scripts/ops/multitable-pilot-release-bound.sh` now reads the promoted handoff operator contract and writes it into:

- `report.json.readinessGateOperatorContract`
- `report.md -> ## Readiness Gate Operator Contract`

This closes the last gap in the pilot chain:

- gate
- readiness
- handoff
- release-bound

all now preserve the same operator contract.

## Files

Implementation:

- `scripts/ops/multitable-pilot-handoff.mjs`
- `scripts/ops/multitable-pilot-release-bound.sh`

Focused regression:

- `scripts/ops/multitable-pilot-handoff.test.mjs`
- `scripts/ops/multitable-pilot-readiness.test.mjs`
- `scripts/ops/multitable-pilot-release-bound.test.mjs`
- `scripts/ops/multitable-pilot-release-gate.test.mjs`

## Outcome

The operator replay model is now stronger than the earlier helper-path-only design:

- helper file is still preserved
- command entries are preserved through downstream artifacts
- checklist steps are preserved through downstream artifacts
- handoff and release-bound consumers no longer need to reconstruct the contract from gate markdown alone

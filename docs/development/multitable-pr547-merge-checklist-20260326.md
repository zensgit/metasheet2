# Multitable PR547 Merge Checklist

Date: 2026-03-26

## Goal

Provide a single merge-facing checklist for PR `#547` so approval, operator handoff, and post-merge verification use one consistent packet instead of scanning many follow-up comments.

## Why

PR `#547` is no longer blocked by a known implementation gap. The remaining risk is review/merge friction:

- reviewers need a shortest path through a very large branch
- operators need the canonical artifacts and replay helper locations
- merge owners need a minimal post-merge verification sequence

## Checklist

### 1. Reviewer entry

Start with:

- `docs/development/multitable-pr547-review-map-20260326.md`

Then spot-check these blocks:

1. route/runtime/OpenAPI contract alignment
2. embed host protocol runtime + tests
3. pilot evidence / gate / handoff / release-bound chain

### 2. Canonical proof artifacts

The branch already produced green local delivery-chain artifacts:

- `output/playwright/multitable-pilot-local/20260326-140830/report.json`
- `output/playwright/multitable-pilot-ready-local/20260326-143812/readiness.json`
- `output/playwright/multitable-pilot-handoff/20260326-143812/handoff.json`
- `output/playwright/multitable-pilot-release-bound/20260326-144138/report.json`
- `output/releases/multitable-onprem/gates/20260326-144108/report.json`

### 3. Operator replay contract

The canonical gate chain now preserves:

- gate report/log paths
- operator helper path
- machine-readable operator commands
- machine-readable operator checklist

Relevant docs:

- `docs/development/multitable-release-gate-operator-helper-20260326.md`
- `docs/development/multitable-operator-contract-artifact-promotion-20260326.md`

### 4. Merge owner checklist

Before merge:

1. confirm PR checks are green
2. confirm at least one approval is present or an explicit admin bypass decision exists
3. confirm no new tracked follow-up changes are pending on `codex/multitable-next`

After merge:

1. watch mainline checks for:
   - web/frontend tests
   - backend integration tests
   - pilot delivery-chain scripts if wired in CI
2. if a deployment/pilot operator needs replay, use the promoted operator helper from the merged gate artifacts instead of reconstructing commands by hand

## Outcome

This checklist does not change product behavior. It reduces the last approval/merge gap by turning scattered proof into one merge packet.

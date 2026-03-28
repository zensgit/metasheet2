# Multitable On-Prem Operator Contract Promotion Verification

Date: 2026-03-26

## Scope

Verify the clean slice that promotes the on-prem release-gate operator contract into:

- handoff JSON/markdown
- release-bound JSON/markdown

## Commands Run

```bash
node --check scripts/ops/multitable-pilot-handoff.mjs

bash -n scripts/ops/multitable-pilot-release-bound.sh

node --test \
  scripts/ops/multitable-pilot-handoff.test.mjs \
  scripts/ops/multitable-pilot-release-bound.test.mjs \
  scripts/ops/multitable-onprem-release-gate.test.mjs \
  scripts/ops/multitable-pilot-release-gate.test.mjs
```

## Results

- focused suite passed: `12 passed`
- shell syntax checks passed
- script syntax check passed

## Verified Behaviors

### Handoff promotion

Confirmed:

- `handoff.json.onPremReleaseGateOperatorContract.helper` is emitted
- `handoff.json.onPremReleaseGateOperatorContract.operatorCommandEntries` is preserved
- `handoff.json.onPremReleaseGateOperatorContract.operatorChecklist` is preserved
- `artifactChecks.onPremReleaseGate` mirrors the entry/checklist arrays
- `handoff.md` renders a dedicated `On-Prem Release Gate Operator Contract` section

### Release-bound promotion

Confirmed:

- release-bound reads the promoted handoff operator contract
- `report.json.onPremReleaseGateOperatorContract` is emitted
- `report.md` includes helper, operator commands, and operator checklist summary

### Compatibility

Confirmed:

- release-bound prefers top-level `onPremReleaseGateOperatorContract`
- falls back to `artifactChecks.onPremReleaseGate`
- degrades to empty arrays for older payload shapes

## Explicitly Not Run

Not run in this slice:

- full pilot-local
- staging live smoke
- deployment

## Conclusion

The on-prem operator replay model now survives the full pilot chain instead of being trapped inside the original on-prem gate report.

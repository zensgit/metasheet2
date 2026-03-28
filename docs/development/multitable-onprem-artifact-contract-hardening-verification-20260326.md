# Multitable On-Prem Artifact Contract Hardening Verification

Date: 2026-03-26

## Scope

Verify the clean slice that:

- makes the on-prem release-gate report self-describing
- removes handoff's dependency on guessed gate-relative artifact paths
- makes release-bound top-level `ok` reflect actual promoted acceptance state

## Commands Run

```bash
node --check scripts/ops/multitable-pilot-handoff.mjs

bash -n scripts/ops/multitable-onprem-release-gate.sh
bash -n scripts/ops/multitable-pilot-release-bound.sh

node --test \
  scripts/ops/multitable-onprem-release-gate.test.mjs \
  scripts/ops/multitable-pilot-handoff.test.mjs \
  scripts/ops/multitable-pilot-release-bound.test.mjs \
  scripts/ops/multitable-pilot-release-gate.test.mjs
```

## Results

- focused suite passed: `12 passed`
- shell syntax checks passed
- script syntax check passed

## Verified Behaviors

### Canonical on-prem gate paths

Confirmed:

- `multitable-onprem-release-gate.sh` writes:
  - `outputRoot`
  - `reportPath`
  - `reportMdPath`
  - `logRoot`
  - `operatorCommandsPath`
- handoff prefers those canonical fields when resolving report markdown/helper/log roots
- handoff no longer depends only on guessed `dirname(report.json)` layouts

### Truthful release-bound status

Confirmed:

- `multitable-pilot-release-bound.sh` no longer hardcodes top-level `ok: true`
- release-bound `report.json.ok` now flips false when promoted acceptance state fails
- staging fallback case still remains green when the promoted inputs are green

## Explicitly Not Run

Not run in this slice:

- real on-prem package release
- real staging live smoke
- deployment

## Conclusion

The on-prem and pilot artifact chain now uses explicit artifact paths and truthful top-level status, reducing downstream guesswork and false-green machine-readable reports.

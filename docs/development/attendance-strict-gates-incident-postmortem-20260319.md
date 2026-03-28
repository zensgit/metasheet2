# Attendance Strict Gates Incident Postmortem

Date: 2026-03-19
Incident issue: #189 `[Attendance Gate] Strict gates fast alert`
Final status: Resolved

## Summary

On 2026-03-19, production strict gates regressed and reopened fast alert issue `#189`.
The final user-visible failure mode was that the second sub-run inside the same strict-gates workflow failed `apiSmoke` with `DUPLICATE_REQUEST`.

The underlying recovery chain had two stages:

1. Earlier blockers in strict provisioning and audit write behavior were removed by:
   - `#500` `fix(attendance): prefer IAM role assignment in strict provisioning`
   - `#501` `fix(core-backend): make audit writes best effort`
2. After those fixes were actually deployed, the remaining failure was a deterministic smoke-date collision across the `-1` and `-2` sub-runs of the same strict-gates workflow. That was fixed by `#502` `fix(attendance): isolate strict gate work dates per sub-run`.

The recovery was verified by strict-gates run `23297478312`, which completed successfully on 2026-03-19, after which issue `#189` was closed.

## Impact

- Production strict-gates signal was red.
- The failure did not indicate a new production data-path defect in attendance request handling itself.
- The failure indicated that the strict-gates test harness was reusing the same synthetic `workDate` twice inside one workflow execution, causing the second sub-run to hit duplicate-request protection.

## Detection

- Fast alert issue: `#189`
- Escalation run: `23296371873`
- Initial gate summary for the new incident:
  - `provisioning=SERVER_ERROR`

## Timeline

### 2026-03-19

- Strict-gates failures reopened `#189`, with provisioning failures visible in runs including `23295251651` and `23296371873`.
- `#500` and `#501` were already merged, but production needed to be confirmed on the actual strict-gates target.
- Deploy behavior was verified against the real production target used by strict gates:
  - deploy workflow run `23296346631`
  - manual redeploy run `23296803074`
- After the manual redeploy, strict-gates run `23296937710` showed the incident had changed shape:
  - sub-run `-1`: all checks passed
  - sub-run `-2`: `apiSmoke=FAIL`
  - actual API error: `DUPLICATE_REQUEST`
- Root cause analysis confirmed both sub-runs were deriving the same synthetic smoke `workDate` from shared GitHub workflow metadata.
- `#502` was opened and merged:
  - PR: `#502`
  - merge commit: `cade7dd3a7b79377aa652cce1d5a57c4db939056`
  - merged at: `2026-03-19T13:33:43Z`
- Strict-gates was rerun on `main`:
  - run `23297478312`
  - both sub-runs passed
  - final outcome: `success`
- Issue `#189` was closed at `2026-03-19T13:39:15Z`.

## Root Cause

The strict-gates workflow runs the same smoke suite twice in one workflow execution to validate stability.
The smoke API test derived its synthetic `workDate` from GitHub workflow metadata:

- `GITHUB_RUN_ID`
- `GITHUB_RUN_ATTEMPT`
- `GITHUB_RUN_NUMBER`

That made the date stable across reruns, but it also made the date identical for both sub-runs inside a single strict-gates workflow execution, because those two sub-runs share the same GitHub run metadata.

As a result:

1. Sub-run `-1` created an attendance request for the derived `workDate`.
2. Sub-run `-2` reused the same `workDate`.
3. The second request correctly hit duplicate-request protection and failed with `DUPLICATE_REQUEST`.

## Contributing Factors

- Deployment traceability is still too indirect. The deploy path was using mutable image selection patterns, so verifying that production had picked up `#500` and `#501` required explicit redeploy confirmation rather than a simple digest/SHA match.
- The audit log monthly partition design still contains a latent gap: the current month partition is not guaranteed to exist before writes. This was investigated during the incident, but it was not the final root cause of the recovered failure.

## Resolution

`#502` fixed the strict-gates harness instead of changing attendance request semantics.

The implementation introduced `SMOKE_WORK_DATE_SEED` and passed `OUTPUT_ROOT` into the smoke layer so the two strict-gates sub-runs derive different but deterministic dates:

- `...-1` and `...-2` now map to different seeds
- each seed still remains stable for reproducibility

Files changed by the fix:

- `scripts/ops/attendance-run-gates.sh`
- `scripts/ops/attendance-smoke-api.mjs`
- `scripts/ops/attendance-smoke-workdate.mjs`
- `scripts/ops/attendance-smoke-workdate.test.mjs`

## Validation

Local validation for `#502`:

- `node --test scripts/ops/attendance-smoke-workdate.test.mjs`
- `node --check scripts/ops/attendance-smoke-api.mjs`
- `node --check scripts/ops/attendance-smoke-workdate.mjs`
- `bash -n scripts/ops/attendance-run-gates.sh scripts/ops/attendance-run-strict-gates-twice.sh`

Production validation:

- manual redeploy run `23296803074`: `success`
- strict-gates rerun before final fix `23296937710`:
  - `-1` passed
  - `-2` failed with `DUPLICATE_REQUEST`
- strict-gates rerun after `#502` merge `23297478312`:
  - `-1` passed
  - `-2` passed
  - overall run: `success`

Detailed implementation and verification notes are captured in:

- `docs/development/attendance-strict-gates-workdate-seed-development-20260319.md`
- `docs/development/attendance-strict-gates-workdate-seed-verification-20260319.md`

## Follow-up

These items should stay out of the incident-fix path and be handled as separate debt work:

1. `#503` Harden `audit_logs` current-month partition creation or self-healing at write time.
2. `#504` Improve deployment traceability so production deploys can be tied directly to immutable image digests or commit SHAs, with a post-deploy version check.

## What We Learned

- The strict-gates harness itself can create deterministic false negatives if sub-run isolation is incomplete.
- Recovery work should keep environment validation separate from code-fix validation. In this incident, manual redeploy was necessary to prove the earlier fixes were actually live before chasing the remaining failure.
- Latent design debt can surface during incident response, but it should only be fixed inside the incident if it is confirmed to be causal. The audit partition gap did not meet that bar for this incident.

# Time Machine current-main staging integration

Status: Draft/HOLD integration candidate. This combines existing authorized,
independently reviewed Time Machine slices; it does not ratify a new capability,
provider, custody profile, lifecycle policy or staging window.

## Frozen composition

- Main baseline: `2c9baca765134f1cc8f961ac872e3927011df894`.
- Previous actual local APFS execution: private `6d565f94f9c9142dc188500c4fc4b7c5c9ba3ad7`
  on main `6048aae25c6c2053b42019b1078ea80f524995c8`.
- Fresh source composition: `a948d05df3c3380539a83e8044bd4d09d1f0ad69`.
  All 43 authorized TM delta files match the previous candidate byte-for-byte;
  all 45 changed main files are retained. The tree differs from the previous
  local execution only in the five new on-prem package files from #6165.
- The publication carrier adds one necessary manifest field correction:
  `evidenceFiles.pluginTestsWorkflow` now binds the unchanged repaired workflow
  SHA256 `7229213b25c6ddc49bc795e90c8e5697488df22e80339a31f35271d0bb007cf9`.
  No other pin, guard, production module or policy is changed by this repair.
- Earlier Drafts #6183, #6195, #6199, #6201 and #6206 are dependency/review
  references. Their heads and evidence remain separate. Do not subsequently
  merge both this integrated closure and the old stacks as duplicate work.
  Final carrier identity comes from its PR head and immutable CI receipts.

## Verified evidence and limits

| Evidence | Observed result | Scope |
| --- | --- | --- |
| New package layout test | 15 PASS / zero FAIL / zero skipped | Existing Node fixture/static verifier test; not an actual built package |
| Package scripts | `bash -n` exit 0 | Syntax only |
| Old workflow pin | Existing full repository provenance test exit 1 | Expected RED; computed source differs in exactly this one pin |
| Corrected workflow pin | Same provenance test exit 0; S5 evidence neighbor exit 0 | Hermetic source/evidence consistency and existing negatives; no SQL/provider business execution |
| Prior local APFS dependency closure | All 58 recorded source hashes match | Prior runtime result remains executed at 6d565/main6048; not a new-head APFS replay |
| Local validation | `pnpm validate:all` terminal exit 0: plugin manifests, recursive lint, backend and frontend/verification types | First long-TMPDIR attempt hit tsx IPC EINVAL before validation; retained; short-path retry changes only the environment for the same runtime/test source and existing dependencies |
| Parent #6201 at 44b46c1 | Dispatch36811086338 terminal SUCCESS; both checkpoint9/239/0skip, Node20 archive14/312/0skip | Published parent SHA only; Node18 archive intentionally skipped |
| Child #6206 at daa6a0d | Dispatch36811776982 terminal SUCCESS; both checkpoint9/239/0skip plus two actual process-fault outcomes each; Node20 archive14/312/0skip | Published child SHA only; overlapping totals are not summed |

The prior owned APFS execution proves same actual manual-generation backup,
source unavailability, initially empty separate target, official FD3 launcher,
scalar/attachment/history recovery and two fresh OFF-process HTTP/no-write
rollback witnesses across 22 compared tables. Its 5001-row/two-chunk/effects
control is a separate fixture. It is the synthetic NON-KMS local logical-loss
profile, not independent-host disaster recovery or the original D7 profile.

The unchanged timestamp migration remains subject to the existing canonical
apply/replay and rollback gates; no target migration was applied by this carrier.
Actual staging rollback restores the previous build/flag posture, never migration
`down()` or manual object/key deletion.

## Completion gates

| Gate | Required evidence / current state |
| --- | --- |
| Exact current-main PR checks | OPEN until the published integrated head has all 13 main-required contexts; strict source census must prove the archive files actually executed without skips |
| Full package build/verify | NOT RUN; no shipped artifact or package-runtime acceptance claimed |
| Full D7 independent provider / staging KMS | OPEN; original runbook prerequisite unchanged |
| Original D-H2 and D-L | OPEN; manual source-recheck and abandoned-only cleanup do not prove durable-block/RR or verified-expiry/key lifecycle |
| Phase5 scheduled failure attribution | OPEN; local exporter/parser cases are compatible evidence, without live raw scrape/deployed SHA/operation receipts |
| Actual controlled staging and rollback | NOT EXECUTED; requires owner environment/profile/configuration references and explicit flag/rollback window |
| Production acceptance | OPEN; no production operation authorized |

Required procedure: `multitable-timemachine-phase-d7-staging-runbook-20260829.md`.
The goal remains the complete controlled staging acceptance; this carrier does
not reduce it to local tests or green CI. Defaults remain OFF. No Ready, merge,
flag change, deployment, customer data, remote provider/KMS, retention or key
operation is authorized by this report.

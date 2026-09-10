# Attendance Acceptance Tooling Hardening Verification

Status: published Draft/HOLD; historical remote success and new replay evidence are separate.
Current publication baseline: `70dc72d7671cad9cea1925ed93f90d3d9c746aeb`.
Previous publication baseline: `177cafd3e34f30b5fc2682b3d392684c92fe67fe`.
Initial implementation baseline: `fdee94dc4997f68ab7cfb0b06b11b6364a05f3aa`.
Branch: `codex/attendance-prod-acceptance-hardening-20260902`.
Verified code checkpoint: `959ce7d3eeb9afb8392c72a95b57f0ab2a59b037`.
Code tree: `474e660c1a6774f5c4beebfcc8e042c884b39862`.
Code parent: `39bf9ac6d705a21b59cc43c3ddc130608e88f1ef`.
The report-only child changes no tested code, test, schema, or workflow bytes.
Design/development: `attendance-acceptance-tooling-hardening-design-20260905.md`.

## Historical Replay

Replay head `51f5c5aecd8d16c9d14ed0a30395a7a23117ff90`, tree
`a4522e18c6c104e3a44a965723bc313c50ac6dca`, has ordered parents
`0d506e426411e89cb69659787b7e6c36fc1305d2` and
`177cafd3e34f30b5fc2682b3d392684c92fe67fe`. The merge was conflict-free;
the only first-parent delta is main's delivery-guide documentation. `scripts`,
`.github`, and `schemas` are byte-identical to the verified code checkpoint.
The same local gates below were rerun on this replay tree before publication.

## Current-Main Replay

Replay head `3d6eb914d0b7f411cf1c4ba9a49b37a5d9c88f03`, tree
`75497558e1a78eddc462b3c9b26aeb04d80673d1`, has ordered parents
`62c8708f015bcb7853b641f8b0c62463b592b9d2` and
`70dc72d7671cad9cea1925ed93f90d3d9c746aeb`. This is a conflict-free true
merge, not a docs-only main advance: the first-parent delta is exactly the four
stock-preparation files from main, including the appended required-Web selector.
The 30 candidate-owned paths are byte-equivalent to the prior published head;
the remerge-diff is empty. Strict 275 plus neighbors 38 and syntax 22 were rerun
on this replay and all passed. Report updates are a separate docs-only child.

## Historical Remote Evidence

[PR #5484](https://github.com/zensgit/metasheet2/pull/5484) at exact
`62c8708f015bcb7853b641f8b0c62463b592b9d2` reached 20 SUCCESS,
zero skips, failures, or pending checks. The actual required strict job
`101236890029`, run `33940514594`, logged all five groups
99/7/5/17/147 passing with zero skips, plus summary validation. This proves
execution rather than merely workflow registration. Main advanced meanwhile;
these results do not validate the new replay's remote head or merged main.

## Local Gates

Runtime: Node 20.20.2, matching the required contract lane's major version.
The isolated checkout reused installed AJV 8.17.1 and js-yaml 4.1.1 through
`NODE_PATH`; no package, lockfile, dependency installation, or runtime service was
changed. CI installs the existing frozen lockfile as before.

| Gate | Result | Scope |
| --- | --- | --- |
| Full `contracts (strict)` runner | PASS, 275 tests | 99 owning hermetic tests + 7 advanced-import + 5 override-modal + 17 smoke/date/classifier + 147 existing window-runner tests |
| Workflow neighbors | PASS, 10 tests | Existing prod auth fallback and locale contracts |
| SSH and longrun neighbors | PASS, 28 tests | Required host-key family behavior/census and longrun workflow |
| Shell and Node syntax | PASS, 22 files | Every changed/new `.sh` and `.mjs` |
| Summary validators | PASS | Valid historical fixture accepted; invalid fixture rejected; proof required in strict mode |
| Diff whitespace | PASS | `git diff --check` |

Commands, from the repository root with the existing dependencies available:

```sh
bash scripts/ops/attendance-run-gate-contract-case.sh strict artifacts/attendance-acceptance-hardening/final-node20
node --test scripts/ops/attendance-prod-auth-fallback-workflow-contract.test.mjs scripts/ops/attendance-locale-zh-workflow-contract.test.mjs
node --test scripts/ops/attendance-import-perf-longrun-workflow-contract.test.mjs scripts/ops/ssh-hostkey-pin-family-behavior.test.mjs scripts/ops/ssh-hostkey-pin-family-contract.test.mjs
git diff --check
```

Total across the final runner and these non-overlapping neighbors: 313 tests.
The SSH behavior neighbor initially had five red attendance cases because its
fixtures omitted the new explicit organization precondition. Only those fixture
inputs were aligned; every host-key, no-SSH, token, and cleanup assertion remains.

The six owning suites executed by the strict runner are:

- `scripts/ops/attendance-acceptance-preflight.test.mjs`
- `scripts/ops/attendance-acceptance-wiring.test.mjs`
- `scripts/ops/attendance-provision-user.test.mjs`
- `scripts/ops/attendance-verifier-contract.test.mjs`
- `scripts/ops/attendance-auth-scripts.test.mjs`
- `scripts/ops/resolve-attendance-smoke-token.test.mjs`

## Discriminating Evidence

| Guard removed or regressed temporarily | Observed result after mutation | Restored result |
| --- | --- | --- |
| Active membership proof for deploy-host token | Resolver test RED | Resolver suite 6/6 |
| Exact `/auth/me` tenant match | Auth suite RED | Auth suite 17/17 |
| Container transport of synthetic org | Resolver transport test RED | Resolver suite 6/6 |
| Visible workspace before quick-jump | Two navigation tests RED | Verifier contract GREEN |
| Global directory request scope | Request-shape test RED | Verifier contract GREEN |
| All 404 responses permit legacy grants | Five semantic/unknown-404 tests RED | Provision suite 12/12 |
| Independent post-assignment readback bypassed | Four readback tests RED | Provision suite 12/12 |
| Post-refresh provisioning tenant check omitted in a copied fixture | Four tenant/call-order tests RED | Expanded provision suite 16/16; real source unchanged |
| Observed/expected deployment equality disabled | Deployment mismatch test RED | Preflight suite 17/17 |
| Owning strict-runner test invocation deleted in a copied fixture | Required-wiring test RED | Restored fixture GREEN; real source unchanged |
| Workflow expected-tenant binding deleted in a copied fixture | Workflow-wiring test RED | Restored fixture GREEN; real source unchanged |
| Each of three consumers omits refreshed-token proof | Five tests RED per consumer | Verifier suite 26/26 each restoration |
| Each of three consumers omits effective-token entry proof | Two tests RED per consumer | Verifier suite 26/26 each restoration |
| Full-flow feature catch swallows tenant-proof failure | One test RED | Verifier suite 26/26 |
| Finalization ignores failed attempt and reads earlier green summary | One test RED | Wiring suite 10/10 |

All temporary mutations were restored before the full Node 20 gate. Test inputs
are local fixtures. Token/SSH/Docker/pg requests are stubbed; provisioning uses a
temporary loopback HTTP server; navigation uses a fake page with visible-state
semantics. No real backend, browser acceptance target, or deployment host was
contacted by these tests.

The wiring and consumer deletion mutations ran against disposable copies. Their
restored positive controls passed and original source SHA-256 values were
unchanged. The new consumer/provenance counterexamples initially produced
26 failures with 31 existing positives; after implementation the same 57 tests
passed. Three additional catch-propagation cases also pass in the final runner.

## Review Provenance

Sol implemented the isolated four-file auth/token subset. Terra implemented the
isolated navigation/directory subset. Codex integrated provisioning, provenance,
workflow wiring, tests, and final verification. No two agents wrote the same file.

The first independent Astra review ended with an account usage-limit error and
returned no verdict. It is not counted as an approval. Independent review results
must be recorded separately from the implementation agents' local test reports.

A fresh Astra review confirmed two P1 failures: consumer token refresh bypassed
the shell tenant proof, and second-run provenance failure could be masked by
the first run's successful report. Both were independently reproduced and fixed
with the tests/mutations above. Fresh post-fix Astra source review returned
0 P1 / 0 P2 / 0 P3 for those two fixes, covering the helper, three consumers,
strict finalization, and three owning test files. It did not run tests or contact
targets; test/mutation results above are coordinator evidence. Its session was
closed. Grok 4.6 exceeded its bounded review window, was stopped and closed,
and returned no terminal verdict.

## Remaining Gates

| Evidence or operation | Status |
| --- | --- |
| Previous published head `62c8708` | 20 SUCCESS, zero pending/failures; strict execution log verified |
| New current-main replay remote checks | PENDING PUBLICATION; no old-SHA result carried as new CI |
| Ready / merge | Separate owner authorization required |
| Merged-main verification | NOT RUN for this candidate |
| Explicit synthetic-org target configuration | Operator-owned, not changed |
| Live `/auth/me` and backend build provenance | NOT RUN |
| Real Chromium acceptance at a deployed target | NOT RUN |
| Production grants, SSH fallback, import/punch smoke | NOT RUN |
| Flags / dispatch / deployment / staging / production | NOT AUTHORIZED; no action |
| Time Machine whole-sheet recovery | PARKED; no change |

Main's Phase 5 scheduled-validation failures are a separate ops observation, not
this candidate's remote CI result. They are not reclassified as passes or silently
rerun here. The current patch does not change those workflows.

Read-only diagnostics of those separate scheduled runs found: an unconfigured
dependency-install chain on Node 18; six latency assertions marked `na` because
no relevant histogram samples matched; a reported memory-baseline regression;
and an unguarded missing notification configuration. Whether missing samples or
baseline drift reflect instrumentation/runtime changes is unverified. No
threshold, baseline, `na` policy, runtime endpoint, or schedule was changed.

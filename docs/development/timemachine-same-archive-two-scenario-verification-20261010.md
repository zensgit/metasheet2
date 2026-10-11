# Time Machine two-scenario local repair verification

Status: local implementation and mocked verification PASS; native same-archive
qualification and the overall controlled-staging goal remain HOLD.

Owner approved the two-scenario contract on 2026-10-10. Implementation is on
`codex/tm-main7723-integration-20261009`, based on
`0a111bbd81c137a9eda0ed55264340f7ddf4b065`. The post-commit exact source receipt
and private logs are under `artifacts/tm-two-scenario-local-repair-20261010/`.

## Implementation

The existing backup driver now creates a source and two distinct empty owned
targets. Both import the same quiesced SQL dump and receive archive/custody
copies before either restore and before the source is removed. Imported manual
rows, nonce tuples, custody bytes and object-store identity are checked; each
child's actual database OID must match its registered target identity. All three
databases participate in identity-bound non-FORCE cleanup and residue census.

Scenario A retains official HTTP/launcher behavior, actual first-chunk process
death, natural lease expiry and fresh-process takeover. Scenario B stops the
official setup service normally, rejects an already-claimed job, and prepares
the actual local composition with canonical worker callbacks. The two logical
workers keep their genuine claim objects in the same test child. The old
original object must fail both binding and chunk calls with LEASE_LOST while
all public-table digests and the record-chain sequence remain unchanged.
The new claim then finishes through the real chunk and finalize APIs.

Both targets share the existing 5000+1, once-only row, first-chunk, aggregate,
derived-drain, attachment and fresh OFF rollback assertions. The pure receipt
judge requires both scenarios, identical generation/backup binding, distinct
target OIDs and each rollback witness. Tuple-only and incomplete results remain
HOLD with a nonzero CLI exit. A conditional source-code PASS is not an executed
native acceptance result.

No production `src/` file, feature flag, package/lockfile or workflow changed in
this repair. There was no native execution, platform-request submission, remote
publication, merge, deployment, staging flag window or customer data access.

## Local validation

All commands used Node 20.20.2 and the normal backend Vitest configuration.
No test-name filtering or retries were used locally.

| Check | Result | Scope |
| --- | --- | --- |
| 12 local acceptance/cleanup unit files | 94 PASS, 0 skipped | Actual receipt expressions, IPC validation, custody/process/path cleanup and mocked two-worker orchestration |
| Whole async-restore and local-startup unit neighbors | 38 PASS, 0 skipped | Existing facade/startup unit behavior; no live DB/native exercise |
| `tsc -p scripts/tsconfig.recovery-archive-acceptance.json --pretty false` | exit 0 | Existing acceptance scripts plus both new helpers |
| `pnpm validate:all` | exit 0 | Plugin manifest validation, lint, workspace type checks |
| `git diff --check` | exit 0 | Patch formatting |

The 28 new tests include SQL-observed natural-expiry ordering, exact original
claim reuse, invalid-input versus lease-loss discrimination, refused binding
and chunk calls, table/sequence mutation detection, cancellation, wrong
job/generation, and incomplete/mismatched pair judgement. The file is collected
by `vitest.config.ts`; the existing `Run core-backend tests` workflow step runs
the package's normal `test` command. The workflow was not changed or remotely run.

Two deliberate mutations were executed sequentially and restored byte-for-byte:

- Allow tuple-only qualification: 1 FAIL / 27 PASS; exit 1.
- Clone the old claim for the refusal call: 5 FAIL / 23 PASS; exit 1.

The restored full new test file then passed 28/28, exit 0. These repeated tests
are not added to the 132 distinct tests above. The initial focused command also
contained a nonexistent additional neighbor filename; only the 12 collected
files are counted. The actual whole-file neighbors were then run separately.

## Database-admission follow-up

The subsequent source audit found that `createOwnedDatabase` still rejected the
new stale target before either scenario could execute. A test invoking that
actual private function with a mocked database reproduced 3 FAIL / 5 PASS.
The creator now admits exactly the current run's source and two target names,
and records stale-target creation immediately after CREATE so that a later
identity-read failure cannot leave the cleanup flag unset.

The eight admission tests and four whole-file safety/cleanup/verdict neighbors
passed 32/32 with zero skips. Acceptance-script typechecking exited 0. Opening
the name guard caused 3 FAIL / 5 PASS; removing the creation flag caused
2 FAIL / 6 PASS. Source bytes were restored after each mutation, and the restored
eight tests passed. These are mocked checks; no database or native driver was
started. Earlier 132-test results remain historical evidence for the previous
commit and are not presented as rerun on this follow-up.

`pnpm validate:all` and `git diff --check` also exited 0 for this follow-up.

Private logs and the post-commit source receipt are under
`artifacts/tm-stale-target-admission-repair-20261010/`. This fixes a local
execution blocker; the remaining native and staging gates below are unchanged.

## Imported-control ordering follow-up

The next source audit found an older planned seeded control in the shared dump.
The production selector orders eligible jobs by creation time. Scenario A had
finished and drained its copy, but scenario B had not; its setup worker or either
controlled claim could therefore select the seeded job instead of the genuine
captured-archive job. A mocked execution of the actual driver's ordered control
and manual statements reproduced this failure before the repair.

Both targets now finish and drain their own imported control before admitting
their manual scenario. The existing control assertions were moved to a shared
test-only sibling module without dropping their finish, lifecycle, restored-row,
terminal, derived-effect or exactly-once checks. The worker launcher admits only
the matching owned database URL/name and exact archive/custody roots. Production
selection policy, job/lease rows, clocks and genuine claims are unchanged.

Ten whole unit files passed 93/93 with zero skips. Acceptance-script typechecking,
`pnpm validate:all` and patch formatting exited 0. Removing the second control
caused 1 FAIL / 16 PASS; allowing a different database URL caused 2 FAIL / 15 PASS;
ignoring derived completion caused 1 FAIL / 16 PASS. Both edited source files
were restored byte-for-byte, and the full 17-test file then passed.

The tests use mocked worker/database IO and a synthetic fork boundary. They do
not execute the native driver or start its services. Private logs and the exact
post-commit receipt are under `artifacts/tm-seeded-control-order-repair-20261010/`.
Earlier commits' test results remain historical. This follow-up has not been
published, remotely tested or deployed; the native and staging gates remain open.

## Remaining gates

| Gate | Verdict |
| --- | --- |
| Approved local contract and reviewable implementation | LOCAL PASS |
| Genuine current-source two-target APFS backup/restore and full cleanup | HOLD; not attempted while historical platform review is unresolved |
| Independent implementation review and exact-source required remote CI | OPEN |
| Phase 5 live failure attribution and deployed identity | PARTIAL / OPEN; unchanged by this repair |
| Independently durable staging provider and staging test key | OPEN |
| Owner staging configuration, deployment/flag window and rollback authorization | OPEN |
| Actual staging and rollback acceptance / TM overall completion | OPEN |

The original controlled-staging objective is preserved. Approval of this local
repair does not grant any of the remaining external execution gates.

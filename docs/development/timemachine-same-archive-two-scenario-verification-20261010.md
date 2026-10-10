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

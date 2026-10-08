# Time Machine owned generation composer verification

Status: locally verified dependent Draft/HOLD slice; overall TM remains OPEN.
Implementation baseline `0e8f5c26c552df350c70c81a4f6729efa346350d`.
Current parent `f3e730e9c12fb5712560288fac5ae103397747eb` is the test-only
cleanup-mock correction to prerequisite Draft #6239. The disjoint local fast-forward
preserved all 23 owned modified/untracked files and the then-frozen 67 production inputs.
No GitHub merge or rebase occurred.

The design-lock was frozen before production edits; its current digest is
`c52d610d766a76fedf27f0bef8b13c6be047c6d1bfe31a8265e77254424e4ab3`.
The existing D1/D-H2 contract remains authoritative. Both existing flags must be
literal `'true'`; the unselected legacy command and existing hash/format/migration
contracts remain unchanged. No new flag, migration, shared-pool normalization,
provider capability or owner exception was added.

## Implemented and exercised result

The actual manual command now composes genuine committed claim, fresh bounded RR
capture, released-transaction immutable attachment reads, available source pins,
pure future-history planning, confirmed permanent nonce batch, signed persisted
ciphertext, genuine PUT/HEAD receipts and atomic finalization. Production wiring
carries the server native pool and explicit closed manual capture limits.

Populated first bootstrap and repeat checkpoint after a real ordinary view PATCH
each produce complete authenticated recoverable generations. Each generation has
exactly 28 future coverage candidates: nine revisions, nine child endpoints, nine
memberships and one parent endpoint. This is current-generation coverage, not all
retained history. Actual raw reservation timestamps, revision IDs and parent-last
ordering are separately checked with real SQL and armed triggers/FKs.

The archive includes both live and soft-deleted local attachment bytes. Every
attachment/custody/provider callback observes transaction depth zero. All ten section
nonces plus both attachment nonces commit before AEAD; prepared signed bytes commit
before the first PUT. Genuine nonce collision, final-history failure and provider
failure leave no partial publication and retain the appropriate pin/nonce/prepared
evidence. Owner-safe abandonment tolerates permission/key/lease/flag loss and cannot
clear a successor block. Duplicate POST is status-only; it does not resume interrupted
owned uploads or reconstruct private capabilities.

An uncertain claim COMMIT issues no downstream capability. An uncertain final COMMIT
reports success only after authorized durable recoverable-status readback; failed
readback does not guess success. Primary deadline poisoning forbids late source or
provider continuation/publication. Exact-owner cleanup has its own bounded timeout,
so total public-call time is not claimed to equal the primary deadline exactly.
The byte bound covers accepted staged representations and the new opened-file reader,
not total process RSS or every existing crypto/serialization copy.

## First failures, independent review and refutations

The unchanged legacy caller already performs full capture. The qualified original
native baseline failed a named assertion because external callbacks saw no committed
owned block and future history was already committed before PUT. That fixture had
58 genuine migration ups; a separate legacy-finalization refusal came from the missing
existing coverage-binding migration and is not counted as the phase counterexample.
Normal verification applies all 59 genuine ups, including that existing migration.

Independent source review found five defects: reusable released query, incomplete
attachment identity comparison, stale server statement timeout, delayed handled-timeout
cleanup and raw error propagation. Native pre-fix counterexamples reproduced all five;
the same cases pass after repair. Stronger coverage includes equal-count ID replacement,
seven metadata drifts, pending PUT cleanup before latch release, actual late native table
lock cancellation and separately labelled controlled COMMIT transport delay.

A further real SQL counterexample moved the same active/unpruned checkpoint floor
above the claimed anchor after released RR capture. The old implementation still returned
recoverable, published verified and committed 28 history rows. One shared binding predicate
`t.trusted_since_seq <= a.anchor_seq` closes capture and all subsequent phase rechecks.
The unchanged counterexample passes after that one-predicate repair.

Root independently removed each of those six guards and ran the whole 42-case native
file. Every run exited 1 with a matching named AssertionError and zero skipped cases;
actual pass/fail counts were 41/1, 34/8, 40/2, 40/2, 40/2 and 41/1. Only the intended
source differed in each run. All 130 distinct inputs in the native-128/production-67
union were exactly restored; root's final whole native file passed 42/42, zero skip.
Independent source and refutation-evidence audits both returned bounded NO_BLOCKER.

## Executed checks and retained evidence

| Check | Actual result |
| --- | --- |
| Whole focused unit union and storage/cleanup/orphan neighbors | 19 files, 458 PASS, zero skip |
| Final native composer file | 42 PASS, zero skip; sentinel 1/native 41 |
| Adjacent whole owned-capture and fresh-writer native files | 36 + 16 = 52 PASS, zero skip |
| Real migrations and actual authority trigger census | 59 ups per composer fixture; nine `O` triggers |
| Armed composer without DATABASE_URL | expected exit 1; sentinel FAIL 1/native actually skipped 41 |
| Static native roster/exclusion/omission checks | 22 PASS |
| Armed fail-not-skip roster | all 22 native children checked |
| Backend and targeted native TypeScript | exit 0 |
| Configured `pnpm validate:all`, official provenance and diff check | exit 0 |

Native commands use `pnpm --filter @metasheet/core-backend exec vitest run --config
vitest.integration.config.ts` with the whole named file, verbose and JSON reporters.
Adjacent files are `multitable-recovery-archive-owned-capture-realdb.test.ts` and
`multitable-recovery-archive-fresh-writer-admission-realdb.test.ts`. Full exact unit
argv and per-file census are retained with the process receipt. No workspace-wide
test run or whole-workflow zero-skip claim is made.

Ignored retained evidence lives under `artifacts/tm-owned-generation-composer-20261007/`:

| Receipt | SHA-256 |
| --- | --- |
| `production-trust-floor-repair-freeze-20261007.json` | `8c445dac1492b4fa2898f78719374484b7fe6ff05257d77a49b7aac1818061ba` |
| `final-source-unit-handoff-20261007.json` | `79608ef13cf5e64c87ea7c5083e48b5ef2a174e627b5a8831b7517191d56c638` |
| `native-pg/native-trust-floor-final-handoff.json` | `5f68a6d124e6b536818f022f77b6cb546bc26db52209c0a3dabda8bb6218746b` |
| `root-source-mutations/source-mutation-receipt-final.json` | `21c6adf77cc5c1e6cbc3da73743f93663af052328a8a4511b37cebb027d0ff71` |
| `root-source-mutations/independent-refutation-evidence-audit-20261007.json` | `3d45ee6ba7dda8a35544ada2a7543eb9b827e62e531ccbe980dfd507db81c454` |
| `independent-owned-composer-final-source-review-20261007.json` | `92d359f6d55a029b53fcf2d057859e71b2fcb70f5746916ea27381a348229f4a` |
| `native-cleanup-manifest-20261007.json` | `14d589f6837cb4c09fd5e4d390dd3d16c0d159866a0e266ffce86e456e44c513` |
| `root-native-cleanup-independent-live-readback-20261007.json` | `05e1067cc566aaff3f800bffe8186ec236687e4b7c282b033affce0623b18892` |

All original failures, source copies and infrastructure/type/expectation corrections
remain retained. The first whole42 retry failed listener startup before business
assertions; it is infrastructure evidence, not a guard RED. The unchanged old/current
startup suites both retain the same 16 host-filesystem refusals; these are not called
green. Early orphan-fixture count/namespace preflights aborted before writes. Live
census found two owned nested-retention fixtures, both independently bound to the
own data directory/role/synthetic sheet and privately pg_dump-backed up before cleanup.
Official PG15 fast stop exited 0, status exited 3; PID file/listener/profile are absent.
Stopped initialized data, readable backups and all raw evidence remain. No earlier
cluster was restarted; LC1..LC6 roots were not retired or deleted.

## Gate boundaries

| Gate | State |
| --- | --- |
| Owned whole generation/local assertions/refutations/independent review | PASS within this slice |
| Published exact-source ordinary CI | OPEN; source publication and terminal raw qualification required |
| Production file provider and integrated same-archive APFS backup/restore/crash/rollback | OPEN |
| Owned durable upload continuation, process-kill/expiry/lifecycle | OPEN |
| Full production writer/deleter runtime closure | OPEN |
| Historical Phase5 attribution and independent provider/KMS durability | OPEN |
| Exact-SHA owner ratification, Ready, merge, flags, deployment/staging | OPEN / owner gated |
| Overall Time Machine | OPEN |

The native provider is a test-environment genuine filesystem adapter with local
NONKMS custody. It does not qualify the production file provider. Read-only native
inspection separately established that this host's APFS has runtime type26 and HFS
type25, whereas the unchanged Darwin policy admits25. A numerical 25-to-26 edit would
not establish filesystem identity; a separate narrow admission repair and real
production-provider APFS rehearsal remain required. No new provider/flags, staging,
real tenant data or key-disposition action occurred.

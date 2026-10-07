# Time Machine G2 foreign-sheet recovery admission verification

Status: bounded local admission PASS; ordinary exact-source CI and full Time Machine remain OPEN.
Implementation started on `9a07ffd313a8463de59d329ac6901199c1f82f19` after the slice lock was frozen.
Final parent is `baf83a40a4b5eeb53565fa0497722ce4f71ddf39`, the test-only #6231 fence-holder
collection correction. Its fast-forward integration preserved every frozen G2 implementation input.
Authoritative slice: `multitable-timemachine-foreign-reset-admission-design-lock-20261007.md`.
Frozen lock SHA256: `93ae8c1e0bd24bf82afd71aaa1f6ea727ccd4f394993a9f18fc7b5820512ed6a`.

## Result

Hot reset and synchronous archive recovery previously fenced all discovered participants but checked
only the source block. Async prelock checked no foreign block. Either path could delete an inbound
edge belonging to a foreign sheet whose committed archive claim captured that edge.

The existing two literal-`true` archive-protection flags select the additional admission. Its owned
transaction establishes and verifies READ COMMITTED before any snapshot-bearing probe/discovery;
discovers the complete ordered participant set; acquires its fences once; rediscovers and refuses
set drift before token burn; then directly checks every participant's durable block. Only an existing
row with NULL state admits an ordinary writer. Recognized blocks, including expired archiving, refuse;
missing schema/row and unknown states fail closed. The later locked authority scope must be covered
by the originally admitted set before business mutations. NOWAIT alone does not establish this protection.

Async prelock checks every foreign participant while preserving the existing source-holder exception.
Its module-private fence lease binds the exact query, source and frozen participant set. The actual
apply still proves the complete accepted job/key/archive/chunk/owner/fence/lease tuple. Admission drift
is rethrown to the existing retryable worker path; normal RC pause preserves the source-owned block.
Selected synchronous HTTP now maps a recognized block to the existing values-free 409 response.

Every unselected path preserves the existing SQL, normalized legacy flag, source-only block behavior,
isolation and error mapping. No new flag, migration, provider operation, key mutation or runtime archive
composer is introduced. A caller DTO cannot acquire the private source exception.

| Frozen input | SHA256 |
| --- | --- |
| recovery-foreign-admission.ts | 85a1cabb002a0d7afd6aed25d8d16bfd9ef5afdd1258ad8647d9e2aa3687e7e2 |
| exact-anchor-recovery-execute.ts | a04b1826d1b66f8e3ce728e8a41777c9e3a9a03a3ea67d652bed9792ee1bb374 |
| recovery-archive-restore-owner.ts | 401a4fe296c80a0b104735a055b07bbab33df924bc0b2bafb825488c3e94de54 |
| focused unit spec | 864c0c226845262fa0170590206ff761d7e8c4b41f931cd9b1b5c73f0a4eefd0 |
| final native spec | 89efbe8062d507770136ad3ad235431fee28a5f23a77c26a80552d0e9046ad60 |
| new native fixture | df05292f7d23dbb733373754866aa1d0e4fc67193af9e917b97e000f2451bcda |

## Executed evidence and limits

- Seven whole focused files pass 175/175, 0 skip: admission52, owner-route39, async16,
  sync-restore10, sync-execute6, route-authority2 and the preserved field-holder guard50.
- The new whole native spec passes 25/25, 0 skip: sentinel1 and native24. Every normal fixture
  executes 54 real existing migration ups and observes nine enabled authority triggers. No fake
  business SQL result, disabled migration guard or substitute DDL is used. Principal/provider IO
  are synthetic. The adjacent unchanged G1 whole native spec independently passes 43/43, 0 skip.
- Actual Express hot preview/execute positive controls commit the legitimate burn/seal and remove
  the inbound edge. Genuine nonempty Phase1 claims on the foreign sheet cause exact values-free
  hot and sync 409 refusals with the full durable snapshot unchanged, in both lexical sheet orders.
  Actual advisory waits prove claim-first and recovery-first ordering, including genuine inherited
  RR independently configured before BEGIN. Self-links deduplicate; a real new participant/claim
  between discovery and fences refuses without late fencing or an early burn attempt.
- The actual accepted async job uses 5001 real delete operations and legal frozen partitions
  of one plus 5000. Its first one-operation chunk commits while preserving the genuine source
  restore owner; the foreign-claim control refuses before chunk/progress/seal/link mutation.
  Normal RC worker execution pauses retryably, preserving the source owner. Cloned, expired and
  superseded worker bindings refuse. This is not a full 5001-operation restore or default-builder proof.
- Three actual archive-flag OFF spellings retain legacy foreign mutation, source-only checking
  and no new SET/SHOW. The focused unit matrix covers 24 unselected flag pairs. Native SHOW
  interference executes a real RR SET after the real RC SET and verifies closed refusal.
- Eleven source mutations each have actual exit1, a matching named raw AssertionError, whole-file
  census and zero skips: nine native25 runs and two focused unit52 runs. Each eight-input snapshot
  changes only the named production file; test bytes do not change. Exact restoration is followed
  by another whole native25 PASS. The hot-RC mutation proves response drift, not a committed unsafe
  write. Early-set removal reaches a real burn INSERT before rollback. Late-scope and unknown-state
  mutation evidence is defensive unit coverage, not an additional native race qualification.
- The final native assertion amendment only replaces two lines with a resolves matcher for the
  same committed-kind result. Original normal manifest/spec, failures and evidence remain retained;
  root reran normal25 and all mutations at the final spec hash. Independent final source/evidence
  review reports NO_BLOCKER and does not claim to have executed the tests.
- Node static wiring16 and behavioral harness1 pass, 0 skip. The harness executes all19 armed
  archive realDB children, each failing its exact missing-DATABASE_URL sentinel. The new whole spec
  is present in Node20's realDB union and excluded from no-DB collection. Only the workflow
  provenance leaf changes to `68a9591ceb04bc320f45e264bc569f96639432c1a2e89748ae158da7137f1342`;
  the existing standalone sealed-export provenance guard exits0.
- Focused production/unit and final native-spec TypeScript checks exit0. `pnpm validate:all` exits0,
  including the configured backend/archive-acceptance/web checks. Frozen inputs stay unchanged.
- The dedicated PG15 has zero scratch/non-system databases and other clients before official
  fast stop (exit0). PID/listener/postmaster.pid are absent, TCP is refused and the private profile
  is removed. Initialized stopped data, all earlier failures and essential evidence are retained;
  root independently verifies the live postconditions and unchanged eight final inputs.

Evidence directory: `artifacts/tm-foreign-reset-20261007/` (ignored, retained locally).
Original native normal manifest SHA256: `b9078fbaa9f5e77925aa5c4fcdad3baf94305e75b624dc9dbb76c34b8e6d6a5f`.
Independent final mutation/evidence audit SHA256: `3dfd6bff0d9cfebf80d6ac2163e53321110b9e865b0db34e3ef1245138bc1cdd`.
Root final local-check receipt SHA256: `403da7add394a6c5d3ed217b5c36c44f1a2e0fc06d742a86d4650d39b9a1b495`.
Native cleanup manifest SHA256: `803271fc5fad2363096ca24604fade53b963db0e98b0f7a3e7a67a4ab371cda8`.
Root live cleanup readback SHA256: `2722d21af446bc9a683638873b6812b7ef31f616dbf50766a4be5fe938e4eb27`.
Earlier native migration-order, descriptor/token, collection and test-only type errors are retained.
The initial root assertion-amendment reader failure occurred before any database/test invocation.

## Gates and reproduction

| Lock gate | State | Evidence boundary |
| --- | --- | --- |
| Positive control / real HTTP refusal / ordering | Local PASS | Real routes, genuine claims, native waits, both lexical orders |
| Fresh participants / isolation | Local PASS | Real new-edge claim, inherited RR and actual SHOW interference |
| Async ownership / retryable foreign refusal | Local PASS | Genuine accepted job and source tuple; actual facade and normal RC worker |
| Closed trust / flag parity | Local PASS | Native missing-row/OFF controls plus focused unknown/schema/full flag matrix |
| Refutation / local CI contract / configured checks | Local PASS | Nine native plus two unit REDs, exact restored PASS, whole-file wiring and armed sentinel |
| Ordinary exact-source CI execution | OPEN | Requires new published source and actual terminal raw census |
| Full writer closure | OPEN | G3 retention and remaining source/worker/deleter races |
| Complete D-H2 / D-L / D7 | OPEN | Owned bytes/crypto/finalize/abandonment, lifecycle and integrated fixed-source APFS |
| Owner stages | OPEN | Exact-SHA ratification, merge, flags, deployment and staging inputs |

Use an owned disposable PG with DATABASE_URL supplied privately; fixtures create/drop namespaced databases.

```sh
METASHEET_REAL_DB_TEST_STEP=1 pnpm --filter @metasheet/core-backend exec vitest run --config vitest.integration.config.ts tests/integration/multitable-recovery-archive-foreign-reset-admission-realdb.test.ts
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/multitable-recovery-foreign-admission.test.ts tests/unit/multitable-recovery-archive-restore-owner-route.test.ts tests/unit/multitable-recovery-archive-async-restore.test.ts tests/unit/multitable-recovery-archive-sync-restore.test.ts tests/unit/multitable-recovery-archive-sync-execute.test.ts tests/unit/multitable-exact-anchor-route-authority.guard.test.ts tests/unit/multitable-field-schema-fence-recheck.guard.test.ts
node --test scripts/ops/multitable-d2-archive-ci-wiring.test.mjs scripts/ops/multitable-d2-archive-fail-not-skip.test.mjs
node plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs
pnpm validate:all
```

Late actual-scope native race, whole-pool RR worker pause, all attachment preparation side effects,
full restore/runtime composer and new-source APFS remain unqualified. Same-host historical APFS,
retained LC1..6 and local NON-KMS keys do not establish independent provider durability or KMS readiness.

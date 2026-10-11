# Time Machine G3 tombstone retention admission verification

Status: bounded local retention admission PASS. Ordinary exact-source CI, complete Time Machine
and owner stages remain OPEN. The frozen slice lock preceded implementation on
`24b3b880798247cb5787b45a3e9cb68d3b668ba2`. Final parent is
`73a5b86b50e865a383ead8bc5eea2f0ad5941b71`: the disjoint #6232 test-transport correction was
integrated by exact owned fast-forward; all ten frozen G3 inputs stayed byte-identical.
Authoritative slice: `multitable-timemachine-retention-admission-design-lock-20261007.md`.
Frozen lock SHA256: `1e22cb0e21deeb7182bf8ce29dc8c1c7ea13ec88b474ae2084e329c46e1ef63f`.

## Result

The existing periodic field/link tombstone sweeps could delete untagged archive source after a
committed archiving claim and before owned capture. The existing dual literal-`true` archive
protection selector now routes those two sweeps through a short owned transaction per sheet.
It establishes and verifies READ COMMITTED before snapshot-bearing probes, proves an actual
transaction, acquires the canonical sheet fence and reads fresh durable state. Only an existing
sheet row with NULL state admits deletion. Recognized blocks, including expired archiving,
preserve the source; missing authority, unknown states and invalid transaction/isolation close.

Outer discovery supplies bounded routing hints. Fresh deletion proves the original candidate
anchor/id, untagged status, age and sheet; grouped eligibility sees every member and refuses
cross-sheet groups. Link eligibility also respects the live-trash floor. Each category keeps
one sweep-level budget across sheets, while an eligible anchor deletes its whole group. Initial
link discovery applies the floor before LIMIT so a protected first group cannot starve later work.
The optional floor statement uses SAVEPOINT and ROLLBACK TO for a real 42703 fallback; missing
tombstone tables or operation_id retain zero deletion without weakening tagged-history guards.

The scheduler supplies the existing database transaction adapter. A selected injected query
without an owned runner refuses before business SQL. The unselected SQL, ordering, error/fallback
behavior, exact retention-'1' enable semantics, days floor and cadence stay unchanged. The new
holder is registered as metadata-only and its guard rejects a post-fence meta_records.data write.
No flag, migration, provider/key operation, restore-holder exception or archive composer is added.

| Frozen input | SHA256 |
| --- | --- |
| meta-tombstone-retention-admission.ts | 36b5259b688a0efd0b03ccde38d53972913c2bdac32c7d66ed1843a59dccb6f2 |
| meta-revision-retention.ts | bdc073500ffbb876f610241588c27f849115d5449e6d2cbe5d43e549d5c85b0f |
| new focused unit spec | 766ba6949b081797fca31c66cfb5aa08250dc18f8b39e0d85805bdc00e888670 |
| preserved field-holder guard plus G3 negative | 7ae0b252b5a31a39b29799e6a1af0ac85107ff27c80a33582899b318310a7177 |
| amended whole native spec | 7e5a206212baa459cf87d10601e7614a35f8f66b20a6298a55a1a70d91f37e9a |
| new native fixture | 33c613dc432361ca5aa0a239355ee632354e7f60c28f440e8a062bd590a28eb8 |

## Executed evidence and limits

- Six whole focused files pass 167/167, zero skip: admission33, existing retention18,
  field-holder51, adjacent G2 admission52, writer-block10 and the unchanged app-mode tripwire3.
- The amended whole native spec passes 45/45, zero skip: sentinel1 and native44. Original
  normal43 evidence remains retained. The amendment adds two legal new eligible-anchor controls
  after discovery and three resolves matchers for unchanged expected values. It retains all
  original43 cases. Normal full fixtures execute 54 real existing migration ups with nine enabled
  authority triggers; deployment-stage fixtures separately execute actual production ups.
- Both field/link grouped and loose rows prune. Mixed/tagged/fresh groups and the link floor
  survive. Genuine committed and expired owned claims preserve the complete fourteen-table
  snapshot and bounded captured tombstones. Actual advisory waits prove claim-first and
  retention-first ordering; genuinely inherited RR is set before BEGIN and normalizes to fresh
  RC. A later genuine owned capture observes the committed retention result.
- Legal new tagged/fresh/cross-sheet members, a new trash floor and loose identity/sheet/anchor/
  age/tag drift after discovery refuse stale deletion. Newly eligible independent anchors do
  not widen the originally discovered candidate set. Two-sheet controls exercise separate global
  group and loose budgets; large eligible groups still delete whole.
- Actual missing floor-column SAVEPOINT rollback permits the floorless fallback and COMMIT.
  Real deployment prefixes preserve zero deletion for missing operation_id or tombstone tables;
  missing writer-state schema, orphan sheet, autocommit runner and actual SHOW interference close.
  Four actual unselected flag spellings preserve the legacy pruning behavior. Unknown-state
  evidence is focused unit coverage because the native state constraint disallows forging it.
- Twenty native mutations each run the whole45 spec, one unknown-state mutation runs the whole33
  unit spec, and one metadata-census mutation runs the whole51 guard. All22 have actual exit1,
  exact named raw AssertionErrors and zero skips. Each ten-input snapshot changes only its
  predeclared input. Native spec/fixture bytes stay unchanged; the metadata-census mutation alone
  edits its designated guard-test ledger. Exact restoration is followed by another whole45
  PASS. The valid ANY-binding mutation consumes its third parameter and proves over-deletion;
  the canonical-fence mutation tests the wait protocol. Tagged-loose and SAVEPOINT mutations
  establish admission/availability sensitivity, not a trigger-free unsafe-write result.
- The initial mutation controller rejected a consecutive shared FAIL-header group despite a
  real failed45 run. The additive reader correction re-reads the same saved raw error group;
  it does not rerun or rewrite that test. Original raw/process/inputs and the controller failure
  are retained. Independent final audit checks all22 input/log/process/report/census bindings
  and exact restoration; it does not claim to have executed tests or accessed the database.
- Static wiring18 and the behavioral harness1 pass, zero skip. The harness actually executes
  all20 armed real-DB children, each failing its missing-DATABASE_URL sentinel. The whole new
  spec is in the Node20 realDB union and excluded from no-DB collection. Only the workflow
  provenance leaf changes to `4e282ac693a5a5d68c02ff27332fb31858c08d79c801fdcc134b04f5933891e7`;
  the official computed pin set and existing standalone provenance test match.
- Focused unit/production and amended native TypeScript checks exit0. `pnpm validate:all` and
  `git diff --check` exit0. All final frozen source inputs remain unchanged during the checks.
- The exclusive native PG15 has zero scratch/non-system databases and other client connections
  before official fast stop, actual exit0. Root independently reads the stopped PID/listener/
  postmaster.pid, refused TCP and retained initialized data. The private profile is gone; all
  native failures, migration/input snapshots and essential raw evidence are retained.

Evidence directory: `artifacts/tm-retention-admission-20261007/` (ignored, retained locally).
Original native normal manifest SHA256: `8e0ebb1dc045dcaa8816b10784ab5d2ff35e2963109419b23eff5bf2f907f5f0`.
Root final mutation receipt SHA256: `f9ad2e3c1b4a9ed581645857b7ffddc2c6676d2f8a7ba304e7a5f10fb649c053`.
Independent final mutation audit SHA256: `908cc1746dd2fdb1ca86d8514c79891e9b5146cb0a06b89948bb8e04ba22a63e`.
Root final local-check receipt SHA256: `cba1a9ced9f6d896a3b6e000d20d3d294fa50e6bba287f78611b0db26c24c31c`.
Native cleanup manifest SHA256: `e8fb3c83f3d11681518629521968795778d7990cc889c9f577064c83a902168c`.
Root live cleanup readback SHA256: `96f03a2586dd0b71455bef83982f41251e775402c1a3eb5348a9cdecf056e239`.
Earlier implementation, fixture prerequisite and controller qualification failures are retained.

## Gates and reproduction

| Lock gate | State | Evidence boundary |
| --- | --- | --- |
| Positive / existing semantics | Local PASS | Native grouped/loose rows, whole anchors, global budgets and floor starvation control |
| Genuine archive block | Local PASS | Committed/expired claims preserve full snapshot and captured source |
| Ordering / freshness | Local PASS | Actual waits, inherited RR, fresh eligibility and original candidate binding |
| Closed trust / deployment fallback / OFF | Local PASS | Actual prefixes/autocommit/SHOW/OFF plus focused unknown-state matrix |
| Refutation / local CI contract | Local PASS | Twenty native and two focused REDs, exact restored45, whole-file wiring and armed sentinel |
| Source review / configured checks | Local PASS | Independent bounded source/evidence review, focused neighbors, TypeScript and configured checks |
| Ordinary exact-source CI execution | OPEN | Requires published head and terminal raw qualification |
| Full writer closure / D-H2 / D-L / D7 | OPEN | Remaining census, complete owned bytes/crypto/finalize/abandonment/lifecycle and integrated fixed-source APFS |
| Owner stages | OPEN | Exact-SHA ratification, merge, flags, deployment and staging inputs |

Supply DATABASE_URL privately for an owned disposable PG; fixtures create/drop namespaced databases.

```sh
METASHEET_REAL_DB_TEST_STEP=1 pnpm --filter @metasheet/core-backend exec vitest run --config vitest.integration.config.ts tests/integration/multitable-recovery-archive-retention-admission-realdb.test.ts
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/multitable-recovery-archive-retention-admission.test.ts tests/unit/meta-revision-retention.test.ts tests/unit/multitable-field-schema-fence-recheck.guard.test.ts tests/unit/multitable-recovery-foreign-admission.test.ts tests/unit/multitable-recovery-archive-writer-block.test.ts tests/unit/supertest-app-mode-tripwire.test.ts
node --test scripts/ops/multitable-d2-archive-ci-wiring.test.mjs scripts/ops/multitable-d2-archive-fail-not-skip.test.mjs
node plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs
pnpm validate:all
```

Admission is atomic per sheet, not across all sheets in a sweep. Record/config revision pruning is
outside the bounded source projection. The original armed no-DB native run actually failed its
sentinel and its other42 assertionResults were intentionally skipped; its misleading top-level
Vitest counters are not a native PASS. Full runtime composer/restore and new-source APFS remain
unqualified. Historical same-host APFS and retained LC1..6 local NON-KMS keys do not establish
independent provider durability or KMS readiness. No Ready, merge, enablement, deployment or staging
acceptance is claimed.

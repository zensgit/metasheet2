'use strict'

// B1b capability spike — checks that the evidence slice does not rely on an implicit
// MySQL/SQL Server strategy or a widened certification vocabulary (definition-of-done
// item 4, docs/development/database-system-integration-line-design-and-verification-
// 20260724.md §4 step 2 / §7.2 "mints no certification and registers no strategy").
//
// TWO RUNTIME CONTRACT CHECKS, deliberately not overstated as a repository-wide
// registration proof:
//
//   1. Construct a probe-strategy registry the SAME WAY
//      the existing spike test does (fixture PostgreSQL-only entry), then resolve a set of
//      actionProfileVersion ids SHAPED like what a MySQL/SQL Server B1b strategy would use —
//      every one of them must resolve to null. This proves the registry has no implicit
//      MySQL/SQL Server defaults; it does not claim that no future runtime consumer can
//      explicitly construct and hold a different registry. B1a-3 deliberately removed the
//      old SQL probe entry point, so this test must not recreate it merely to observe an
//      obsolete PROBE_STRATEGY_UNBOUND call path.
//
//   2. Pin the existing certification vocabulary. The evidence-only spike may observe
//      engine capabilities, but it may not add a certificate mode or proof token.
//
// Whether THIS PR changed a production registry is a one-time diff property checked during
// review. A historical blob SHA is not a durable runtime contract: legitimate, separately
// reviewed main-line changes must not make this test fail forever.

const assert = require('node:assert/strict')
const path = require('node:path')

const SPIKE_LIB = path.join(__dirname, '..', 'lib', 'gip-binding-qualification-spike.cjs')
const CONTRACTS_LIB = path.join(__dirname, '..', 'lib', 'gip-profile-certification-contracts.cjs')

function behaviouralProof_registryResolvesNothingNew() {
  const {
    postgresTotalOrderProbeStrategy,
    createProbeStrategyRegistry,
  } = require(SPIKE_LIB)

  // Built EXACTLY the way __tests__/gip-binding-qualification-spike.test.cjs builds it — one
  // fixture PostgreSQL entry, nothing else. If a future change on this branch added a mysql/
  // sqlserver entry here, this constant would grow and the counts below would change.
  const FIXTURE_ACTION_PROFILE_VERSION = 'fixture.paged_read.v1'
  const registry = createProbeStrategyRegistry([
    { actionProfileVersion: FIXTURE_ACTION_PROFILE_VERSION, ...postgresTotalOrderProbeStrategy },
  ])

  // Shaped like what a real B1b MySQL/SQL Server strategy registration WOULD use — chosen to
  // look exactly like what an implementer under schedule pressure might be tempted to wire in
  // "just to get the spike passing". None of these may resolve today.
  const shouldStillBeUnbound = [
    'mysql.total_order_probe.v1',
    'sqlserver.total_order_probe.v1',
    'mysql.b1b_capability_spike.v1',
    'sqlserver.b1b_capability_spike.v1',
    'sqlserver.total_order_probe.rcsi.v1',
    FIXTURE_ACTION_PROFILE_VERSION.toUpperCase(), // resolve() must not case-fold either
  ]

  for (const actionProfileVersion of shouldStillBeUnbound) {
    assert.equal(
      registry.resolve(actionProfileVersion),
      null,
      `resolve("${actionProfileVersion}") must stay unbound — the B1b spike registers nothing`
    )
  }

  // The fixture id itself MUST still resolve (positive control — without this, the negative
  // results above could also be produced by a registry that resolves nothing at all).
  assert.notEqual(registry.resolve(FIXTURE_ACTION_PROFILE_VERSION), null)
  assert.equal(registry.resolve(FIXTURE_ACTION_PROFILE_VERSION).strategyId, postgresTotalOrderProbeStrategy.strategyId)
}

function behaviouralProof_frozenVocabulariesUnchanged() {
  const { GIP_PROFILE_ERROR_REASONS, GIP_ACQUISITION_MODES, GIP_CONSISTENCY_PROOFS } = require(CONTRACTS_LIB)
  // Exact set equality (never includes/count) — pinned counts as of the battery's §0 basis.
  // A silently-added mysql/sqlserver-flavoured error reason or acquisition mode would change
  // these counts even if it never appeared in a token string this test greps for.
  assert.equal(GIP_PROFILE_ERROR_REASONS.length, 24)
  assert.equal(GIP_ACQUISITION_MODES.length, 4)
  assert.equal(GIP_CONSISTENCY_PROOFS.length, 3)
  assert.deepEqual([...GIP_CONSISTENCY_PROOFS], ['SOURCE_SNAPSHOT_TXN', 'IMMUTABLE_SNAPSHOT_TOKEN', 'MONOTONIC_VERSION_PIN'])
}

async function main() {
  behaviouralProof_registryResolvesNothingNew()
  behaviouralProof_frozenVocabulariesUnchanged()
  console.log('gip-b1b-registry-unchanged.test.cjs OK')
}

main().catch(error => {
  console.error('gip-b1b-registry-unchanged.test.cjs FAILED')
  console.error(error)
  process.exit(1)
})

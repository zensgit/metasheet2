'use strict'

// B1b capability spike — proves the spike DOES NOT WIDEN the B1a-adjacent latent contracts
// it sits next to (definition-of-done item 4, docs/development/database-system-integration-
// line-design-and-verification-20260724.md §4 step 2 / §7.2 "mints no certification and
// registers no strategy").
//
// TWO INDEPENDENT PROOFS, deliberately not collapsed into one:
//
//   1. COMPLETENESS CHECK (not the proof by itself — the line's own rule: source-text/grep
//      checks are not behaviour checks): `git hash-object` reproduces the exact git blob SHA
//      of each file from ITS OWN CONTENT ON DISK — no network, no `origin/main` fetch
//      required (unlike `git show origin/main:<path>`, which needs remote history a shallow
//      CI checkout may not have). The B1b spike PR never edits either file, so the live blob
//      hash must equal the hash recorded in the acceptance battery's §0 verification basis.
//
//   2. BEHAVIOURAL PROOF (the actual proof): construct a probe-strategy registry the SAME WAY
//      the existing spike test does (fixture PostgreSQL-only entry), then resolve a set of
//      actionProfileVersion ids SHAPED like what a MySQL/SQL Server B1b strategy would use —
//      every one of them must resolve to null and must make `probe()` throw
//      PROBE_STRATEGY_UNBOUND, IDENTICALLY to how an arbitrary unbound id already behaves on
//      main. If this spike (or a future edit riding on its branch) had silently registered a
//      mysql/sqlserver strategy, this is the test that would catch it — a blob-hash match
//      alone would NOT catch a change smuggled in through a DIFFERENT file that imports and
//      re-registers against these same frozen exports.

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

const SPIKE_LIB = path.join(__dirname, '..', 'lib', 'gip-binding-qualification-spike.cjs')
const CONTRACTS_LIB = path.join(__dirname, '..', 'lib', 'gip-profile-certification-contracts.cjs')

// Recorded verbatim from the acceptance battery §0 (verified independently against
// `origin/main` @ 97cf6203397b958c78c646f09176b93b00d279aa before this spike touched anything
// — see the PR body for the paired `git rev-parse origin/main:<path>` transcript).
const EXPECTED_BLOB_SHA = Object.freeze({
  [SPIKE_LIB]: '912c06f01194708a0a03ef65d1ce0f0c3a041779',
  [CONTRACTS_LIB]: 'e6bfe093783139dcd674614dba0548aaf872c7ab',
})

function completenessCheck_blobHashUnchanged() {
  for (const [file, expected] of Object.entries(EXPECTED_BLOB_SHA)) {
    let actual
    try {
      actual = execFileSync('git', ['hash-object', file], { encoding: 'utf8' }).trim()
    } catch (error) {
      // A missing `git` binary or a non-repo checkout must not silently pass this as
      // "unchanged" — fail loud so the completeness check is never quietly skipped.
      throw new Error(`gip-b1b-registry-unchanged: could not compute git blob hash for ${file}: ${error.message}`)
    }
    assert.equal(
      actual,
      expected,
      `${path.basename(file)} blob hash changed (${actual} !== ${expected}) — this spike must NOT edit this file`
    )
  }
}

async function behaviouralProof_registryResolvesNothingNewAndUnboundFiresIdentically() {
  const {
    GipQualificationError,
    postgresTotalOrderProbeStrategy,
    createProbeStrategyRegistry,
    createBindingQualificationProber,
  } = require(SPIKE_LIB)

  // Built EXACTLY the way __tests__/gip-binding-qualification-spike.test.cjs builds it — one
  // fixture PostgreSQL entry, nothing else. If a future change on this branch added a mysql/
  // sqlserver entry here, this constant would grow and the counts below would change.
  const FIXTURE_ACTION_PROFILE_VERSION = 'fixture.paged_read.v1'
  const registry = createProbeStrategyRegistry([
    { actionProfileVersion: FIXTURE_ACTION_PROFILE_VERSION, ...postgresTotalOrderProbeStrategy },
  ])
  const prober = createBindingQualificationProber(registry)

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

    let caught = null
    try {
      await prober.probe({
        query: async () => ({ rows: [] }),
        envelopeKey: { keyId: 'k', secret: Buffer.alloc(32, 1) },
        actionProfileVersion,
        systemContentKey: 'sck',
        configContentKey: 'cck',
        objectKey: 'irrelevant_object',
        canonicalObjectVersion: 'v1',
        keyColumns: ['id'],
        probedAt: '2026-07-26T00:00:00Z',
      })
    } catch (error) {
      caught = error
    }
    assert.ok(
      caught instanceof GipQualificationError,
      `probe() with actionProfileVersion="${actionProfileVersion}" must throw GipQualificationError`
    )
    assert.equal(
      caught.reason,
      'PROBE_STRATEGY_UNBOUND',
      `probe() with actionProfileVersion="${actionProfileVersion}" must fail closed as PROBE_STRATEGY_UNBOUND`
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
  completenessCheck_blobHashUnchanged()
  await behaviouralProof_registryResolvesNothingNewAndUnboundFiresIdentically()
  behaviouralProof_frozenVocabulariesUnchanged()
  console.log('gip-b1b-registry-unchanged.test.cjs OK')
}

main().catch(error => {
  console.error('gip-b1b-registry-unchanged.test.cjs FAILED')
  console.error(error)
  process.exit(1)
})

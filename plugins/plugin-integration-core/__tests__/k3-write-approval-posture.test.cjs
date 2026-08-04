'use strict'

// P3 posture pin: WHICH write paths carry the two-phase (dry-run -> token -> apply) approval
// binding, and which do not.
//
// Why this file exists. The delivery chain the owner named is
//   read -> clean -> dry-run -> HUMAN APPROVAL -> K3 Material Save-only (1-3 rows) -> read-back
// Reading the code shows the approval step is already implemented, and implemented WELL --
// external-write-dry-run.cjs issues a single-use, TTL'd token whose `revision` hash covers
// `rowFingerprints`, so applying a different row set than the human previewed is a 409, not a
// silent write. But that gate lives on the C6 path, and the C6 path does not accept a K3 target.
// external-write-dry-run.cjs:246 says so in its own words: "an opt-in target (S1b-2 multitable,
// S2 K3) supplies its own profile" -- K3's profile is future work, not present work.
//
// So this file does NOT claim a bug. It pins a FORWARD REQUIREMENT: the moment someone gives the
// K3 connector a C6 write profile, assertion (3) goes red and they must consciously decide what
// the approval story is, instead of inheriting silence. That is the same shape the owner already
// ratified elsewhere ("SQL builders stay unreachable") -- pin the posture, not a fix.
//
// Everything here is required, never text-parsed: a regex over source can be satisfied by a
// comment, and a posture assertion satisfied by a comment is worse than no assertion.

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  ExternalWriteDryRunError,
  __internals: { SQL_WRITE_GATED_PROFILE, normalizeTargetConfig },
} = require('../lib/external-write-dry-run.cjs')

const { MULTITABLE_WRITE_PROFILE } = require('../lib/adapters/metasheet-multitable-target-adapter.cjs')

const { K3_WISE_WEBAPI_ADAPTER_METADATA } = require('../lib/adapters/k3-wise-webapi-adapter.cjs')

const { K3_WISE_DOCUMENT_TEMPLATES } = require('../lib/adapters/k3-wise-document-templates.cjs')

const K3_CONNECTOR_KIND = 'erp:k3-wise-webapi'

// The two write profiles actually wired into the C6 planner today. SQL is the default
// (resolveTargetWriteProfile falls back to it); multitable is supplied by http-routes.
const WIRED_PROFILES = [SQL_WRITE_GATED_PROFILE, MULTITABLE_WRITE_PROFILE]

// A target system shaped well enough that normalizeTargetConfig would SUCCEED if the kind
// matched -- so a refusal below is attributable to the kind and nothing else.
function targetSystem(kind) {
  return {
    kind,
    config: {
      dataSourceId: 'ds-posture',
      object: 'material',
      keyFields: ['FNumber'],
      writableFields: ['FName'],
    },
  }
}

// ---------------------------------------------------------------------------
// (1) POSITIVE CONTROL -- the predicate discriminates.
//
// Without this, assertion (3) is a fail-closed assertion: "K3 is refused" would also be green
// if normalizeTargetConfig refused EVERYTHING, or if I had required the wrong object and every
// call threw for an unrelated reason. This proves the two wired profiles each ACCEPT their own
// kind, using the identical call shape assertion (3) uses.
// ---------------------------------------------------------------------------

test('positive control: each wired C6 profile ACCEPTS a target system of its own kind', () => {
  assert.equal(WIRED_PROFILES.length, 2, 'expected exactly the two profiles wired today')

  for (const profile of WIRED_PROFILES) {
    assert.equal(typeof profile.kind, 'string')
    assert.ok(profile.kind.length > 0, 'a profile must name the kind it covers')

    const normalized = normalizeTargetConfig(targetSystem(profile.kind), profile)
    assert.equal(normalized.kind, profile.kind)
    assert.deepEqual(normalized.keyFields, ['FNumber'])
    assert.deepEqual(normalized.writableFields, ['FName'])
  }
})

test('positive control: the two wired profiles cover DIFFERENT kinds (neither is a duplicate)', () => {
  const kinds = WIRED_PROFILES.map((p) => p.kind)
  assert.equal(new Set(kinds).size, kinds.length, 'wired profiles must not cover the same kind twice')
  assert.ok(kinds.includes('data-source:sql-write-gated'))
  assert.ok(kinds.includes('metasheet:multitable'))
})

// ---------------------------------------------------------------------------
// (2) K3 write is a REAL, DECLARED capability -- not theoretical.
//
// This is the half of the finding that makes (3) worth pinning. If K3 could not be a write
// target at all, (3) would be trivia. These assertions say: it can, and by default.
// ---------------------------------------------------------------------------

test('the K3 adapter declares itself a write TARGET, and material upsert is on by default', () => {
  assert.ok(
    Array.isArray(K3_WISE_WEBAPI_ADAPTER_METADATA.roles),
    'adapter metadata must declare its roles',
  )
  assert.ok(
    K3_WISE_WEBAPI_ADAPTER_METADATA.roles.includes('target'),
    'K3 is declared a write target -- this is what makes the posture below load-bearing',
  )

  const material = K3_WISE_DOCUMENT_TEMPLATES.material
  assert.ok(material, 'the material document template must exist')
  assert.ok(
    Array.isArray(material.operations) && material.operations.includes('upsert'),
    'material upsert is the DEFAULT operation set, not an opt-in',
  )
})

// ---------------------------------------------------------------------------
// (3) THE POSTURE -- no wired C6 profile covers the K3 connector kind.
//
// Consequence: a K3 target cannot reach the C6 dry-run token gate at all. Not "the gate is
// weak for K3" -- the gate is not on that path. When S2 gives K3 a profile, this goes red.
// ---------------------------------------------------------------------------

test('POSTURE: no wired C6 write profile accepts the K3 connector kind', () => {
  for (const profile of WIRED_PROFILES) {
    assert.throws(
      () => normalizeTargetConfig(targetSystem(K3_CONNECTOR_KIND), profile),
      (error) => {
        assert.ok(
          error instanceof ExternalWriteDryRunError,
          'refusal must be the module\'s own error type, not an incidental TypeError',
        )
        assert.equal(error.status, 422)
        assert.equal(error.code, 'C6_WRITE_TARGET_REQUIRED')
        // The refusal must name the kind mismatch -- proving it refused for THIS reason and not
        // because the system shape was malformed (the positive control uses the same shape).
        assert.equal(error.details.actualKind, K3_CONNECTOR_KIND)
        assert.equal(error.details.expectedKind, profile.kind)
        return true
      },
      `profile ${profile.kind} must refuse a K3 target`,
    )
  }
})

test('POSTURE: the K3 connector kind is not among the kinds any wired profile covers', () => {
  const coveredKinds = WIRED_PROFILES.map((p) => p.kind)
  assert.ok(
    !coveredKinds.includes(K3_CONNECTOR_KIND),
    'if this fails, K3 gained a C6 write profile -- decide and document its approval story, ' +
      'then update this file deliberately rather than deleting it',
  )
})

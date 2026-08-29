'use strict'

// DELIBERATE FLIP (K3WriteDecision, owner 20260805). The previous version of this file pinned
// "no wired C6 write profile accepts the K3 connector kind" as a FORWARD REQUIREMENT: the
// moment K3 gained a profile, the pin was to go red and force a conscious decision. That is
// exactly what happened — the owner ruled REQUIRE_NAMED_PROFILE_MAX3_AND_CONTENT_BOUND_APPROVAL,
// the K3 C6 write profile now exists (k3-wise-c6-write-profile.cjs), and this file is updated
// deliberately rather than deleted, per its own instruction.
//
// What it pins NOW:
//   * exactly THREE wired profiles, each accepting its own kind and no other's
//   * the K3 profile's safety gate is REAL: any of its three capability booleans false -> refuse
//   * the K3 profile's plan-level row bound is the customer profile literal's frozen cap
//
// Everything by require, never text-parsed — a regex over source can be satisfied by a comment.

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  ExternalWriteDryRunError,
  __internals: { SQL_WRITE_GATED_PROFILE, normalizeTargetConfig },
} = require('../lib/external-write-dry-run.cjs')

const { MULTITABLE_WRITE_PROFILE } = require('../lib/adapters/metasheet-multitable-target-adapter.cjs')

const {
  K3_WISE_C6_MAX_APPLY_ROWS,
  K3_WISE_C6_WRITE_PROFILE,
} = require('../lib/adapters/k3-wise-c6-write-profile.cjs')

const { K3_WISE_WEBAPI_ADAPTER_METADATA } = require('../lib/adapters/k3-wise-webapi-adapter.cjs')
const { K3_WISE_MATERIAL_PROFILES } = require('../lib/adapters/k3-wise-document-templates.cjs')

const K3_CONNECTOR_KIND = 'erp:k3-wise-webapi'
const CUSTOMER_PROFILE_ID = 'material-k3wise-customer-profile-v1'

// The three write profiles wired into the C6 planner after the ruling landed.
const WIRED_PROFILES = [SQL_WRITE_GATED_PROFILE, MULTITABLE_WRITE_PROFILE, K3_WISE_C6_WRITE_PROFILE]

// A target system shaped well enough that normalizeTargetConfig would SUCCEED if the kind
// matched — so a refusal below is attributable to the kind and nothing else.
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
// (1) POSITIVE CONTROL — the predicate discriminates: every wired profile accepts its own kind
// via the identical call shape the refusal assertions use.
// ---------------------------------------------------------------------------

test('positive control: each wired C6 profile ACCEPTS a target system of its own kind', () => {
  assert.equal(WIRED_PROFILES.length, 3, 'expected exactly the three profiles wired after K3WriteDecision')

  for (const profile of WIRED_PROFILES) {
    assert.equal(typeof profile.kind, 'string')
    assert.ok(profile.kind.length > 0, 'a profile must name the kind it covers')

    const normalized = normalizeTargetConfig(targetSystem(profile.kind), profile)
    assert.equal(normalized.kind, profile.kind)
    assert.deepEqual(normalized.keyFields, ['FNumber'])
    assert.deepEqual(normalized.writableFields, ['FName'])
  }
})

test('the three wired profiles cover THREE DISTINCT kinds — K3 among them, by the ruling', () => {
  const kinds = WIRED_PROFILES.map((p) => p.kind)
  assert.equal(new Set(kinds).size, kinds.length, 'wired profiles must not cover the same kind twice')
  assert.ok(kinds.includes('data-source:sql-write-gated'))
  assert.ok(kinds.includes('metasheet:multitable'))
  assert.ok(kinds.includes(K3_CONNECTOR_KIND), 'K3WriteDecision wired the K3 profile — its absence is a regression now')
})

// ---------------------------------------------------------------------------
// (2) Kind exclusivity both ways — no profile silently covers another's kind.
// ---------------------------------------------------------------------------

test('POSTURE: every wired profile REFUSES every other profile\'s kind, attributably', () => {
  for (const profile of WIRED_PROFILES) {
    for (const other of WIRED_PROFILES) {
      if (other === profile) continue
      assert.throws(
        () => normalizeTargetConfig(targetSystem(other.kind), profile),
        (error) => {
          assert.ok(
            error instanceof ExternalWriteDryRunError,
            'refusal must be the module\'s own error type, not an incidental TypeError',
          )
          assert.equal(error.status, 422)
          assert.equal(error.code, 'C6_WRITE_TARGET_REQUIRED')
          assert.equal(error.details.actualKind, other.kind)
          assert.equal(error.details.expectedKind, profile.kind)
          return true
        },
        `profile ${profile.kind} must refuse a ${other.kind} target`,
      )
    }
  }
})

// ---------------------------------------------------------------------------
// (3) The K3 profile's safety gate is load-bearing, not a rubber stamp.
// ---------------------------------------------------------------------------

test('K3 capability gate: all guards true -> pass; each one false -> refuse', () => {
  // Capability shape extended DELIBERATELY (owner review 20260805): the approved B4 binding
  // is consumed through the capability state, whose fields buildRevision hashes — the gate
  // and the content-binding are the same surface.
  const good = {
    success: true,
    capabilityState: {
      customerProfileSelected: true, saveOnlyLocked: true, applyRowCapped: true,
      b4BindingApproved: true, b4BindingCount: 1,
      b4ActionProfileVersion: 'k3wise.material_list.v1',
      b4ApprovedConfigVersion: '3',
      b4ConfigContentKey: 'b4-content-key-x',
    },
  }
  const state = K3_WISE_C6_WRITE_PROFILE.normalizeCapabilityState(good)
  assert.doesNotThrow(() => K3_WISE_C6_WRITE_PROFILE.assertSafeCapabilityState(state))

  for (const key of ['customerProfileSelected', 'saveOnlyLocked', 'applyRowCapped']) {
    const bad = K3_WISE_C6_WRITE_PROFILE.normalizeCapabilityState({
      success: true,
      capabilityState: { ...good.capabilityState, [key]: false },
    })
    assert.throws(
      () => K3_WISE_C6_WRITE_PROFILE.assertSafeCapabilityState(bad),
      /customer-profile locked/,
      `${key}=false must refuse — each boolean is individually load-bearing`,
    )
  }
  const noB4 = K3_WISE_C6_WRITE_PROFILE.normalizeCapabilityState({
    success: true,
    capabilityState: { ...good.capabilityState, b4BindingApproved: false, b4BindingCount: 0 },
  })
  assert.throws(
    () => K3_WISE_C6_WRITE_PROFILE.assertSafeCapabilityState(noB4),
    /approved B4 read binding/,
    'the write lifecycle must not run without its ratified read contract',
  )
})

test('K3 capability gate: malformed state is refused, never coerced', () => {
  // REVIEW P2-C2: I had downgraded the type-confusion probe ('yes' -> true) while the ledger
  // claimed "zero downgraded". A three-way control proved the loss: with the probe restored, a
  // type-check -> presence-check mutation is RED; without it, green. Restored, and extended to
  // the members the first version left unwitnessed.
  const goodState = {
    customerProfileSelected: true, saveOnlyLocked: true, applyRowCapped: true,
    b4BindingApproved: true, b4BindingCount: 1,
    b4ActionProfileVersion: 'k3wise.material_list.v1', b4ApprovedConfigVersion: '3',
    b4ConfigContentKey: 'b4-content-key-x',
  }
  const typeConfusions = [
    { customerProfileSelected: 'yes' }, { saveOnlyLocked: 'true' }, { applyRowCapped: 1 },
    { b4BindingApproved: 'yes' }, { b4BindingCount: '1' },
    { b4ActionProfileVersion: null }, { b4ApprovedConfigVersion: 3 }, { b4ConfigContentKey: 0 },
  ].map((patch) => ({ capabilityState: { ...goodState, ...patch } }))
  for (const malformed of [undefined, null, {}, { capabilityState: {} }, ...typeConfusions]) {
    assert.throws(
      () => K3_WISE_C6_WRITE_PROFILE.normalizeCapabilityState(malformed),
      /capability state is unavailable/,
    )
  }
})

// ---------------------------------------------------------------------------
// (4) The plan-level bound and the adapter's frozen cap are ONE number, sourced
// from the profile literal — two record points would drift.
// ---------------------------------------------------------------------------

test('the C6 plan bound IS the customer profile literal\'s frozen maxApplyRows', () => {
  const profile = K3_WISE_MATERIAL_PROFILES[CUSTOMER_PROFILE_ID]
  assert.ok(profile, 'the named customer profile must exist')
  assert.equal(K3_WISE_C6_MAX_APPLY_ROWS, profile.maxApplyRows, 'single source: the profile literal')
  assert.equal(K3_WISE_C6_MAX_APPLY_ROWS, 3, 'K3WriteDecision fixes the first-version cap at 3')
})

test('reachability context: the K3 adapter still declares itself a write TARGET', () => {
  assert.ok(K3_WISE_WEBAPI_ADAPTER_METADATA.roles.includes('target'))
})

// ---------------------------------------------------------------------------
// (5) E4 (HG v1.2 §10) — the POSTURE flip this file exists to record.
//
// This file's own history is the argument for putting it here. It was written to pin "no wired
// C6 write profile accepts the K3 connector kind" as a FORWARD REQUIREMENT, then deliberately
// flipped when K3WriteDecision wired the profile. E4 flips the posture again, in the opposite
// direction and permanently: the profile stays wired — it is what makes the K3 dry-run PLANNABLE,
// which §15.2 E4-05 requires — but no apply follows from it at any of four layers.
//
// Kept SCOPED: this pins the CONTRACT (the frozen code, and that the K3 kind is still the profile
// the planner resolves). The four layers' zero-login/zero-save behaviour is witnessed per layer in
// k3-external-write-permanent-fence.test.cjs (E4-01..E4-04); duplicating it here would be a
// second, drifting record of the same fact.
// ---------------------------------------------------------------------------

test('E4: the K3 write profile stays wired for PLANNING, and the refusal code is the frozen one', () => {
  const fence = require('../lib/k3-external-write-permanent-fence.cjs')
  // The literal is spelled out rather than compared to itself through the import — a rename in
  // production must be a visible, reviewable edit here, not a silently re-pointed expectation.
  assert.equal(fence.K3_WISE_EXTERNAL_WRITE_DISABLED, 'K3_WISE_EXTERNAL_WRITE_DISABLED')
  assert.equal(fence.K3_EXTERNAL_WRITE_REFUSAL_STATUS, 403)
  assert.equal(fence.K3_EXTERNAL_WRITE_TARGET_KIND, K3_CONNECTOR_KIND)
  // The fence's subject is the SAME kind the C6 profile covers — if those two ever diverged, the
  // profile would keep planning a target the fence no longer recognised.
  assert.equal(fence.isK3ExternalWriteTargetKind(K3_WISE_C6_WRITE_PROFILE.kind), true)
  // Discrimination: the fence must not swallow the other two wired kinds.
  assert.equal(fence.isK3ExternalWriteTargetKind(SQL_WRITE_GATED_PROFILE.kind), false)
  assert.equal(fence.isK3ExternalWriteTargetKind(MULTITABLE_WRITE_PROFILE.kind), false)
})

test('E4 §10.1: the fence module reserves NO runtime switch — it takes no config of any kind', () => {
  // "不得预留运行时开关" is a property of the SOURCE, not of a call. Assert it structurally: the
  // module reads no environment variable and consults no options object. A future edit that adds
  // an unlock knob has to delete this test to land, which is exactly the reviewable act §10.1
  // demands.
  const fs = require('node:fs')
  const path = require('node:path')
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'k3-external-write-permanent-fence.cjs'), 'utf8')
  const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
  assert.equal(/process\.env/.test(code), false, 'the fence must never read an environment variable')
  assert.equal(/require\(/.test(code), false, 'the fence must stay a leaf — no module it depends on can weaken it')

  // And nothing it exports can be mutated into an unlock at runtime.
  const fence = require('../lib/k3-external-write-permanent-fence.cjs')
  assert.ok(Object.isFrozen(fence.K3_EXTERNAL_WRITE_APPLY_MARKER), 'the plan marker is frozen')
  const mutators = Object.entries(fence).filter(([name, value]) => typeof value === 'function' && /^set|^enable|^configure/i.test(name))
  assert.deepEqual(mutators.map(([name]) => name), [], 'the fence exports no setter, enabler or configurator')

  // The unconditional refusal really is unconditional: it throws for every caller, with no
  // argument that could make it return instead.
  for (const build of [
    (status, code2, message, details) => Object.assign(new Error(message), { status, code: code2, details }),
  ]) {
    assert.throws(() => fence.refuseK3ExternalWritePermanently(build), /permanently disabled/)
  }
})

test('reachability context: material upsert stays the DEFAULT template operation (guard restored per review)', () => {
  // Review #4761 P3: the pre-flip file asserted this and the flip dropped it with no
  // successor. It is what makes the whole posture load-bearing — if upsert stopped being the
  // default, the write reachability the profiles gate would be theoretical again.
  const { K3_WISE_DOCUMENT_TEMPLATES } = require('../lib/adapters/k3-wise-document-templates.cjs')
  const material = K3_WISE_DOCUMENT_TEMPLATES.material
  assert.ok(material, 'the material document template must exist')
  assert.ok(
    Array.isArray(material.operations) && material.operations.includes('upsert'),
    'material upsert is the DEFAULT operation set, not an opt-in',
  )
})

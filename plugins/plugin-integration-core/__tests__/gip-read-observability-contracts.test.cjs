'use strict'

// GIP B1a §4 step 1.6 — counter + handshake CONTRACT SHAPES. Hermetic, no wiring.
// Plain node test.

const assert = require('node:assert/strict')
const path = require('node:path')

const MODULE_PATH = path.join(__dirname, '..', 'lib', 'gip-read-observability-contracts.cjs')
const moduleExports = require(MODULE_PATH)

const {
  OBSERVABILITY_CONTRACT_ERROR_REASONS,
  GipReadObservabilityContractError,
  UNORDERED_OFFSET_ATTEMPT_COUNTER,
  assertValuesFreeCounterSample,
  CAPABILITY_HANDSHAKE_REQUEST_KEYS,
  CAPABILITY_HANDSHAKE_EXPECTATION_KEYS,
  CAPABILITY_HANDSHAKE_OUTCOMES,
  evaluateCapabilityHandshake,
} = moduleExports

const ATTACKER_TEXT = 'ATTACKER-CANARY-6f23e39f'

// Token EQUALITY, never `includes` — two reasons minted at the same call site can
// otherwise cover for each other.
function refusesWith(fn, expectedReason) {
  let caught = null
  try { fn() } catch (error) { caught = error }
  assert.ok(caught instanceof GipReadObservabilityContractError,
    `expected GipReadObservabilityContractError, got ${caught && caught.name}`)
  assert.equal(caught.reason, expectedReason)
  return caught
}

function keySet(object) {
  return Object.keys(object).sort()
}

// ---------------------------------------------------------------------------
// 1.6-A · The frozen counter shape, and values-free by CLOSED KEY SET
// ---------------------------------------------------------------------------
function counterContract() {
  assert.deepEqual(keySet(UNORDERED_OFFSET_ATTEMPT_COUNTER),
    ['kind', 'labelKeys', 'monotonic', 'name', 'sampleKeys'])
  assert.equal(UNORDERED_OFFSET_ATTEMPT_COUNTER.name, 'gip.read.unordered_offset_attempt_count')
  assert.equal(UNORDERED_OFFSET_ATTEMPT_COUNTER.kind, 'counter')
  assert.equal(UNORDERED_OFFSET_ATTEMPT_COUNTER.monotonic, true)
  // The label set is EMPTY and frozen: a label is how an identifier gets into a
  // counter. Deep-frozen, not merely a frozen root.
  assert.deepEqual([...UNORDERED_OFFSET_ATTEMPT_COUNTER.labelKeys], [])
  assert.ok(Object.isFrozen(UNORDERED_OFFSET_ATTEMPT_COUNTER))
  assert.ok(Object.isFrozen(UNORDERED_OFFSET_ATTEMPT_COUNTER.labelKeys))
  assert.ok(Object.isFrozen(UNORDERED_OFFSET_ATTEMPT_COUNTER.sampleKeys))

  // POSITIVE CONTROL — an all-refusing stub must not pass this file.
  const sample = assertValuesFreeCounterSample({ value: 0 })
  assert.deepEqual(keySet(sample), ['value'])
  assert.equal(sample.value, 0)
  assert.equal(assertValuesFreeCounterSample({ value: 9007199254740991 }).value, 9007199254740991)

  // Any identifier is REFUSED, not dropped.
  for (const identifier of ['tenantId', 'workspaceId', 'configId', 'objectKey', 'fieldId', 'systemId']) {
    refusesWith(() => assertValuesFreeCounterSample({ value: 1, [identifier]: 'x' }),
      'COUNTER_SAMPLE_NOT_VALUES_FREE')
  }
  // Shape hygiene on the one legal member.
  refusesWith(() => assertValuesFreeCounterSample({ value: -1 }), 'COUNTER_SAMPLE_INVALID')
  refusesWith(() => assertValuesFreeCounterSample({ value: 1.5 }), 'COUNTER_SAMPLE_INVALID')
  refusesWith(() => assertValuesFreeCounterSample({ value: '1' }), 'COUNTER_SAMPLE_INVALID')
  refusesWith(() => assertValuesFreeCounterSample({}), 'COUNTER_SAMPLE_INVALID')
  refusesWith(() => assertValuesFreeCounterSample(null), 'COUNTER_SAMPLE_INVALID')
  refusesWith(() => assertValuesFreeCounterSample([1]), 'COUNTER_SAMPLE_INVALID')
  refusesWith(() => assertValuesFreeCounterSample('value'), 'COUNTER_SAMPLE_INVALID')
}

// ---------------------------------------------------------------------------
// 1.6-B · The handshake shape — version-incompatible REFUSES TO RUN
// ---------------------------------------------------------------------------
function handshakeContract() {
  assert.deepEqual([...CAPABILITY_HANDSHAKE_REQUEST_KEYS],
    ['clientBuild', 'connectorProtocolVersion', 'profileId', 'configVersion'])
  assert.deepEqual([...CAPABILITY_HANDSHAKE_EXPECTATION_KEYS],
    ['minimumConnectorProtocolVersion', 'requiredConfigVersion'])
  assert.deepEqual([...CAPABILITY_HANDSHAKE_OUTCOMES],
    ['READY', 'UPGRADE_REQUIRED', 'CONFIG_MIGRATION_REQUIRED'])

  const request = Object.freeze({
    clientBuild: 'metasheet-web-2026.07.26',
    connectorProtocolVersion: 3,
    profileId: 'gip.read.v1',
    configVersion: 7,
  })
  const expectation = Object.freeze({ minimumConnectorProtocolVersion: 3, requiredConfigVersion: 7 })

  // POSITIVE CONTROL.
  const ready = evaluateCapabilityHandshake(request, expectation)
  assert.deepEqual(keySet(ready), ['mayRun', 'outcome'])
  assert.equal(ready.outcome, 'READY')
  assert.equal(ready.mayRun, true)
  assert.ok(Object.isFrozen(ready))

  // Version-incompatible ⇒ refuse to run, BOTH directions of incompatibility.
  const old = evaluateCapabilityHandshake({ ...request, connectorProtocolVersion: 2 }, expectation)
  assert.equal(old.outcome, 'UPGRADE_REQUIRED')
  assert.equal(old.mayRun, false)

  const staleConfig = evaluateCapabilityHandshake({ ...request, configVersion: 6 }, expectation)
  assert.equal(staleConfig.outcome, 'CONFIG_MIGRATION_REQUIRED')
  assert.equal(staleConfig.mayRun, false)
  const aheadConfig = evaluateCapabilityHandshake({ ...request, configVersion: 8 }, expectation)
  assert.equal(aheadConfig.outcome, 'CONFIG_MIGRATION_REQUIRED')
  assert.equal(aheadConfig.mayRun, false)

  // ORDERING: too-old protocol wins over a config mismatch — its config claim
  // cannot be trusted to mean what this side means by it.
  const both = evaluateCapabilityHandshake({ ...request, connectorProtocolVersion: 1, configVersion: 6 }, expectation)
  assert.equal(both.outcome, 'UPGRADE_REQUIRED')

  // A NEWER protocol is not an upgrade demand.
  assert.equal(evaluateCapabilityHandshake({ ...request, connectorProtocolVersion: 9 }, expectation).outcome, 'READY')

  // No coercion: a string version must be refused, never parsed. A coercing
  // comparator is how an incompatible peer becomes silently READY.
  refusesWith(() => evaluateCapabilityHandshake({ ...request, connectorProtocolVersion: '3' }, expectation),
    'HANDSHAKE_REQUEST_INVALID')
  refusesWith(() => evaluateCapabilityHandshake({ ...request, configVersion: '7' }, expectation),
    'HANDSHAKE_REQUEST_INVALID')
  refusesWith(() => evaluateCapabilityHandshake(request, { ...expectation, requiredConfigVersion: '7' }),
    'HANDSHAKE_EXPECTATION_INVALID')

  // Closed key sets on BOTH records — an unknown key is refused, never ignored.
  refusesWith(() => evaluateCapabilityHandshake({ ...request, extraCapability: true }, expectation),
    'HANDSHAKE_REQUEST_INVALID')
  refusesWith(() => evaluateCapabilityHandshake(request, { ...expectation, allowDowngrade: true }),
    'HANDSHAKE_EXPECTATION_INVALID')

  refusesWith(() => evaluateCapabilityHandshake({ ...request, clientBuild: '' }, expectation),
    'HANDSHAKE_REQUEST_INVALID')
  refusesWith(() => evaluateCapabilityHandshake({ ...request, profileId: 'a\nb' }, expectation),
    'HANDSHAKE_REQUEST_INVALID')
  refusesWith(() => evaluateCapabilityHandshake(null, expectation), 'HANDSHAKE_REQUEST_INVALID')
  refusesWith(() => evaluateCapabilityHandshake(request, null), 'HANDSHAKE_EXPECTATION_INVALID')
}

// ---------------------------------------------------------------------------
// 1.6-C · The FIVE leak channels this line has actually been bitten by.
//   (1) a public error class  (2) an exported `fail`  (3) hostile property getters
//   (4) Object.keys(proxy) — the ownKeys trap throws during ENUMERATION
//   (5) for...of over an array — the ITERATOR is attacker-reachable
// ---------------------------------------------------------------------------
function noForeignTextEscapes() {
  const observed = []

  function record(fn) {
    try { fn() } catch (error) {
      observed.push(String(error && error.message))
      observed.push(String(error && error.stack))
      observed.push(JSON.stringify(error, Object.getOwnPropertyNames(Object(error))))
      // Every enumerable member of the error, too — a leak hiding in `details`
      // would be invisible to a message-only assertion.
      for (const key of Object.getOwnPropertyNames(Object(error))) {
        try { observed.push(String(error[key])) } catch (_ignored) { /* discard */ }
      }
    }
  }

  // (1) the public error class cannot be made to carry caller text, even when
  //     constructed DIRECTLY with extra arguments.
  const direct = new GipReadObservabilityContractError('COUNTER_SAMPLE_INVALID', ATTACKER_TEXT, { leak: ATTACKER_TEXT })
  observed.push(String(direct.message), String(direct.stack), String(direct.details))
  assert.equal(direct.reason, 'COUNTER_SAMPLE_INVALID')
  assert.equal(direct.details, undefined)
  // An undeclared reason collapses to a coarse fixed token — the rejected VALUE is
  // never echoed.
  const undeclared = new GipReadObservabilityContractError(ATTACKER_TEXT)
  observed.push(String(undeclared.message), String(undeclared.reason))

  // (2) `fail` is not exported, at either level.
  assert.equal(moduleExports.fail, undefined)
  assert.equal(moduleExports.__internals.fail, undefined)

  // (3) hostile property GETTER on a legal-looking key.
  const hostileGetter = {}
  Object.defineProperty(hostileGetter, 'value', {
    enumerable: true,
    get() { throw new Error(ATTACKER_TEXT) },
  })
  record(() => assertValuesFreeCounterSample(hostileGetter))

  const hostileHandshake = { clientBuild: 'b', connectorProtocolVersion: 1, profileId: 'p' }
  Object.defineProperty(hostileHandshake, 'configVersion', {
    enumerable: true,
    get() { throw new Error(ATTACKER_TEXT) },
  })
  record(() => evaluateCapabilityHandshake(hostileHandshake, { minimumConnectorProtocolVersion: 1, requiredConfigVersion: 1 }))

  // (4) Object.keys(proxy): the ownKeys trap throws DURING ENUMERATION, so
  //     guarding the property read is not enough.
  const ownKeysBomb = new Proxy({ value: 1 }, {
    ownKeys() { throw new Error(ATTACKER_TEXT) },
  })
  record(() => assertValuesFreeCounterSample(ownKeysBomb))
  record(() => evaluateCapabilityHandshake(ownKeysBomb, { minimumConnectorProtocolVersion: 1, requiredConfigVersion: 1 }))
  // …and a trap that returns a key whose descriptor read throws.
  const descriptorBomb = new Proxy({ value: 1 }, {
    ownKeys() { return ['value'] },
    getOwnPropertyDescriptor() { throw new Error(ATTACKER_TEXT) },
  })
  record(() => assertValuesFreeCounterSample(descriptorBomb))

  // (5) an array whose ITERATOR is attacker-reachable. The module must not
  //     `for...of` caller data; index-based reads never call Symbol.iterator.
  const iteratorBomb = ['value']
  Object.defineProperty(iteratorBomb, Symbol.iterator, {
    value() { throw new Error(ATTACKER_TEXT) },
  })
  record(() => assertValuesFreeCounterSample(iteratorBomb))
  // The same bomb planted on the prototype chain of a caller-supplied object's
  // key list is covered by (4); this asserts the module survives a poisoned
  // Array.prototype[Symbol.iterator] for the duration of one call.
  // NOTE: no assert helper may run while the prototype is poisoned — node:assert
  // itself iterates. Results are captured, the prototype restored, then asserted.
  const originalArrayIterator = Array.prototype[Symbol.iterator]
  const poisoned = {}
  try {
    Object.defineProperty(Array.prototype, Symbol.iterator, {
      configurable: true,
      writable: true,
      value() { throw new Error(ATTACKER_TEXT) },
    })
    // Must still work — the module iterates by index, not by iterator.
    poisoned.legalValue = assertValuesFreeCounterSample({ value: 3 }).value
    try {
      assertValuesFreeCounterSample({ value: 3, tenantId: 't' })
      poisoned.extraKeyReason = 'NO-THROW'
    } catch (error) {
      poisoned.extraKeyReason = error && error.reason
      poisoned.extraKeyMessage = String(error && error.message)
    }
    poisoned.handshakeOutcome = evaluateCapabilityHandshake(
      { clientBuild: 'b', connectorProtocolVersion: 1, profileId: 'p', configVersion: 1 },
      { minimumConnectorProtocolVersion: 1, requiredConfigVersion: 1 },
    ).outcome
  } finally {
    Object.defineProperty(Array.prototype, Symbol.iterator, {
      configurable: true, writable: true, value: originalArrayIterator,
    })
  }
  assert.equal(poisoned.legalValue, 3)
  assert.equal(poisoned.extraKeyReason, 'COUNTER_SAMPLE_NOT_VALUES_FREE')
  assert.equal(poisoned.handshakeOutcome, 'READY')
  observed.push(String(poisoned.extraKeyMessage))

  // THE ASSERTION: nothing the caller could observe carries the canary.
  assert.ok(observed.length > 0, 'leak-channel probes must have produced observations')
  for (const text of observed) {
    assert.ok(!String(text).includes(ATTACKER_TEXT),
      `foreign text escaped into an observable surface: ${String(text).slice(0, 200)}`)
  }

  // POSITIVE CONTROL for the discard — "discard everything" must not pass. A
  // legitimate internal refusal still surfaces its NAMED reason.
  refusesWith(() => assertValuesFreeCounterSample({ value: -1 }), 'COUNTER_SAMPLE_INVALID')
  refusesWith(() => evaluateCapabilityHandshake({ ...{
    clientBuild: 'b', connectorProtocolVersion: 1, profileId: 'p', configVersion: 1,
  }, nope: 1 }, { minimumConnectorProtocolVersion: 1, requiredConfigVersion: 1 }), 'HANDSHAKE_REQUEST_INVALID')
}

// ---------------------------------------------------------------------------
// 1.6-D · Exact key-set pins — a later re-addition of a trust-granting or
//         error-minting verb reds.
// ---------------------------------------------------------------------------
function exportSurfaceIsPinned() {
  assert.deepEqual(keySet(moduleExports), [
    'CAPABILITY_HANDSHAKE_EXPECTATION_KEYS',
    'CAPABILITY_HANDSHAKE_OUTCOMES',
    'CAPABILITY_HANDSHAKE_REQUEST_KEYS',
    'GipReadObservabilityContractError',
    'OBSERVABILITY_CONTRACT_ERROR_REASONS',
    'UNORDERED_OFFSET_ATTEMPT_COUNTER',
    '__internals',
    'assertValuesFreeCounterSample',
    'evaluateCapabilityHandshake',
  ])
  assert.deepEqual(keySet(moduleExports.__internals), [
    'COUNTER_SAMPLE_KEYS',
    'EXPECTATION_KEY_SET',
    'REQUEST_KEY_SET',
    'assertClosedKeySet',
    'hasControlCharacter',
    'isPlainObject',
  ])
  assert.deepEqual([...OBSERVABILITY_CONTRACT_ERROR_REASONS], [
    'COUNTER_SAMPLE_INVALID',
    'COUNTER_SAMPLE_NOT_VALUES_FREE',
    'HANDSHAKE_REQUEST_INVALID',
    'HANDSHAKE_EXPECTATION_INVALID',
    'HANDSHAKE_INPUT_HOSTILE',
  ])
  assert.ok(Object.isFrozen(OBSERVABILITY_CONTRACT_ERROR_REASONS))
}

// ---------------------------------------------------------------------------
// 1.6-E · LATENT: the shapes are frozen and NOTHING is wired.
//   Executed enumeration with its own positive control (an empty grep is not
//   absence until the grep is shown to find something).
// ---------------------------------------------------------------------------
function latentByEnumeration() {
  const fs = require('node:fs')
  const repoRoot = path.join(__dirname, '..', '..', '..')
  const moduleBasename = 'gip-read-observability-contracts'
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.turbo'])
  const hits = []

  function walk(dir) {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_error) { return }
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(path.join(dir, entry.name))
        continue
      }
      if (!/\.(cjs|mjs|js|ts|tsx)$/.test(entry.name)) continue
      const full = path.join(dir, entry.name)
      let text
      try { text = fs.readFileSync(full, 'utf8') } catch (_error) { continue }
      if (text.includes(moduleBasename)) hits.push(path.relative(repoRoot, full))
    }
  }
  walk(repoRoot)

  // POSITIVE CONTROL: the enumeration must be shown to FIND something. It finds
  // this test file and the module itself; if it found nothing at all, it is
  // grepping the wrong tree and every "zero consumers" claim below is vacuous.
  assert.ok(hits.length >= 2, `enumeration found nothing — it is not reading the tree: ${JSON.stringify(hits)}`)
  assert.ok(hits.some((f) => f.endsWith('__tests__/gip-read-observability-contracts.test.cjs')))
  assert.ok(hits.some((f) => f.endsWith('lib/gip-read-observability-contracts.cjs')))

  // The claim: every reference is the module itself or its own test. No route, no
  // scheduled run, no runtime caller.
  const consumers = hits.filter((f) => !/gip-read-observability-contracts\.(test\.)?cjs$/.test(f))
  assert.deepEqual(consumers, [], `§4 step 1.6 must ship LATENT — found consumers: ${JSON.stringify(consumers)}`)
}

// ---------------------------------------------------------------------------
// 1.6-F · OB-1 (B1a-3 round 3) — the ENFORCEMENT sets, pinned by MEMBERSHIP.
//
// RETRACTION-BEARING NOTE. Before this function existed, the handshake's closed key
// set was pinned only by (a) the exported frozen array `CAPABILITY_HANDSHAKE_REQUEST_KEYS`
// and (b) ONE literal extra-key name, `'nope'`, in a refusal case. Neither touches
// the object the enforcement actually consults. Executed and confirmed: replacing
//     const REQUEST_KEY_SET = new Set(CAPABILITY_HANDSHAKE_REQUEST_KEYS)
// with
//     const REQUEST_KEY_SET = new Set([...CAPABILITY_HANDSHAKE_REQUEST_KEYS, 'debugPayload'])
// left THIS WHOLE SUITE GREEN — the array is unchanged, and `'nope'` still refuses.
// A "novel / freshly-generated key name" case does NOT fix that either: a novel key
// is not `'debugPayload'`, so it still refuses and stays green. It catches a
// different, PERMISSIVE widening (`{ has: () => true }`), so both cases are kept —
// they are not substitutes.
// ---------------------------------------------------------------------------
function enforcementSetsArePinnedByMembership() {
  const { REQUEST_KEY_SET, EXPECTATION_KEY_SET, COUNTER_SAMPLE_KEYS } = moduleExports.__internals

  // MEMBERSHIP EQUALITY against the exported frozen arrays — one extra member in the
  // enforcement Set reds here, however plausible its name.
  assert.deepEqual([...REQUEST_KEY_SET].sort(), [...CAPABILITY_HANDSHAKE_REQUEST_KEYS].sort())
  assert.deepEqual([...EXPECTATION_KEY_SET].sort(), [...CAPABILITY_HANDSHAKE_EXPECTATION_KEYS].sort())
  assert.deepEqual([...COUNTER_SAMPLE_KEYS].sort(), [...UNORDERED_OFFSET_ATTEMPT_COUNTER.sampleKeys].sort())
  assert.equal(REQUEST_KEY_SET.size, CAPABILITY_HANDSHAKE_REQUEST_KEYS.length)
  assert.equal(EXPECTATION_KEY_SET.size, CAPABILITY_HANDSHAKE_EXPECTATION_KEYS.length)
  assert.equal(COUNTER_SAMPLE_KEYS.size, UNORDERED_OFFSET_ATTEMPT_COUNTER.sampleKeys.length)

  // POSITIVE CONTROL for the membership assertions: the comparison must be shown to
  // DISTINGUISH — an all-equal comparator would pass the three lines above vacuously.
  assert.notDeepEqual([...REQUEST_KEY_SET].sort(),
    [...CAPABILITY_HANDSHAKE_REQUEST_KEYS, 'debugPayload'].sort())

  // BEHAVIOURAL, and complementary: a NOVEL key name generated at run time — a name
  // no source file in this repo contains — is refused. This is what catches a
  // permissive widening that keeps the membership listing honest.
  const novelRequestKey = `k_${require('node:crypto').randomBytes(12).toString('hex')}`
  const novelExpectationKey = `k_${require('node:crypto').randomBytes(12).toString('hex')}`
  const novelSampleKey = `k_${require('node:crypto').randomBytes(12).toString('hex')}`
  assert.ok(!REQUEST_KEY_SET.has(novelRequestKey))

  const validRequest = { clientBuild: 'b', connectorProtocolVersion: 1, profileId: 'p', configVersion: 1 }
  const validExpectation = { minimumConnectorProtocolVersion: 1, requiredConfigVersion: 1 }
  refusesWith(
    () => evaluateCapabilityHandshake({ ...validRequest, [novelRequestKey]: 1 }, validExpectation),
    'HANDSHAKE_REQUEST_INVALID',
  )
  refusesWith(
    () => evaluateCapabilityHandshake(validRequest, { ...validExpectation, [novelExpectationKey]: 1 }),
    'HANDSHAKE_EXPECTATION_INVALID',
  )
  refusesWith(
    () => assertValuesFreeCounterSample({ value: 1, [novelSampleKey]: 'x' }),
    'COUNTER_SAMPLE_NOT_VALUES_FREE',
  )
  // POSITIVE CONTROL for the three refusals: the same inputs WITHOUT the novel key
  // must succeed, so "refuses everything" cannot pass.
  assert.equal(evaluateCapabilityHandshake(validRequest, validExpectation).outcome, 'READY')
  assert.equal(assertValuesFreeCounterSample({ value: 1 }).value, 1)
}

function main() {
  counterContract()
  handshakeContract()
  noForeignTextEscapes()
  exportSurfaceIsPinned()
  enforcementSetsArePinnedByMembership()
  latentByEnumeration()
  console.log('gip-read-observability-contracts.test.cjs OK')
}

main()

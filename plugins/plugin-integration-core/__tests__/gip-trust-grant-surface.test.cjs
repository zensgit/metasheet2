'use strict'

// THE TRUST-GRANT SURFACE SWEEP (B1a-3 round 6).
//
// -- WHAT THIS FILE IS FOR --------------------------------------------------
// Rounds 2 through 5 each DISCLOSED the same residual and contained it "by latency":
// `createHarness*ForTests` were public factories whose products carried the trust
// brand, so any in-process importer could assemble a fully trusted executor with an
// attacker-controlled `execute` and a resolution with a caller-chosen
// `systemContentKey`. Round 6 closes it with a GRADE — certified vs harness — and only
// the certified grade is admitted where it matters.
//
// A MECHANISM IS NOT THE DELIVERABLE. The deliverable is this file: a MECHANICAL
// assertion that no publicly-reachable code path yields a CERTIFIED-graded object. A
// mechanism plus a hand-written case list would let the next export silently reopen the
// hole — which is exactly how the residual survived four rounds of hand-written lists.
//
// -- HOW THE SWEEP WORKS ----------------------------------------------------
// 1. ENUMERATE the public surface of all four modules: every top-level export, every
//    member of `__internals`, and every METHOD of an exported object (the certified
//    constants are exported objects, and a method on one is as reachable as a
//    top-level function).
// 2. CALL each entry with argument vectors drawn from a pool, at arities 0..2.
// 3. HARVEST every object it produces: the return value, the own-property values of a
//    plain-object return, and the resolution of a returned promise.
// 4. FIXPOINT: feed the harvest back into the pool and repeat. This is what makes the
//    sweep able to catch a hole that needs TWO calls to reach — build a component with
//    one export, feed it to another, get a certified thing out.
// 5. ASSERT no harvested value answers CERTIFIED to any grade oracle, except values
//    that are `===` a declared pre-branded constant.
//
// -- SCOPE THE CLAIM HONESTLY -----------------------------------------------
// The sweep's claim is bounded by its pool: "no export, over THIS enumerated pool of
// arguments, returns a certified-graded object". It cannot manufacture a first-party
// config store, so it never reaches
// `createApprovedBindingResolver(store, CERTIFIED_…, CERTIFIED_…).resolveApprovedBinding(valid)`.
// That path is executed SEPARATELY and by hand, below, so the two claims together cover
// the certified door as well as the surface. Two executed claims beat one sweep that
// implies more reach than it has.

const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const resolver = require(path.join(LIB, 'gip-approved-binding-resolver.cjs'))
const executor = require(path.join(LIB, 'gip-server-bound-source-executor.cjs'))
const spike = require(path.join(LIB, 'gip-binding-qualification-spike.cjs'))
const gate = require(path.join(LIB, 'gip-inert-entry.cjs'))
const storeModule = require(path.join(LIB, 'read-source-config-store.cjs'))

const MODULES = Object.freeze({
  resolver,
  executor,
  spike,
  'inert-entry': gate,
})

// The ONLY objects allowed to answer CERTIFIED. Each is a module-load constant built
// from a first-party literal — there is no argument a caller can supply to any of them.
// This list is asserted to be EXHAUSTIVE below, by identity, not by name.
const PRE_BRANDED_CERTIFIED_CONSTANTS = Object.freeze([
  ['resolver.CERTIFIED_SYSTEM_IDENTITY_AUTHORITY', resolver.CERTIFIED_SYSTEM_IDENTITY_AUTHORITY],
  ['resolver.CERTIFIED_CANONICAL_OBJECT_AUTHORITY', resolver.CERTIFIED_CANONICAL_OBJECT_AUTHORITY],
  ['executor.CERTIFIED_HTTP_PROBE_ACTION_REGISTRY', executor.CERTIFIED_HTTP_PROBE_ACTION_REGISTRY],
])

// Grade oracles, taken FROM THE MODULES THEMSELVES. A sweep that asked its own
// reimplementation of "is this certified?" would be checking a copy of the rule rather
// than the rule.
function realOracles() {
  return [
    ['bindingResolutionGrade', (v) => resolver.bindingResolutionGrade(v) === 'certified'],
    ['systemIdentityAuthorityGrade', (v) => resolver.systemIdentityAuthorityGrade(v) === 'certified'],
    ['canonicalObjectAuthorityGrade', (v) => resolver.canonicalObjectAuthorityGrade(v) === 'certified'],
    ['httpProbeActionRegistryGrade', (v) => executor.httpProbeActionRegistryGrade(v) === 'certified'],
    ['sourceBinderGrade', (v) => executor.sourceBinderGrade(v) === 'certified'],
    ['serverBoundSourceExecutorGrade', (v) => executor.serverBoundSourceExecutorGrade(v) === 'certified'],
    // The two boolean checkers are included on purpose: they are what downstream code
    // actually calls, so if a grade reader and a checker ever disagree, the sweep sees
    // it rather than trusting the reader alone.
    ['isTrustedBindingResolution', (v) => resolver.isTrustedBindingResolution(v) === true],
    ['isTrustedServerBoundSourceExecutor', (v) => executor.isTrustedServerBoundSourceExecutor(v) === true],
  ]
}

function isPlainish(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isClassConstructor(fn) {
  return /^class[\s{]/.test(Function.prototype.toString.call(fn))
}

// --- 1. ENUMERATE -----------------------------------------------------------

function enumerateSurface(label, table) {
  const entries = []
  const walk = (prefix, node, depth) => {
    if (depth > 2) return
    let keys
    try { keys = Object.keys(node) } catch (_error) { return }
    for (const key of keys) {
      let value
      try { value = node[key] } catch (_error) { continue }
      const name = `${prefix}.${key}`
      if (typeof value === 'function') {
        entries.push({ name, fn: value, isClass: isClassConstructor(value) })
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        // `__internals` is a plain object; the certified constants are frozen objects
        // with methods. Both are require()-reachable, so both are walked.
        walk(name, value, depth + 1)
      }
    }
  }
  walk(label, table, 0)
  return entries
}

// --- 2/3/4. CALL, HARVEST, FIXPOINT ----------------------------------------

const POOL_CAP = 90

function seedPool() {
  const seeds = [
    undefined, null, 0, 1, '', 'x', 'fixture.http_read.v1', 'sys-alpha', true,
    {}, [], Object.create(null),
    () => 'x',
    async () => ({ duplicateGroupsSampled: 0, nullKeyRowsSampled: 0 }),
    () => ({ execute: async () => ({ duplicateGroupsSampled: 0, nullKeyRowsSampled: 0 }) }),
    { systemContentKey: 'k', credentialFactory: () => ({ execute: async () => ({}) }) },
    { contractId: 'c', contractVersion: 'v1', canonicalObjectVersion: 'o/1' },
    { 'sys-alpha': 'SCK' },
    // The certified constants are IN the pool. That is the point: if any export can
    // take a certified thing and hand back another certified thing it did not already
    // have, the fixpoint finds it.
    resolver.CERTIFIED_SYSTEM_IDENTITY_AUTHORITY,
    resolver.CERTIFIED_CANONICAL_OBJECT_AUTHORITY,
    executor.CERTIFIED_HTTP_PROBE_ACTION_REGISTRY,
    { systemIdentityAuthority: resolver.CERTIFIED_SYSTEM_IDENTITY_AUTHORITY, canonicalObjectAuthority: resolver.CERTIFIED_CANONICAL_OBJECT_AUTHORITY },
    { actionRegistry: executor.CERTIFIED_HTTP_PROBE_ACTION_REGISTRY, sourceBinder: undefined },
    { executor: undefined },
  ]
  return seeds
}

async function harvest(value, sink) {
  if (value === null || typeof value !== 'object') return
  sink.push(value)
  if (typeof value.then === 'function') {
    let settled
    try { settled = await value } catch (_error) { return }
    if (settled !== null && typeof settled === 'object') sink.push(settled)
    return
  }
  if (isPlainish(value) || Object.isFrozen(value)) {
    let keys
    try { keys = Object.keys(value) } catch (_error) { return }
    for (const key of keys) {
      let member
      try { member = value[key] } catch (_error) { continue }
      if (member !== null && typeof member === 'object') sink.push(member)
    }
  }
}

async function sweep({ specs, oracles, rounds = 3 }) {
  const violations = []
  const allEntries = []
  for (const [label, table] of specs) allEntries.push(...enumerateSurface(label, table))

  let pool = seedPool()
  let calls = 0
  const seen = new Set()

  const check = (value, origin) => {
    if (value === null || typeof value !== 'object') return
    const allowed = PRE_BRANDED_CERTIFIED_CONSTANTS.find(([, constant]) => constant === value)
    for (const [oracleName, oracle] of oracles) {
      let certified = false
      try { certified = oracle(value) } catch (_error) { certified = false }
      if (!certified) continue
      if (allowed) continue
      violations.push(`${origin} produced a CERTIFIED-graded object (${oracleName})`)
    }
  }

  for (let round = 0; round < rounds; round += 1) {
    const harvested = []
    for (const entry of allEntries) {
      for (let arity = 0; arity <= 2; arity += 1) {
        for (const a of pool) {
          const args = arity === 0 ? [] : arity === 1 ? [a] : [a, a]
          if (arity === 0 && a !== pool[0]) continue
          calls += 1
          let returned
          try {
            returned = entry.isClass ? new entry.fn(...args) : entry.fn(...args)
          } catch (_error) {
            continue
          }
          const sink = []
          try { await harvest(returned, sink) } catch (_error) { /* discard */ }
          for (const value of sink) {
            check(value, `${entry.name}`)
            if (!seen.has(value) && harvested.length + pool.length < POOL_CAP) {
              seen.add(value)
              harvested.push(value)
            }
          }
        }
      }
    }
    if (harvested.length === 0) break
    pool = pool.concat(harvested).slice(0, POOL_CAP)
  }
  return { violations, calls, entryCount: allEntries.length }
}

// ---------------------------------------------------------------------------
// THE ASSERTION.
// ---------------------------------------------------------------------------
async function noPublicExportMintsCertifiedGrade() {
  const result = await sweep({
    specs: Object.entries(MODULES),
    oracles: realOracles(),
  })
  // The walk must be shown to have DONE something: a sweep over zero exports passes
  // every assertion below it.
  assert.ok(result.entryCount >= 30, `the sweep enumerated too few exports (${result.entryCount})`)
  assert.ok(result.calls >= 2000, `the sweep executed too few calls (${result.calls})`)
  assert.deepEqual(result.violations, [],
    `a public export produced a CERTIFIED-graded object:\n  ${result.violations.join('\n  ')}`)
  console.log(`  SWEEP entries=${result.entryCount} calls=${result.calls} violations=0`)
}

// ---------------------------------------------------------------------------
// POSITIVE CONTROL — re-add ONE granting factory and the sweep must RED, NAMING IT.
//
// Without this, the sweep above is indistinguishable from a sweep that inspects
// nothing. The mutation is applied to a COPY of the resolver written next to the real
// one (so its relative `require`s resolve), loaded, swept, and deleted. The copy has
// its OWN WeakSets, so the mutant's own grade readers are added to the oracle set —
// asking the REAL module about a MUTANT object would answer "not certified" for a
// reason that has nothing to do with the mutation, and the control would pass while
// proving nothing.
// ---------------------------------------------------------------------------
async function reAddingAGrantingFactoryRedsTheSweep() {
  const realPath = path.join(LIB, 'gip-approved-binding-resolver.cjs')
  const mutantPath = path.join(LIB, 'gip-approved-binding-resolver.__sweep-mutant.cjs')
  const source = fs.readFileSync(realPath, 'utf8')

  // THE MUTATION MUST CHANGE BEHAVIOUR, or it has tested nothing. This one re-opens
  // exactly the round-2..5 hole: the public harness factory writes the CERTIFIED set.
  const NEEDLE = '  harnessSystemIdentityAuthorities.add(authority)'
  assert.ok(source.includes(NEEDLE), 'the mutation target has moved — the control is looking for something that no longer exists')
  const mutated = source.replace(NEEDLE, '  certifiedSystemIdentityAuthorities.add(authority)')
  assert.notEqual(mutated, source, 'the mutation produced an identical file — it would prove nothing')

  let result
  try {
    fs.writeFileSync(mutantPath, mutated)
    const mutant = require(mutantPath)
    // PROVE THE MUTATION IS LIVE before drawing any conclusion from the sweep.
    const minted = mutant.createHarnessSystemIdentityAuthorityForTests({ 'sys-alpha': 'SCK' })
    assert.equal(mutant.systemIdentityAuthorityGrade(minted), 'certified',
      'the mutation did not change behaviour — discard it and write a different one')

    result = await sweep({
      specs: [['resolver', mutant]],
      oracles: realOracles().concat([
        ['mutant.systemIdentityAuthorityGrade', (v) => mutant.systemIdentityAuthorityGrade(v) === 'certified'],
        ['mutant.canonicalObjectAuthorityGrade', (v) => mutant.canonicalObjectAuthorityGrade(v) === 'certified'],
        ['mutant.bindingResolutionGrade', (v) => mutant.bindingResolutionGrade(v) === 'certified'],
      ]),
      rounds: 1,
    })
    delete require.cache[require.resolve(mutantPath)]
  } finally {
    // The tree must be restored byte-identically whatever happens above.
    if (fs.existsSync(mutantPath)) fs.unlinkSync(mutantPath)
  }
  assert.ok(!fs.existsSync(mutantPath), 'the mutant file was not removed')

  assert.ok(result.violations.length > 0, 'POSITIVE CONTROL FAILED: the sweep stayed green with a granting factory re-added')
  const named = result.violations.filter((v) => v.startsWith('resolver.createHarnessSystemIdentityAuthorityForTests'))
  assert.ok(named.length > 0,
    `the sweep must NAME the offending export; it reported:\n  ${result.violations.join('\n  ')}`)
  console.log(`  CONTROL mutant reded ${result.violations.length} violation(s); first: ${named[0]}`)
}

// ---------------------------------------------------------------------------
// The pre-branded CONSTANT surface is EXHAUSTIVE.
//
// The sweep calls functions. A future `CERTIFIED_FOO` added as a plain constant export
// would never be called and would slip past it entirely.
// ---------------------------------------------------------------------------
function preBrandedConstantsAreExactlyTheDeclaredThree() {
  const found = []
  for (const [label, table] of Object.entries(MODULES)) {
    for (const key of Object.keys(table)) {
      let value
      try { value = table[key] } catch (_error) { continue }
      if (value === null || typeof value !== 'object') continue
      for (const [, oracle] of realOracles()) {
        let certified = false
        try { certified = oracle(value) } catch (_error) { certified = false }
        if (certified) { found.push(`${label}.${key}`); break }
      }
    }
  }
  assert.deepEqual(found.sort(), PRE_BRANDED_CERTIFIED_CONSTANTS.map(([name]) => name).sort(),
    'the set of pre-branded certified constant exports has changed')
  // ...and each really is certified, so the list is not three names that happen to
  // match nothing.
  for (const [name, value] of PRE_BRANDED_CERTIFIED_CONSTANTS) {
    const certified = realOracles().some(([, oracle]) => {
      try { return oracle(value) } catch (_error) { return false }
    })
    assert.ok(certified, `${name} is on the allowlist but is not certified — the allowlist is stale`)
  }
  console.log(`  CONSTANTS pre-branded certified exports = exactly ${found.length}: ${found.join(', ')}`)
}

// ---------------------------------------------------------------------------
// THE PATH THE SWEEP CANNOT REACH, EXECUTED BY HAND.
//
// The sweep cannot manufacture a first-party config store, so it never drives the one
// remaining certified door: a resolver built from a REAL store and BOTH certified
// authorities. That door is the whole reason the certified grade exists, so it is
// executed here rather than left to the sweep's implied reach.
// ---------------------------------------------------------------------------
async function theCertifiedDoorItselfMintsNothingAtThisHead() {
  const { createReadSourceConfigStore } = storeModule
  // No row is needed: the test asserts WHICH door fires, so an empty store cannot mask
  // the answer — it can only change which of the two declared reasons comes back, and
  // both are asserted.
  const store = createReadSourceConfigStore({
    db: {
      async selectOne() { return null },
      async select() { return [] },
      async insertOne() { return null },
      async updateRow() { return null },
      async transaction(fn) { return fn(this) },
    },
  })
  const certifiedResolver = resolver.createApprovedBindingResolver({
    configStore: store,
    systemIdentityAuthority: resolver.CERTIFIED_SYSTEM_IDENTITY_AUTHORITY,
    canonicalObjectAuthority: resolver.CERTIFIED_CANONICAL_OBJECT_AUTHORITY,
  })
  // The construction SUCCEEDS — this is a genuine certified stack, not a refusal that
  // could be mistaken for one.
  assert.equal(typeof certifiedResolver.resolveApprovedBinding, 'function')

  let caught = null
  try {
    await certifiedResolver.resolveApprovedBinding({
      tenantId: 't-1', workspaceId: null, approvedConfigVersionId: 'cfg-1',
    })
  } catch (error) { caught = error }
  assert.ok(caught instanceof resolver.GipApprovedBindingResolverError,
    `the certified door must refuse with this module's own brand, got ${caught && caught.constructor && caught.constructor.name}`)
  assert.ok(resolver.BINDING_RESOLVER_ERROR_REASONS.includes(caught.reason))
  // NO resolution came back, so nothing was minted. Stated as an assertion rather than
  // inferred from the throw.
  assert.equal(caught.reason === 'RESOLVER_APPROVED_CONFIG_UNAVAILABLE'
    || caught.reason === 'RESOLVER_SYSTEM_IDENTITY_UNAVAILABLE', true,
  `unexpected refusal reason on the certified door: ${caught.reason}`)
  console.log(`  CERTIFIED DOOR builds, then refuses with ${caught.reason}; no resolution minted`)
}

// ---------------------------------------------------------------------------
// The two modules agree on the grade vocabulary across the require boundary.
// ---------------------------------------------------------------------------
function theGradeVocabularyHasOneOwner() {
  assert.deepEqual([...resolver.BINDING_GRADES], ['certified', 'harness'])
  assert.ok(Object.isFrozen(resolver.BINDING_GRADES))
  // The executor and the spike both destructure this array rather than spelling the
  // tokens themselves. Pinned by source, because a re-declared literal would agree
  // today and drift on one side only.
  for (const name of ['gip-server-bound-source-executor.cjs', 'gip-binding-qualification-spike.cjs']) {
    const source = fs.readFileSync(path.join(LIB, name), 'utf8')
    const executable = source.split('\n').filter((line) => !/^\s*(\/\/|\*)/.test(line)).join('\n')
    assert.ok(/BINDING_GRADES/.test(executable), `${name} must import the grade vocabulary`)
    assert.ok(!/=\s*'certified'/.test(executable), `${name} must not re-declare the certified token`)
    assert.ok(!/=\s*'harness'/.test(executable), `${name} must not re-declare the harness token`)
  }
  console.log('  VOCABULARY one owner (resolver.BINDING_GRADES); executor + spike import it, neither re-declares')
}

async function main() {
  await noPublicExportMintsCertifiedGrade()
  await reAddingAGrantingFactoryRedsTheSweep()
  preBrandedConstantsAreExactlyTheDeclaredThree()
  await theCertifiedDoorItselfMintsNothingAtThisHead()
  theGradeVocabularyHasOneOwner()
  console.log('gip-trust-grant-surface.test.cjs OK')
}

main().catch((error) => {
  console.error('gip-trust-grant-surface.test.cjs FAILED')
  console.error(error)
  process.exit(1)
})

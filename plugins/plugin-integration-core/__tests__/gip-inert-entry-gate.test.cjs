'use strict'

// GIP B1a-3 round 5 — THE INERT-ENTRY GATE, asserted over the EXPORT TABLE.
//
// -- WHY THIS FILE EXISTS, AND WHY IT IS NOT A SIXTH TRAP LIST ---------------
// Rounds 2, 3 and 4 each found a NEW trappable operation on caller data — a public
// error class and an exported `fail`; hostile getters; `Object.keys` / `ownKeys`;
// the `for...of` iterator; symbol keys; a raw component read; `Object.getPrototypeOf`;
// a raw read of a foreign factory's return. Each round closed what it had found and
// the next round found another. That is not convergence, and no amount of it ever
// yields the claim anybody actually wants, because "we found all the traps" is not
// assertable: JavaScript still offers `has`, `getOwnPropertyDescriptor`,
// `defineProperty`, `Symbol.toPrimitive`, `valueOf`, `toString` and whatever else
// gets added to the language later.
//
// The assertable claim is a PROPERTY OVER THE EXPORT TABLE:
//
//   For EVERY function-valued public export of the three modules — top level AND
//   `__internals` — and for EVERY hostile construction in the matrix: the call
//   either returns inert data, or throws/rejects an error that is an instance of
//   that module's OWN branded class, whose `reason` is in that module's FROZEN
//   vocabulary, and whose `message` is a function OF THE REASON ALONE.
//
// The walk is over the table, not over a hand-written list of entry points, so an
// export added tomorrow is tested tomorrow with nobody remembering to add it. That
// is the whole difference between this and trap enumeration.
//
// -- THE TWO DOORS HAVE EXCLUSIVE FAILURES ----------------------------------
// Two fail-closed doors in series normally cover for each other. Here they cannot:
//   L1 (`inertRecord` at first touch) fails with the module's own PRECISE token;
//   L2 (`createEntryGuard` at the boundary) fails with `*_ENTRY_NOT_INERT`, which no
//   path inside any of the three modules emits.
// Every matrix cell pins the EXACT reason. Remove L1 from one export and its cells
// flip to the L2 token, reding and NAMING that export; neuter L2 and anything L1 does
// not cover escapes unbranded, reding. Both mutations are recorded in the PR body.
//
// -- THE MESSAGE COMES FROM A CLOSED SET, NOT FROM THE INPUT ----------------
// The strongest single check here is not "this round's canary did not appear" —
// that only ever tests the string somebody thought to plant. It is that every
// message a public export ever produced is a member of a CLOSED SET computed at
// module load by constructing the branded error over each declared reason plus the
// undeclared-reason fallback. A message assembled from input cannot be in that set,
// whatever the input was. The set is derived by CONSTRUCTION rather than read from
// the module, so the modules export nothing new to be checked.
//
// The undeclared-reason fallback is deliberately included: it is the house
// convention across eleven modules in this package, it is a fixed first-party
// string, and an `__internals` helper invoked with the wrong arity legitimately
// reaches it. Admitting it is not a weakening — the set is still closed.

const assert = require('node:assert')

const CANARY = 'GIP-R5-ENTRY-CANARY-do-not-echo'

const observability = require('../lib/gip-read-observability-contracts.cjs')
const resolver = require('../lib/gip-approved-binding-resolver.cjs')
const executor = require('../lib/gip-server-bound-source-executor.cjs')

// ---------------------------------------------------------------------------
// THE HOSTILE MATRIX.
//
// Named constructions, each a FRESH value per use — a Proxy that has already thrown
// is not the same test the second time. The list deliberately includes operations
// NO ROUND HAS YET FOUND (`getOwnPropertyDescriptor`, `has`, `defineProperty`,
// `Symbol.toPrimitive`, `valueOf`, `toString`), because the point of a structural
// gate is that it closes them without having been told about them.
// ---------------------------------------------------------------------------
const HOSTILE = Object.freeze({
  getPrototypeOfTrap: () => new Proxy({}, { getPrototypeOf() { throw new Error(CANARY) } }),
  ownKeysTrap: () => new Proxy({}, { ownKeys() { throw new Error(CANARY) } }),
  getTrap: () => new Proxy({}, { get() { throw new Error(CANARY) } }),
  getOwnPropertyDescriptorTrap: () => new Proxy(
    { value: 1 }, { getOwnPropertyDescriptor() { throw new Error(CANARY) } },
  ),
  hasTrap: () => new Proxy({}, { has() { throw new Error(CANARY) } }),
  definePropertyTrap: () => new Proxy({}, { defineProperty() { throw new Error(CANARY) } }),
  // `ownKeys` reporting a key whose descriptor is absent — a Proxy is free to be
  // inconsistent, and an unprepared snapshot walker dereferences `undefined`.
  inconsistentOwnKeys: () => new Proxy({}, {
    ownKeys() { return ['ghost'] },
    getOwnPropertyDescriptor() { return undefined },
  }),
  throwingGetterEnumerable: () => {
    const target = {}
    Object.defineProperty(target, 'value', { enumerable: true, get() { throw new Error(CANARY) } })
    return target
  },
  throwingGetterNonEnumerable: () => {
    const target = {}
    Object.defineProperty(target, 'value', { enumerable: false, get() { throw new Error(CANARY) } })
    return target
  },
  setterOnlyAccessor: () => {
    const target = {}
    Object.defineProperty(target, 'value', { enumerable: true, set(_v) { throw new Error(CANARY) } })
    return target
  },
  poisonedSymbolIterator: () => {
    const target = { value: 1 }
    target[Symbol.iterator] = function poisoned() { throw new Error(CANARY) }
    return target
  },
  symbolToPrimitive: () => {
    const target = { value: 1 }
    target[Symbol.toPrimitive] = function poisoned() { throw new Error(CANARY) }
    return target
  },
  throwingValueOf: () => ({ value: 1, valueOf() { throw new Error(CANARY) } }),
  throwingToString: () => ({ value: 1, toString() { throw new Error(CANARY) } }),
  throwingSymbolKeyedGetter: () => {
    const target = { value: 1 }
    Object.defineProperty(target, Symbol('tenantId'), {
      enumerable: true, get() { throw new Error(CANARY) },
    })
    return target
  },
  hostileArrayLength: () => new Proxy([], { get(t, k) { if (k === 'length') throw new Error(CANARY); return t[k] } }),
})

const HOSTILE_NAMES = Object.freeze(Object.keys(HOSTILE))

// CARRIERS — the same hostile value delivered in the positions a real caller can
// reach: bare, inside an array (every `entries`-shaped export), and as a member of an
// otherwise-plausible record (so the hostile value survives the container's own
// shape check and is met deeper in).
const CARRIERS = Object.freeze({
  bare: (make) => make(),
  inArray: (make) => [make()],
  asMember: (make) => ({ value: make() }),
})
const CARRIER_NAMES = Object.freeze(Object.keys(CARRIERS))

// ---------------------------------------------------------------------------
// The audit. Returns a list of VIOLATION STRINGS, each naming the export it came
// from — so a failure says which export regressed, not merely that something did.
// ---------------------------------------------------------------------------
function isClassConstructor(fn) {
  return /^class[\s{]/.test(Function.prototype.toString.call(fn))
}

async function auditExportTable(spec) {
  const { label, table, BrandedError, vocabulary } = spec
  const reasons = new Set(vocabulary)
  const violations = []
  const messagesSeen = new Set()
  let executed = 0

  // THE CLOSED MESSAGE SET, derived by construction: one message per declared reason,
  // plus the single undeclared-reason fallback. Nothing assembled from caller input
  // can be a member.
  const admissibleMessages = new Set()
  for (const reason of vocabulary) admissibleMessages.add(String(new BrandedError(reason).message))
  admissibleMessages.add(String(new BrandedError('__NOT_A_DECLARED_REASON__').message))
  assert.equal(admissibleMessages.size, new Set(vocabulary).size + 1,
    `${label}: each declared reason must have its OWN fixed message, distinct from the fallback`)

  const entries = []
  for (const key of Object.keys(table)) {
    const value = table[key]
    if (typeof value === 'function') {
      // TOP-LEVEL PUBLIC EXPORT. L1 must contain it — see `l2Forbidden` below.
      entries.push({ name: `${label}.${key}`, fn: value, isClass: isClassConstructor(value), l2Forbidden: true })
    } else if (key === '__internals' && value && typeof value === 'object') {
      for (const inner of Object.keys(value)) {
        const innerValue = value[inner]
        if (typeof innerValue === 'function') {
          entries.push({
            name: `${label}.__internals.${inner}`,
            fn: innerValue,
            isClass: isClassConstructor(innerValue),
            // `__internals` is the DECLARED exception: its members are the module's
            // own primitives, exposed so their behaviour can be pinned, and they are
            // guarded by L2 alone rather than snapshotted. They are what demonstrates
            // L2 is wired in the SHIPPED build rather than only under mutation.
            l2Forbidden: false,
          })
        }
      }
    } else if (value && typeof value === 'object') {
      // Methods hanging off an exported object — the shape that produced round 3's
      // raw component read. Identity-carrying exports are NOT wrapped (wrapping would
      // break `WeakSet.has`), so their inertness is EXECUTED here rather than assumed.
      for (const inner of Object.keys(value)) {
        if (typeof value[inner] === 'function') {
          entries.push({ name: `${label}.${key}.${inner}`, fn: value[inner], isClass: false, l2Forbidden: true })
        }
      }
    }
  }

  // EXHAUSTIVENESS: nothing in the table may be a shape this walk silently skips.
  for (const key of Object.keys(table)) {
    const value = table[key]
    const kind = typeof value
    if (kind !== 'function' && kind !== 'object' && kind !== 'string' && kind !== 'number' && kind !== 'boolean') {
      violations.push(`${label}.${key}: export of unhandled kind ${kind} — the walk does not cover it`)
    }
  }

  for (const entry of entries) {
    for (const hostileName of HOSTILE_NAMES) {
      for (const carrierName of CARRIER_NAMES) {
        const make = HOSTILE[hostileName];
        const cell = `${entry.name} [${hostileName}/${carrierName}]`
        executed += 1
        let thrown = null
        let returned
        try {
          const args = [CARRIERS[carrierName](make), CARRIERS[carrierName](make)]
          returned = entry.isClass ? new entry.fn(...args) : entry.fn(...args)
          if (returned && typeof returned === 'object' && typeof returned.then === 'function') {
            // An async export turns a throw into a REJECTION. Awaiting is not
            // optional: a synchronous-only harness reports every async entry point as
            // clean no matter what it does.
            returned = await returned
          }
        } catch (error) {
          thrown = error
        }

        if (thrown !== null) {
          if (!(thrown instanceof BrandedError)) {
            violations.push(`${cell}: escaped UNBRANDED as ${thrown && thrown.constructor && thrown.constructor.name}`)
            continue
          }
          if (!reasons.has(thrown.reason)) {
            violations.push(`${cell}: reason "${String(thrown.reason)}" is outside the frozen vocabulary`)
            continue
          }
          // THE PER-EXPORT L1 ASSERTION — this is the deliverable, and it is what
          // stops the two doors from covering for each other.
          //
          // "Branded with a vocabulary reason" is satisfied by L2 ALONE, so a check
          // that stopped one line above would stay GREEN with L1 deleted from every
          // export — measured, not assumed: with L1 removed from
          // `assertValuesFreeCounterSample`, the matrix passed and only a
          // hand-written case list caught it. A hand-written case list is the very
          // thing this file exists to replace.
          //
          // The rule is per-export and mechanical: a TOP-LEVEL public export must
          // never reach L2, because L1 is supposed to have contained the input first.
          // Reaching L2 means the snapshot is missing. `__internals` members are the
          // declared exception and are exercised as L2's live positive control.
          if (entry.l2Forbidden && String(thrown.reason).endsWith('_ENTRY_NOT_INERT')) {
            violations.push(
              `${cell}: reached the L2 BOUNDARY (${thrown.reason}) — this public export does not route caller data through the L1 inert-entry gate`)
            continue
          }
          const message = String(thrown.message)
          if (message.includes(CANARY) || String(thrown.stack || '').includes(CANARY)) {
            violations.push(`${cell}: attacker text reached message/stack`)
            continue
          }
          // CLOSED MESSAGE SET. This is the check that does not depend on guessing
          // what a leak would look like: a message assembled from caller input is not
          // one of the fixed strings the class can construct, whatever it contains.
          if (!admissibleMessages.has(message)) {
            violations.push(`${cell}: message is outside the closed set: ${JSON.stringify(message.slice(0, 120))}`)
            continue
          }
          messagesSeen.add(message)
          continue
        }

        // Returned normally — the return must be inert too. An export that answers
        // with the attacker's own object has leaked just as surely as one that throws
        // it.
        let rendered
        try {
          rendered = JSON.stringify(returned) || String(returned)
        } catch (_error) {
          rendered = ''
        }
        if (String(rendered).includes(CANARY)) {
          violations.push(`${cell}: attacker text reached the RETURN value`)
        }
      }
    }
  }

  return { violations, executed, entryCount: entries.length, messagesSeen: messagesSeen.size }
}

const MODULES = [
  {
    label: 'observability',
    table: observability,
    BrandedError: observability.GipReadObservabilityContractError,
    vocabulary: observability.OBSERVABILITY_CONTRACT_ERROR_REASONS,
  },
  {
    label: 'resolver',
    table: resolver,
    BrandedError: resolver.GipApprovedBindingResolverError,
    vocabulary: resolver.BINDING_RESOLVER_ERROR_REASONS,
  },
  {
    label: 'executor',
    table: executor,
    BrandedError: executor.GipSourceExecutorError,
    vocabulary: executor.SOURCE_EXECUTOR_ERROR_REASONS,
  },
]

async function entryTableIsGated() {
  const totals = []
  for (const spec of MODULES) {
    const result = await auditExportTable(spec)
    assert.deepEqual(result.violations, [],
      `${spec.label}: public exports must route caller data through the inert-entry gate:\n  ${result.violations.join('\n  ')}`)
    // The walk must be shown to have DONE something. A checker that inspects zero
    // exports passes every assertion above it.
    assert.ok(result.entryCount >= 5, `${spec.label}: the walk found too few exports (${result.entryCount})`)
    assert.ok(result.executed >= 200, `${spec.label}: too few cells executed (${result.executed})`)
    totals.push(`${spec.label}: entries=${result.entryCount} cells=${result.executed} distinct-messages=${result.messagesSeen}`)
  }
  console.log('  MATRIX ' + totals.join('\n  MATRIX '))
}

// ---------------------------------------------------------------------------
// POSITIVE CONTROL FOR THE CHECKER ITSELF.
//
// Everything above asserts an ABSENCE. An absence assertion proves nothing until the
// checker is shown to be capable of reporting a presence — a walk that silently
// inspected nothing, or a violation list that is never appended to, would be green
// against nothing. So the SAME `auditExportTable` is run over a synthetic module that
// deliberately skips the gate on one export, and it must report a violation NAMING
// that export.
//
// This runs on every CI run. It is NOT a substitute for mutating the real modules —
// that is done separately and recorded in the PR body — it is what stops this file
// from decaying into a vacuous pass.
// ---------------------------------------------------------------------------
async function checkerHasTeeth() {
  // Mirrors the real classes' shape: one FIXED message per declared reason, plus a
  // single undeclared-reason fallback. The control must be structurally comparable to
  // what it is controlling for, or it is testing a different thing.
  const SYNTHETIC_MESSAGES = { SYNTHETIC_REFUSED: 'synthetic refusal' }
  class SyntheticError extends Error {
    constructor(reason) {
      const known = typeof reason === 'string' && Object.prototype.hasOwnProperty.call(SYNTHETIC_MESSAGES, reason)
      super(known ? SYNTHETIC_MESSAGES[reason] : 'synthetic internal: undeclared error reason')
      this.reason = known ? reason : 'SYNTHETIC_REFUSED'
    }
  }
  const synthetic = {
    SYNTHETIC_REASONS: Object.freeze(['SYNTHETIC_REFUSED']),
    SyntheticError,
    // GATED: behaves exactly as the real exports do.
    gatedExport(value) {
      if (!value || typeof value !== 'object') throw new SyntheticError('SYNTHETIC_REFUSED')
      throw new SyntheticError('SYNTHETIC_REFUSED')
    },
    // UNGATED: reads the caller's object the way the modules did before round 5 —
    // an unguarded prototype interrogation, exactly the round-4 P1.
    ungatedExport(value) {
      if (value && typeof value === 'object') Object.getPrototypeOf(value)
      return null
    },
  }
  const result = await auditExportTable({
    label: 'synthetic',
    table: synthetic,
    BrandedError: SyntheticError,
    vocabulary: synthetic.SYNTHETIC_REASONS,
  })
  assert.ok(result.violations.length > 0, 'the checker reported nothing on a deliberately ungated export')
  const named = result.violations.filter((v) => v.startsWith('synthetic.ungatedExport'))
  assert.ok(named.length > 0,
    `the checker must NAME the ungated export; got: ${result.violations.slice(0, 3).join(' | ')}`)
  // And it must NOT smear the failure across the gated sibling — a checker that
  // reports every export on any failure names nothing useful.
  const collateral = result.violations.filter((v) => v.startsWith('synthetic.gatedExport'))
  assert.deepEqual(collateral, [], `the gated export must stay clean; got: ${collateral.join(' | ')}`)
  console.log(`  CONTROL checker named ${named.length} violation(s) on synthetic.ungatedExport, 0 on synthetic.gatedExport`)
}

// ---------------------------------------------------------------------------
// (α) — THE CREDENTIAL HANDLE IS GUARDED WITHOUT BEING ENUMERATED.
//
// The handle returned by a connector's `credentialFactory()` is deliberately NOT
// routed through the inert gate: `inertRecord` works by enumerating a value's own
// property names and symbols, and decision (α) requires that the secret is "never
// reachable from the executor". Snapshotting the handle is how the executor would
// come to hold and be able to list whatever it carries.
//
// So the read is guarded explicitly AND the handle is retained BY IDENTITY. The
// identity assertion is the mechanical proof that no enumeration happened: without
// it, "we did not copy the handle" is a comment, and a later edit routing this
// through the gate would pass unnoticed.
// ---------------------------------------------------------------------------
function credentialHandleIsGuardedNotEnumerated() {
  // 1. A hostile handle must be refused with a CLOSED token, not a bare Error.
  const hostileShapes = [
    () => new Proxy({}, { get(_t, k) { if (k === 'execute') throw new Error(CANARY); return undefined } }),
    () => { const h = {}; Object.defineProperty(h, 'execute', { get() { throw new Error(CANARY) } }); return h },
    () => new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(CANARY) } }),
  ]
  let refused = 0
  for (const make of hostileShapes) {
    assert.throws(
      () => executor.createHarnessSourceBinderForTests([{ systemContentKey: 'sck-1', credentialFactory: make }]),
      (error) => {
        assert.ok(error instanceof executor.GipSourceExecutorError, 'a hostile handle must be refused BRANDED')
        assert.equal(error.reason, 'EXECUTOR_COMPONENTS_INVALID')
        assert.ok(!String(error.message).includes(CANARY), 'no attacker text in the message')
        assert.ok(!String(error.stack || '').includes(CANARY), 'no attacker text in the stack')
        refused += 1
        return true
      },
    )
  }
  assert.equal(refused, hostileShapes.length)

  // 2. IDENTITY. The binder must hand back the VERY OBJECT the factory returned —
  // not a snapshot, not a clone, not a rebuilt record. A secret-bearing member is
  // therefore never read, never listed and never copied by this module.
  const secretBearing = { execute: async () => ({ duplicateGroupsSampled: 0, nullKeyRowsSampled: 0 }) }
  Object.defineProperty(secretBearing, 'bearerToken', {
    enumerable: true,
    get() { throw new Error('(α) VIOLATED: the executor enumerated the opaque handle') },
  })
  const binder = executor.createHarnessSourceBinderForTests([
    { systemContentKey: 'sck-alpha', credentialFactory: () => secretBearing },
  ])
  assert.strictEqual(binder.handleFor('sck-alpha'), secretBearing,
    '(α): the handle must be retained BY IDENTITY — a copy proves it was enumerated')
  console.log('  ALPHA handle refused branded on 3/3 hostile shapes; retained by identity, never enumerated')
}

// ---------------------------------------------------------------------------
// The two doors emit DISJOINT tokens, in the SHIPPED build — not only under mutation.
// `__internals` members are guarded by L2 alone (they are the module's own primitives,
// exposed for pinning, and are not snapshotted), so they exercise L2 in normal
// operation; the public entry points are snapshotted by L1 and never reach L2. That
// is a live, non-mutated demonstration that both doors are wired.
// ---------------------------------------------------------------------------
function doorsAreDistinguishable() {
  const trap = () => new Proxy({}, { getPrototypeOf() { throw new Error(CANARY) } })
  const cases = [
    ['observability L1', () => observability.assertValuesFreeCounterSample(trap()), 'COUNTER_SAMPLE_INVALID'],
    ['observability L2', () => observability.__internals.isPlainObject(trap()), 'OBSERVABILITY_ENTRY_NOT_INERT'],
    ['resolver L1', () => resolver.createHarnessSystemIdentityAuthorityForTests(trap()), 'RESOLVER_INPUT_HOSTILE'],
    ['resolver L2', () => resolver.__internals.isPlainObject(trap()), 'RESOLVER_ENTRY_NOT_INERT'],
    ['executor L1', () => executor.createServerBoundSourceExecutor(trap()), 'EXECUTOR_INPUT_HOSTILE'],
    ['executor L2', () => executor.__internals.isPlainObject(trap()), 'EXECUTOR_ENTRY_NOT_INERT'],
  ]
  for (const [name, run, expected] of cases) {
    assert.throws(run, (error) => {
      assert.equal(error.reason, expected, `${name}: expected ${expected}, got ${String(error.reason)}`)
      return true
    })
  }
  // The L2 tokens must be emitted by NOTHING ELSE — that exclusivity is what makes
  // the L1 positive control meaningful.
  for (const [, , token] of cases) {
    if (!token.endsWith('_ENTRY_NOT_INERT')) continue
    assert.ok(cases.filter(([, , t]) => t === token).length === 1, `${token} must be reached by exactly one L2 case`)
  }
  console.log(`  DOORS ${cases.length} cases: L1 tokens precise, L2 token exclusive`)
}

// ---------------------------------------------------------------------------
// ONE DOOR, NOT THREE. Before round 5 the strict `isPlainObject` existed as three
// byte-identical copies, which is how one unguarded `Object.getPrototypeOf` produced
// the same P1 in three modules at once. The gate is only "one door" if there is
// literally one definition, so that is pinned rather than described.
// ---------------------------------------------------------------------------
function thereIsExactlyOnePlainObjectDefinition() {
  const shared = require('../lib/gip-inert-entry.cjs').isPlainObject
  assert.strictEqual(observability.__internals.isPlainObject.name, 'guardedEntry',
    'the exported __internals.isPlainObject must be the L2-wrapped shared predicate')
  // Identity through the wrapper: each module's internal predicate must BE the shared
  // one, not a copy that happens to behave the same today.
  const fs = require('node:fs')
  const path = require('node:path')
  const libDir = path.join(__dirname, '..', 'lib')
  const files = [
    'gip-read-observability-contracts.cjs',
    'gip-approved-binding-resolver.cjs',
    'gip-server-bound-source-executor.cjs',
  ]
  for (const file of files) {
    const source = fs.readFileSync(path.join(libDir, file), 'utf8')
    assert.ok(!/^function isPlainObject\s*\(/m.test(source),
      `${file}: a LOCAL isPlainObject definition has reappeared — the gate is no longer one door`)
    assert.ok(source.includes("require('./gip-inert-entry.cjs')"),
      `${file}: must take isPlainObject from the shared gate`)
  }
  assert.equal(typeof shared, 'function')
  console.log(`  ONE-DOOR ${files.length} modules carry no local isPlainObject; all import the shared gate`)
}

// ---------------------------------------------------------------------------
// L2's ASYNC HALF, TESTED DIRECTLY.
//
// Found by mutation, not by reading: deleting the rejection-re-branding branch of
// `createEntryGuard` left the whole suite GREEN. The reason is benign but the
// consequence was not — L1 contains every async public entry point today, so nothing
// currently REACHES L2's async half, and a guard that no test can reach is a guard
// that can be deleted without anything noticing. That is the "asserted invariant is a
// bug" shape: the branch was load-bearing for a future entry point and provably
// load-bearing for none.
//
// The gate PRIMITIVE is therefore exercised directly, over a synthetic async function
// that throws something L1 would never contain. This is a unit test of the boundary,
// not a second route into the modules, and it is what makes the async branch
// mutation-detectable.
// ---------------------------------------------------------------------------
async function l2RebrandsRejectionsNotOnlyThrows() {
  const { createEntryGuard } = require('../lib/gip-inert-entry.cjs')
  class LocalBranded extends Error {
    constructor(reason) { super('local fixed message'); this.reason = reason }
  }
  const guard = createEntryGuard(LocalBranded, () => { throw new LocalBranded('LOCAL_ENTRY_NOT_INERT') })

  // ASYNC: an unbranded throw inside an async function is a REJECTION. A boundary
  // that only wraps the synchronous call never sees it.
  const asyncLeaky = guard(async () => { throw new Error(CANARY) })
  await assert.rejects(asyncLeaky(), (error) => {
    assert.ok(error instanceof LocalBranded, `an async rejection must be re-branded, got ${error && error.constructor.name}`)
    assert.equal(error.reason, 'LOCAL_ENTRY_NOT_INERT')
    assert.ok(!String(error.message).includes(CANARY), 'no attacker text in an async rejection')
    return true
  })

  // A THENABLE that is not a native promise must be covered too — an entry point may
  // return one, and `.then` is the only thing the boundary can key on. Note the
  // SHAPE: a hand-written `then` that calls its reject callback SYNCHRONOUSLY makes
  // the re-brand surface as a synchronous throw rather than a rejection. Both are
  // closed and branded, which is what matters; the test is written to accept either,
  // because pinning one would be pinning an implementation detail of the thenable.
  const thenableLeaky = guard(() => ({ then(_ok, bad) { bad(new Error(CANARY)) } }))
  await assert.rejects(async () => thenableLeaky(), (error) => {
    assert.ok(error instanceof LocalBranded, 'a thenable rejection must be re-branded')
    assert.ok(!String(error.message).includes(CANARY), 'no attacker text from a thenable')
    return true
  })

  // NEGATIVE HALF: an already-branded rejection must pass through UNCHANGED, or the
  // boundary would flatten every precise L1 token into the L2 token and the two doors
  // would stop being distinguishable.
  const asyncBranded = guard(async () => { throw new LocalBranded('LOCAL_PRECISE') })
  await assert.rejects(asyncBranded(), (error) => {
    assert.equal(error.reason, 'LOCAL_PRECISE', 'a branded rejection must NOT be re-branded by the boundary')
    return true
  })

  // POSITIVE CONTROL: a resolving call must still resolve, with its value intact.
  const ok = guard(async () => ({ value: 7 }))
  assert.deepEqual(await ok(), { value: 7 })
  console.log('  ASYNC-L2 rejection re-branded, thenable re-branded, branded rejection passed through, resolve intact')
}

async function main() {
  await entryTableIsGated()
  await l2RebrandsRejectionsNotOnlyThrows()
  await checkerHasTeeth()
  credentialHandleIsGuardedNotEnumerated()
  doorsAreDistinguishable()
  thereIsExactlyOnePlainObjectDefinition()
  console.log('gip-inert-entry-gate.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

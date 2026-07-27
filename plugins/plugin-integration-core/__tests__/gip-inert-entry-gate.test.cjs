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

const gate = require('../lib/gip-inert-entry.cjs')
const observability = require('../lib/gip-read-observability-contracts.cjs')
const resolver = require('../lib/gip-approved-binding-resolver.cjs')
const executor = require('../lib/gip-server-bound-source-executor.cjs')

// ---------------------------------------------------------------------------
// A FIRST-PARTY MODULE FIXTURE, wired to the gate EXACTLY as the three real modules
// wire it: a frozen reason vocabulary, one fixed message per reason, a module-private
// brand whose sole writer is `fail`, and a re-minter that keeps an in-vocabulary
// reason and collapses everything else to the boundary token.
//
// It exists because the property under test — "nothing the boundary emits carries a
// reason outside the vocabulary" — is a property OF THE GUARD, and the guard is a
// shared primitive three modules instantiate. Testing it through one of those modules
// would test that module's particular reachability, which is not what the primitive
// promises.
// ---------------------------------------------------------------------------
const LOCAL_REASONS = Object.freeze(['LOCAL_PRECISE', 'LOCAL_ENTRY_NOT_INERT'])
const LOCAL_REASON_SET = new Set(LOCAL_REASONS)
const LOCAL_MESSAGES = Object.freeze({
  LOCAL_PRECISE: 'local fixed message',
  LOCAL_ENTRY_NOT_INERT: 'local fixed message',
})
const LOCAL_UNDECLARED_MESSAGE = 'local fixture internal: undeclared error reason'

function buildLocalModuleFixture() {
  class LocalBranded extends Error {
    constructor(reason) {
      const known = typeof reason === 'string' && LOCAL_REASON_SET.has(reason)
      super(known ? LOCAL_MESSAGES[reason] : LOCAL_UNDECLARED_MESSAGE)
      this.name = 'LocalBranded'
      this.reason = known ? reason : 'LOCAL_ENTRY_NOT_INERT'
    }
  }
  const { brandError: brandLocal, isBrandedError: isBrandedLocal } = gate.createErrorBrand()
  const failLocal = (reason) => { throw brandLocal(new LocalBranded(reason)) }
  const remintLocal = (caught) => {
    let reason
    try {
      reason = caught.reason
    } catch (_error) {
      reason = undefined
    }
    failLocal(typeof reason === 'string' && LOCAL_REASON_SET.has(reason) ? reason : 'LOCAL_ENTRY_NOT_INERT')
  }
  const guard = gate.createEntryGuard(isBrandedLocal, () => failLocal('LOCAL_ENTRY_NOT_INERT'), remintLocal)
  return { LocalBranded, brandLocal, isBrandedLocal, failLocal, remintLocal, guard }
}

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

// ROUND 6, P2-C — A LEAK CHECK MUST DISTINGUISH "CHECKED AND CLEAN" FROM "THE CHECK
// FAILED", and the latter must never be reported as clean. Serialization runs
// caller-owned code (`toJSON`, `toString`, `valueOf`, `Symbol.toPrimitive`,
// `ownKeys`), so it is itself attackable; swallowing its throw to `''` produced a
// FALSE GREEN that a hostile value could reach on purpose. Tri-state, and the
// caller decides — no caller of this helper may treat `check-failed` as clean.
function renderForLeakCheck(value) {
  let json
  try {
    json = JSON.stringify(value)
  } catch (error) {
    return { state: 'check-failed', detail: `JSON.stringify threw: ${describeSafely(error)}` }
  }
  let text
  try {
    text = json === undefined ? String(value) : json
  } catch (error) {
    return { state: 'check-failed', detail: `String() threw: ${describeSafely(error)}` }
  }
  return { state: text.includes(CANARY) ? 'dirty' : 'clean', detail: text }
}

// Reading `.constructor.name`/`.message` off a hostile value is itself trappable, so
// even the FAILURE-REPORTING path must not be the thing that throws.
function describeSafely(value) {
  try {
    if (value === null || value === undefined) return String(value)
    const ctor = value.constructor
    const name = ctor && ctor.name
    return typeof name === 'string' ? name : typeof value
  } catch (_error) {
    return 'unreadable'
  }
}

async function auditExportTable(spec) {
  const { label, table, BrandedError, isBranded, vocabulary } = spec
  assert.equal(typeof isBranded, 'function',
    `${label}: the matrix must judge brandedness with the module's UNFORGEABLE checker`)
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
          // ROUND 6, P1-A — THE CRITERION ITSELF WAS THE WEAK LINK. This read
          // `thrown instanceof BrandedError` until round 6, and `instanceof` is not a
          // brand: `Object.create(BrandedError.prototype)` satisfies it while carrying
          // attacker text, `.name` is an ordinary writable property so any name-based
          // criterion is satisfied by a plain `Error`, and a `Symbol.hasInstance`
          // hijack makes the EXPRESSION ITSELF throw — which, inside this loop, would
          // have crashed the audit rather than recorded a violation. The module's
          // `isBranded*` checker reads module-private WeakSet membership: it invokes
          // no caller code, cannot be made to throw, and cannot be conferred from
          // outside. `forgedBrandsAreRefused()` below drives all three forgeries.
          if (!isBranded(thrown)) {
            violations.push(`${cell}: escaped UNBRANDED as ${describeSafely(thrown)}`)
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
        // ROUND 6, P2-C — "CHECKED AND CLEAN" IS NOT "THE CHECK FAILED". This used
        // to swallow a throwing serialization to `''` and then judge `''` as "no
        // leak": a return value that could not be rendered — `toJSON`/`toString`/
        // `Symbol.toPrimitive` all belong to the caller — silently PASSED. Every leak
        // check in this file is now TRI-STATE, and `check-failed` is a VIOLATION.
        const verdict = renderForLeakCheck(returned)
        if (verdict.state === 'check-failed') {
          violations.push(`${cell}: the RETURN-value leak check itself failed (${verdict.detail}) — not judged clean`)
        } else if (verdict.state === 'dirty') {
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
    isBranded: observability.isBrandedReadObservabilityContractError,
    vocabulary: observability.OBSERVABILITY_CONTRACT_ERROR_REASONS,
    // Reaches a refusal through a PUBLIC export, so the error it throws is one the
    // module actually minted — the genuine half of the forgery control.
    mintGenuine: () => observability.assertValuesFreeCounterSample(null),
  },
  {
    label: 'resolver',
    table: resolver,
    BrandedError: resolver.GipApprovedBindingResolverError,
    isBranded: resolver.isBrandedApprovedBindingResolverError,
    vocabulary: resolver.BINDING_RESOLVER_ERROR_REASONS,
    mintGenuine: () => resolver.createApprovedBindingResolver(null),
  },
  {
    label: 'executor',
    table: executor,
    BrandedError: executor.GipSourceExecutorError,
    isBranded: executor.isBrandedSourceExecutorError,
    vocabulary: executor.SOURCE_EXECUTOR_ERROR_REASONS,
    mintGenuine: () => executor.createServerBoundSourceExecutor(null),
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
  const { brandError: brandSynthetic, isBrandedError: isBrandedSynthetic } = gate.createErrorBrand()
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
      if (!value || typeof value !== 'object') throw brandSynthetic(new SyntheticError('SYNTHETIC_REFUSED'))
      throw brandSynthetic(new SyntheticError('SYNTHETIC_REFUSED'))
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
    isBranded: isBrandedSynthetic,
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
        assert.ok(executor.isBrandedSourceExecutorError(error), 'a hostile handle must be refused BRANDED (unforgeable checker, not instanceof)')
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
  // ROUND 6: the boundary is parameterised by the UNFORGEABLE brand predicate, not by
  // the error CLASS. `brandLocal` is the only writer, exactly as in the real modules.
  const { isBrandedLocal, failLocal, guard } = buildLocalModuleFixture()

  // ASYNC: an unbranded throw inside an async function is a REJECTION. A boundary
  // that only wraps the synchronous call never sees it.
  const asyncLeaky = guard(async () => { throw new Error(CANARY) })
  await assert.rejects(asyncLeaky(), (error) => {
    assert.ok(isBrandedLocal(error), `an async rejection must be re-branded, got ${error && error.constructor.name}`)
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
    assert.ok(isBrandedLocal(error), 'a thenable rejection must be re-branded')
    assert.ok(!String(error.message).includes(CANARY), 'no attacker text from a thenable')
    return true
  })

  // NEGATIVE HALF: an already-branded rejection must pass through UNCHANGED, or the
  // boundary would flatten every precise L1 token into the L2 token and the two doors
  // would stop being distinguishable.
  const asyncBranded = guard(async () => { failLocal('LOCAL_PRECISE') })
  await assert.rejects(asyncBranded(), (error) => {
    assert.equal(error.reason, 'LOCAL_PRECISE', 'a branded rejection must NOT be re-branded by the boundary')
    return true
  })

  // POSITIVE CONTROL: a resolving call must still resolve, with its value intact.
  const ok = guard(async () => ({ value: 7 }))
  assert.deepEqual(await ok(), { value: 7 })
  console.log('  ASYNC-L2 rejection re-branded, thenable re-branded, branded rejection passed through, resolve intact')
}

// ---------------------------------------------------------------------------
// IN-CODE LINE CITATIONS ARE RE-DERIVED, NOT HAND-PATCHED.
//
// The executor header cites its own line numbers to name the second public factory
// whose products are trusted. Those citations have gone stale in THREE consecutive
// rounds, because every edit above them shifts them and the fix each time was to
// hand-patch the numbers — which is a fix that expires the moment anyone edits the
// file again. Pinning them mechanically converts a recurring review finding into a
// RED, and it is the same "the ledger is the code, so audit the code" posture the
// module already claims for its comments.
// ---------------------------------------------------------------------------
function inCodeLineCitationsAreAccurate() {
  const fs = require('node:fs')
  const path = require('node:path')
  const file = path.join(__dirname, '..', 'lib', 'gip-server-bound-source-executor.cjs')
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const lineOf = (re, what) => {
    const index = lines.findIndex((line) => re.test(line))
    assert.ok(index >= 0, `could not locate ${what} — the citation pin is looking for something that no longer exists`)
    return index + 1
  }
  const actual = {
    factory: lineOf(/^function createHarnessSourceBinderForTests/, 'the harness binder factory'),
    weakSet: lineOf(/^const trustedSourceBinders = new WeakSet/, 'the trustedSourceBinders WeakSet'),
    write: lineOf(/trustedSourceBinders\.add\(binder\)/, 'the WeakSet write'),
    exported: lineOf(/^ {2}createHarnessSourceBinderForTests,/, 'the export entry'),
  }
  const cited = lines.find((line) => line.includes('is the SOLE writer into'))
  assert.ok(cited, 'the header citation sentence has gone missing')
  const citedNext = lines[lines.indexOf(cited) + 1]
  const claim = `${cited}\n${citedNext}`
  for (const [name, value] of Object.entries(actual)) {
    assert.ok(claim.includes(`:${value}`),
      `stale in-code citation: ${name} is at line ${value}, which the header does not cite. Header says:\n${claim}`)
  }
  console.log(`  CITATIONS re-derived: factory=:${actual.factory} weakSet=:${actual.weakSet} write=:${actual.write} export=:${actual.exported}`)
}

// ---------------------------------------------------------------------------
// ROUND 6, P1-A — THE BRAND CANNOT BE FORGED, AND THE OLD CRITERION COULD BE.
//
// This test asserts a NEGATIVE ("a forged error is not passed through"), so it also
// carries its own POSITIVE CONTROL: for every construction it first asserts that the
// RETIRED criterion (`instanceof` / `.name`) WOULD have accepted it. Without that
// half, a forgery the runtime happens to reject for an unrelated reason would look
// like proof of the brand.
//
// The three constructions are the ones the owner reproduced at the round-5 head:
//   (1) `Object.create(BrandedError.prototype)` — `instanceof` TRUE, attacker text.
//   (2) a plain `Error` with `.name` assigned the branded class name — satisfies any
//       `.name`-based criterion, including the one behind the RETRACTED 0/12 matrix.
//   (3) `Symbol.hasInstance` — the `instanceof` EXPRESSION ITSELF throws, out of the
//       `catch` block, carrying the attacker's text.
// ---------------------------------------------------------------------------
function forgedBrandsAreRefused() {
  const { createEntryGuard, createErrorBrand } = gate
  let checked = 0

  for (const spec of MODULES) {
    const { label, BrandedError, isBranded } = spec

    // (1) PROTOTYPE FORGERY.
    const prototypeForged = Object.create(BrandedError.prototype)
    prototypeForged.message = CANARY
    prototypeForged.stack = CANARY
    prototypeForged.reason = CANARY
    assert.ok(prototypeForged instanceof BrandedError,
      `${label}: control — the RETIRED instanceof criterion must accept the prototype forgery`)
    assert.equal(isBranded(prototypeForged), false,
      `${label}: a prototype forgery must NOT be branded`)

    // (2) NAME SPOOF. `.name` is an ordinary writable property.
    const nameForged = new Error(CANARY)
    nameForged.name = BrandedError.name
    assert.notEqual(nameForged.name, 'Error',
      `${label}: control — the RETIRED name-based criterion must accept the name spoof`)
    assert.equal(isBranded(nameForged), false, `${label}: a name spoof must NOT be branded`)

    // (3) A REAL branded error IS branded. Without this the predicate could be a
    // constant `false` and every assertion above would still pass.
    let genuine = null
    try {
      // Every module's error table maps its own undeclared-reason fallback; reaching
      // a refusal through a public export is what mints a genuinely branded error.
      spec.mintGenuine()
    } catch (error) {
      genuine = error
    }
    assert.ok(genuine, `${label}: the genuine-brand control must have thrown`)
    assert.equal(isBranded(genuine), true, `${label}: a genuinely minted error MUST be branded`)
    // And a DIRECTLY constructed instance is deliberately NOT branded — it is not
    // something the module minted, so the boundary must not exempt it.
    assert.equal(isBranded(new BrandedError('__NOT_A_DECLARED_REASON__')), false,
      `${label}: a directly constructed error must not carry the mint brand`)
    checked += 4
  }

  // NOW DRIVE ALL THREE THROUGH THE BOUNDARY ITSELF. The matrix above judges what a
  // module threw; this judges what the BOUNDARY does when a foreign callback throws a
  // forgery at it.
  const { LocalBranded, isBrandedLocal, guard } = buildLocalModuleFixture()

  const forgeries = {
    prototypeForged: () => {
      const forged = Object.create(LocalBranded.prototype)
      forged.message = CANARY
      forged.stack = CANARY
      return forged
    },
    nameSpoofed: () => {
      const forged = new Error(CANARY)
      forged.name = 'LocalBranded'
      return forged
    },
    hasInstanceHijack: () => {
      // The hijack is on the CLASS the old boundary tested against, so the throw
      // happened at the `instanceof` expression inside the `catch`.
      class Hostile extends Error {
        static [Symbol.hasInstance]() { throw new Error(CANARY) }
      }
      return new Hostile(CANARY)
    },
  }
  for (const [name, make] of Object.entries(forgeries)) {
    const wrapped = guard(function entry() { throw make() })
    let caught = null
    try { wrapped() } catch (error) { caught = error }
    assert.ok(caught, `${name}: the boundary must refuse`)
    assert.equal(isBrandedLocal(caught), true, `${name}: what the boundary threw must be its OWN branded error`)
    assert.equal(caught.reason, 'LOCAL_ENTRY_NOT_INERT',
      `${name}: a forgery must be replaced by the boundary token, not passed through`)
    const verdict = renderForLeakCheck({ message: caught.message, stack: caught.stack })
    assert.equal(verdict.state, 'clean', `${name}: attacker text escaped the boundary (${verdict.detail})`)
    checked += 3
  }

  // The `Symbol.hasInstance` construction is also an ASYNC case: the old boundary ran
  // the same expression in its rejection handler.
  console.log(`  FORGERY ${checked} assertions: prototype / name-spoof / Symbol.hasInstance all refused, genuine brand accepted`)
}

// ---------------------------------------------------------------------------
// ROUND 6, P1-B — THE THENABLE BOUNDARY.
//
// `.then` is READ and CALLED by every promise resolution path, and both used to
// happen OUTSIDE the guarded region: `typeof result.then` fired a hostile getter and
// the throw escaped raw (EXECUTED). A snapshot also carried the caller's `then` BY
// IDENTITY, so any `await` of a snapshot handed the caller a callback.
// ---------------------------------------------------------------------------
async function thenableBoundaryIsClosed() {
  const { inertRecord, inertRecordList, GipNonPlainValue } = gate
  const { LocalBranded, brandLocal, isBrandedLocal, guard } = buildLocalModuleFixture()

  // 1. THE `then` GETTER THROWS — outside the old guarded region.
  const getterEntry = guard(() => ({ get then() { throw new Error(CANARY) } }))
  let caught = null
  try { await getterEntry() } catch (error) { caught = error }
  assert.ok(caught && isBrandedLocal(caught), 'a throwing `then` getter must be contained and re-branded')
  assert.equal(caught.reason, 'LOCAL_ENTRY_NOT_INERT')
  assert.equal(renderForLeakCheck({ m: caught.message, s: caught.stack }).state, 'clean',
    'attacker text escaped from a throwing `then` getter')

  // 2. THE `then` CALL THROWS.
  const callEntry = guard(() => ({ then() { throw new Error(CANARY) } }))
  caught = null
  try { await callEntry() } catch (error) { caught = error }
  assert.ok(caught && isBrandedLocal(caught), 'a throwing `then` CALL must be contained and re-branded')
  assert.equal(renderForLeakCheck({ m: caught.message, s: caught.stack }).state, 'clean',
    'attacker text escaped from a throwing `then` call')

  // 3. THE `then` GETTER IS READ EXACTLY ONCE. Reading it again for the call would
  // reopen a differing-return channel: answer "not a thenable" to the test, a hostile
  // callable to the use.
  let reads = 0
  const countingEntry = guard(() => ({
    get then() { reads += 1; return (resolve) => resolve('ok') },
  }))
  assert.equal(await countingEntry(), 'ok')
  assert.equal(reads, 1, `the boundary must read \`then\` ONCE; it read it ${reads} times`)

  // 4. A SNAPSHOT MUST NOT CARRY A CALLABLE `then`.
  const snapshot = inertRecord({ then(_ok, bad) { bad(new Error(CANARY)) }, value: 1 }, () => {
    throw new Error('unexpected L1 failure')
  })
  assert.notEqual(typeof snapshot.then, 'function', 'the snapshot still carries a CALLABLE then')
  assert.ok(snapshot.then instanceof GipNonPlainValue, 'the neutralised `then` must be the declared stand-in')
  // THE REFUSAL IS PRESERVED: the key is still PRESENT, so every closed-key-set pin
  // downstream still refuses the record exactly as it did before neutralisation.
  assert.ok(Object.keys(snapshot).includes('then'), 'neutralising must not DROP the key — that would widen every closed key set')
  // Awaiting the snapshot must not run the caller's code.
  const awaited = await snapshot
  assert.equal(awaited, snapshot, 'awaiting an inert snapshot must not adopt it as a thenable')

  // 5. Same, one level down, through the LIST entry point.
  const listSnapshot = inertRecordList([{ then() { throw new Error(CANARY) } }], () => {
    throw new Error('unexpected L1 failure')
  })
  assert.notEqual(typeof listSnapshot[0].then, 'function', 'a list-member snapshot still carries a CALLABLE then')

  // 6. POSITIVE CONTROL — a genuine async entry point still resolves with its value,
  // and a branded rejection still passes through unchanged.
  assert.deepEqual(await guard(async () => ({ ok: 1 }))(), { ok: 1 })
  caught = null
  try { await guard(async () => { throw brandLocal(new LocalBranded('LOCAL_PRECISE')) })() } catch (e) { caught = e }
  assert.equal(caught.reason, 'LOCAL_PRECISE', 'a branded rejection must not be flattened into the boundary token')
  console.log('  THENABLE getter-throw, call-throw, read-once, snapshot-neutralised (both levels), positive controls intact')
}

// ---------------------------------------------------------------------------
// ROUND 7 — A BRANDED ERROR MUST NEVER CARRY AN OUT-OF-VOCABULARY `reason`.
//
// -- THE DEFECT, STATED WITHOUT AN ADVERSARY --------------------------------
// Both boundary catch sites did `if (isBrandedError(error)) throw error`. The brand is
// unforgeable, so the caught object really was minted by the wrapping module — but the
// brand attests WHO MINTED IT, never WHAT IT CURRENTLY SAYS: `reason`, `message` and
// `stack` are ordinary writable own properties on an ordinary `Error`. Every one of
// the three modules states in its own header that a branded error carries a reason
// from a FROZEN vocabulary. The boundary did not enforce that; it inherited it from
// two facts about code outside itself — every branded error happens to be minted by
// `fail()`, and nothing mutates one in flight. Neither is a property the guard holds.
//
// This is a CLOSED-SET INVARIANT VIOLATION, and it is why the fix survives the
// 2026-07-26 in-process-caller ruling: it needs no attacker. Any first-party holder
// that annotates a branded error before it re-enters a guarded frame, and any future
// `brandError` call that does not go through `fail`, breaks the closed set silently.
// Honest scope: at THIS head no in-repo path performs that mutation — every foreign
// call in the three modules is already inside an unconditional-discard try/catch — so
// what is fixed is that the boundary now ENFORCES the invariant it states instead of
// inheriting it. The attacker-text half is a disclosed residual, not the justification.
//
// -- WHY OBJECT IDENTITY IS THE ASSERTION THAT DISCRIMINATES -----------------
// Asserting only that the escaping reason is in the vocabulary passes on a VERBATIM
// rethrow whenever the planted reason happens to be in-vocabulary. Identity does not:
// a re-mint is a different object, a rethrow is the same one. `notStrictEqual` is
// therefore the load-bearing line here, and the vocabulary/message checks sit on top.
//
// -- THE CRITERION IS THE WeakSet, NOT `.name`, NOT `instanceof` -------------
// `.name` is attacker-writable and `instanceof` is satisfied by
// `Object.create(prototype)` — an earlier headline result in this PR was invalidated
// for exactly that reason. Every brand judgement below goes through the fixture's own
// `isBrandedLocal`, which reads a module-private WeakSet.
//
// -- SITE 1 of 2: THE SYNCHRONOUS HALF --------------------------------------
// Neutering the async site alone leaves this GREEN, and vice versa; both mutations are
// in the PR body. A single test covering both would let one door cover for the other.
// ---------------------------------------------------------------------------
function brandedErrorsAreRemintedAtTheSynchronousSite() {
  const { isBrandedLocal, brandLocal, LocalBranded, guard } = buildLocalModuleFixture()

  // A GENUINELY branded error — minted by the fixture's own private writer, exactly as
  // every refusal in the three real modules mints one — whose `reason` is then assigned
  // a token outside the frozen vocabulary. Assignment, not construction: the class
  // already collapses an undeclared reason, so constructing one would test the class
  // rather than the boundary.
  const planted = brandLocal(new LocalBranded('LOCAL_PRECISE'))
  planted.reason = 'FORGED_REASON_NOT_IN_VOCABULARY'
  planted.message = CANARY
  assert.equal(isBrandedLocal(planted), true, 'the planted error must really carry the mint brand')

  const wrapped = guard(function syncEntry() { throw planted })
  let caught = null
  try { wrapped() } catch (error) { caught = error }

  assert.ok(caught, 'the synchronous boundary must refuse')
  assert.notStrictEqual(caught, planted,
    'the synchronous boundary RE-THREW the caught object verbatim — a re-mint is a DIFFERENT object')
  assert.equal(isBrandedLocal(caught), true, 'what the boundary throws must carry its own mint brand')
  assert.ok(LOCAL_REASON_SET.has(caught.reason),
    `an out-of-vocabulary reason escaped the synchronous boundary: ${String(caught.reason)}`)
  assert.equal(caught.reason, 'LOCAL_ENTRY_NOT_INERT',
    'an undeclared reason must collapse to the boundary token, not to an L1 token')
  assert.equal(caught.message, LOCAL_MESSAGES.LOCAL_ENTRY_NOT_INERT,
    'the re-minted message must come from the frozen per-reason table')
  // Side effect, stated honestly: discarding the caught object also drops the text it
  // carried. Under the ruling that is NOT the justification for this fix — the
  // vocabulary invariant is — but a check that would have caught the leak is cheap.
  assert.equal(renderForLeakCheck({ m: caught.message, s: caught.stack }).state, 'clean',
    'the re-minted error must not carry the discarded object\'s text')

  // THE OTHER DIRECTION, AND IT IS LOAD-BEARING, NOT A COURTESY. If the re-mint
  // collapsed EVERY reason to the boundary token, every L1 refusal in all three modules
  // would surface as `*_ENTRY_NOT_INERT` and the two doors would stop having exclusive
  // failures — which is the property the whole L1/L2 argument rests on. An
  // IN-vocabulary reason must survive, on a FRESH object.
  const preciseSource = brandLocal(new LocalBranded('LOCAL_PRECISE'))
  const precise = guard(function syncPrecise() { throw preciseSource })
  caught = null
  try { precise() } catch (error) { caught = error }
  assert.equal(caught.reason, 'LOCAL_PRECISE', 'an in-vocabulary reason must be PRESERVED across the re-mint')
  assert.notStrictEqual(caught, preciseSource, 'preservation must still be a re-mint, not a pass-through')

  // A `reason` ACCESSOR THAT THROWS. A branded object can have one installed after it
  // was minted, and the re-minter reads `reason` — an unguarded read there would throw
  // out of the catch block and escape the boundary entirely.
  const accessorSource = brandLocal(new LocalBranded('LOCAL_PRECISE'))
  Object.defineProperty(accessorSource, 'reason', { get() { throw new Error(CANARY) }, configurable: true })
  const accessor = guard(function syncAccessor() { throw accessorSource })
  caught = null
  try { accessor() } catch (error) { caught = error }
  assert.equal(isBrandedLocal(caught), true, 'a throwing `reason` accessor must not escape the boundary')
  assert.equal(caught.reason, 'LOCAL_ENTRY_NOT_INERT', 'an unreadable reason is not an in-vocabulary reason')
  assert.equal(renderForLeakCheck({ m: caught.message, s: caught.stack }).state, 'clean',
    'a throwing `reason` accessor must not leak its text')

  console.log('  REMINT-SYNC out-of-vocabulary collapsed, in-vocabulary preserved, throwing accessor contained, all fresh objects')
}

// ---------------------------------------------------------------------------
// SITE 2 of 2: THE ASYNCHRONOUS HALF. A synchronous try/catch never sees a rejection,
// so this site is reached by inputs site 1 cannot see, and is neutered independently.
// ---------------------------------------------------------------------------
async function brandedErrorsAreRemintedAtTheAsynchronousSite() {
  const { isBrandedLocal, brandLocal, LocalBranded, guard } = buildLocalModuleFixture()

  const planted = brandLocal(new LocalBranded('LOCAL_PRECISE'))
  planted.reason = 'FORGED_REASON_NOT_IN_VOCABULARY'
  planted.message = CANARY
  assert.equal(isBrandedLocal(planted), true, 'the planted error must really carry the mint brand')

  const wrapped = guard(async function asyncEntry() { throw planted })
  let caught = null
  try { await wrapped() } catch (error) { caught = error }

  assert.ok(caught, 'the asynchronous boundary must reject')
  assert.notStrictEqual(caught, planted,
    'the rejection handler RE-THREW the caught object verbatim — a re-mint is a DIFFERENT object')
  assert.equal(isBrandedLocal(caught), true, 'what the rejection handler throws must carry its own mint brand')
  assert.ok(LOCAL_REASON_SET.has(caught.reason),
    `an out-of-vocabulary reason escaped the asynchronous boundary: ${String(caught.reason)}`)
  assert.equal(caught.reason, 'LOCAL_ENTRY_NOT_INERT', 'an undeclared reason must collapse to the boundary token')
  assert.equal(caught.message, LOCAL_MESSAGES.LOCAL_ENTRY_NOT_INERT,
    'the re-minted message must come from the frozen per-reason table')
  assert.equal(renderForLeakCheck({ m: caught.message, s: caught.stack }).state, 'clean',
    'the re-minted rejection must not carry the discarded object\'s text')

  // A FOREIGN THENABLE that rejects with the same planted object reaches the identical
  // handler by a different route — the adoption path, not `async`.
  const thenablePlanted = brandLocal(new LocalBranded('LOCAL_PRECISE'))
  thenablePlanted.reason = 'FORGED_REASON_NOT_IN_VOCABULARY'
  const thenable = guard(() => ({ then(_ok, bad) { bad(thenablePlanted) } }))
  caught = null
  try { await thenable() } catch (error) { caught = error }
  assert.notStrictEqual(caught, thenablePlanted, 'a thenable rejection must be re-minted, not passed through')
  assert.equal(caught.reason, 'LOCAL_ENTRY_NOT_INERT', 'an undeclared reason from a thenable must collapse')

  // The preservation half again, on the async site.
  const preciseSource = brandLocal(new LocalBranded('LOCAL_PRECISE'))
  caught = null
  try { await guard(async function asyncPrecise() { throw preciseSource })() } catch (error) { caught = error }
  assert.equal(caught.reason, 'LOCAL_PRECISE', 'an in-vocabulary reason must be PRESERVED across the async re-mint')
  assert.notStrictEqual(caught, preciseSource, 'preservation must still be a re-mint, not a pass-through')

  console.log('  REMINT-ASYNC rejection + foreign-thenable collapsed, in-vocabulary preserved, all fresh objects')
}

// ---------------------------------------------------------------------------
// BOTH SITES ARE REPORTED SEPARATELY IN EVERY RUN — that is what makes them
// separately load-bearing rather than jointly load-bearing.
//
// A suite that aborts at the first failed assertion cannot show exclusivity: neuter
// the synchronous site and the run stops before the asynchronous cell has executed, so
// "the async cell was unaffected" would be an argument rather than an observation, and
// two fail-closed doors that only ever fail together are the exact shape this package's
// own review history keeps rejecting. So both cells run, both outcomes print, and the
// failures are raised TOGETHER at the end. One mutation, one run, both facts visible.
// ---------------------------------------------------------------------------
async function bothRemintSitesReportSeparately() {
  const cells = [
    ['SYNC-SITE', () => brandedErrorsAreRemintedAtTheSynchronousSite()],
    ['ASYNC-SITE', () => brandedErrorsAreRemintedAtTheAsynchronousSite()],
  ]
  const failures = []
  for (const [label, run] of cells) {
    try {
      await run()
      console.log(`  REMINT-EXCLUSIVITY ${label}: PASS`)
    } catch (error) {
      console.log(`  REMINT-EXCLUSIVITY ${label}: FAIL — ${error && error.message}`)
      failures.push(`${label}: ${error && error.message}`)
    }
  }
  assert.deepEqual(failures, [],
    `the re-mint cells failed:\n  ${failures.join('\n  ')}`)
}

// ---------------------------------------------------------------------------
// THE MINTER IS A WIRING REQUIREMENT, NEVER A FALLBACK.
//
// A guard constructed without a re-minter must fail AT CONSTRUCTION rather than
// degrading to the verbatim rethrow this replaces — "a wiring bug, never a fallback".
// That construction check is also what proves the three REAL modules are wired to the
// re-minting guard: each of them calls `createEntryGuard` at module load, so a module
// that passed only two arguments could not have been `require`d at the top of this
// file at all. Mutating any one of the three to drop its third argument REDs the whole
// suite at load; that is recorded in the PR body.
// ---------------------------------------------------------------------------
function theGuardCannotBeWiredWithoutAMinter() {
  const { createEntryGuard, createErrorBrand } = gate
  const { isBrandedError } = createErrorBrand()
  const noop = () => {}
  for (const [name, args] of Object.entries({
    noMinter: [isBrandedError, noop],
    minterNotAFunction: [isBrandedError, noop, {}],
    noFailNotInert: [isBrandedError],
    nothing: [],
  })) {
    assert.throws(() => createEntryGuard(...args), TypeError,
      `${name}: an incompletely wired guard must fail closed at construction`)
  }
  // POSITIVE CONTROL: the complete wiring constructs.
  assert.equal(typeof createEntryGuard(isBrandedError, noop, noop), 'function')

  // AND THE THREE REAL MODULES ARE WIRED — they are at the top of this file, and each
  // calls `createEntryGuard` at module load, so their presence here is the proof.
  for (const [name, mod] of Object.entries({ observability, resolver, executor })) {
    assert.ok(mod && typeof mod === 'object', `${name} must have loaded`)
  }
  console.log('  MINTER-WIRING 4 incomplete wirings refused at construction; observability/resolver/executor all loaded')
}

// ---------------------------------------------------------------------------
// ROUND 6, P2-C — THE LEAK CHECK ITSELF MUST FAIL CLOSED.
//
// A serialization that throws and is swallowed to `''` is then judged "no leak". That
// is a check reporting SUCCESS because it did not run. Serialization runs caller-owned
// code, so a hostile value can reach that branch ON PURPOSE.
// ---------------------------------------------------------------------------
function leakCheckFailsClosedWhenTheCheckFails() {
  assert.equal(renderForLeakCheck({ ok: 1 }).state, 'clean')
  assert.equal(renderForLeakCheck({ leaked: CANARY }).state, 'dirty')

  // The three ways a caller makes the CHECK itself throw.
  const throwingToJson = { toJSON() { throw new Error(CANARY) } }
  const circularWithHostileToString = (() => {
    const target = { toString() { throw new Error(CANARY) } }
    target.self = target
    return target
  })()
  const throwingOwnKeys = new Proxy({}, { ownKeys() { throw new Error(CANARY) } })

  for (const [name, value] of Object.entries({ throwingToJson, circularWithHostileToString, throwingOwnKeys })) {
    const verdict = renderForLeakCheck(value)
    assert.equal(verdict.state, 'check-failed',
      `${name}: a check that could not run must report check-failed, never clean (got ${verdict.state})`)
    assert.notEqual(verdict.state, 'clean', `${name}: FALSE GREEN — the swallowed check was judged clean`)
  }

  // The check-failed verdict must not itself carry attacker text onward.
  assert.ok(!String(renderForLeakCheck(throwingToJson).detail).includes(CANARY),
    'the check-failed detail must not echo the attacker text it was checking for')
  console.log('  LEAK-CHECK tri-state: clean / dirty / check-failed, and check-failed is never clean')
}

async function main() {
  await entryTableIsGated()
  await l2RebrandsRejectionsNotOnlyThrows()
  forgedBrandsAreRefused()
  await thenableBoundaryIsClosed()
  await bothRemintSitesReportSeparately()
  theGuardCannotBeWiredWithoutAMinter()
  leakCheckFailsClosedWhenTheCheckFails()
  await checkerHasTeeth()
  credentialHandleIsGuardedNotEnumerated()
  doorsAreDistinguishable()
  thereIsExactlyOnePlainObjectDefinition()
  inCodeLineCitationsAreAccurate()
  console.log('gip-inert-entry-gate.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

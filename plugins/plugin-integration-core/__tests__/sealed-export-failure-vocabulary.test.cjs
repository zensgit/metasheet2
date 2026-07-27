'use strict'

// Sealed-export S1 — closed failure vocabulary battery. Plain node test, hermetic.
//
// §10 of the ratified S0 baseline requires three pins, and this file carries all
// three:
//   1. an exact vocabulary pin              -> vocabularyExactPin()
//   2. a runtime consumer pin               -> latentSurfacePin() + zeroConsumerSweep()
//   3. a source-level throw-site invariant  -> throwSiteInvariant()
//
// GOVERNANCE NOTE, deliberately load-bearing on nothing: §10 says of this set "This
// exact set is **proposed**, not ratified", while §12 lists "failure vocabulary"
// among what S0 freezes. This file takes NO position; it pins the §10 list so any
// drift REDs. Nothing here asserts the set has been ratified.

const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

const SEALED_DIR = path.join(__dirname, '..', 'lib', 'sealed-export')
const vocabulary = require(path.join(SEALED_DIR, 'failure-vocabulary.cjs'))
const contracts = require(path.join(SEALED_DIR, 'contracts.cjs'))
const lifecycle = require(path.join(SEALED_DIR, 'lifecycle.cjs'))
const harness = require(path.join(SEALED_DIR, 'compliance-harness.cjs'))

// ---------------------------------------------------------------------------
// PIN 1 — the exact §10 set, transcribed from the DOCUMENT, not from the module.
// If this list and the module disagree, the document wins and the suite REDs.
// ---------------------------------------------------------------------------
const DOCUMENT_SECTION_10_REASONS = [
  'SEALED_EXPORT_PROFILE_UNCERTIFIED',
  'SEALED_EXPORT_BINDING_UNQUALIFIED',
  'SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE',
  'SEALED_EXPORT_CAPTURE_FAILED',
  'SEALED_EXPORT_CAPTURE_INCOMPLETE',
  'SEALED_EXPORT_SIGNER_UNENROLLED',
  'SEALED_EXPORT_SIGNER_EXPIRED',
  'SEALED_EXPORT_SIGNER_REVOKED',
  'SEALED_EXPORT_MANIFEST_INVALID',
  'SEALED_EXPORT_MANIFEST_SIGNATURE_INVALID',
  'SEALED_EXPORT_MANIFEST_BINDING_MISMATCH',
  'SEALED_EXPORT_MANIFEST_SCHEMA_MISMATCH',
  'SEALED_EXPORT_MANIFEST_SNAPSHOT_MISMATCH',
  'SEALED_EXPORT_MANIFEST_REPLAYED',
  'SEALED_EXPORT_UPLOAD_SESSION_INVALID',
  'SEALED_EXPORT_CHUNK_UNDECLARED',
  'SEALED_EXPORT_CHUNK_DIGEST_MISMATCH',
  'SEALED_EXPORT_CHUNK_DUPLICATE_CONFLICT',
  'SEALED_EXPORT_CHUNK_ORDER_INVALID',
  'SEALED_EXPORT_CHUNK_SET_INCOMPLETE',
  'SEALED_EXPORT_ARTIFACT_DIGEST_MISMATCH',
  'SEALED_EXPORT_ROW_COUNT_MISMATCH',
  'SEALED_EXPORT_BUDGET_EXCEEDED',
  'SEALED_EXPORT_ARTIFACT_EXPIRED',
  'SEALED_EXPORT_STAGING_WRITE_FAILED',
  'SEALED_EXPORT_SEAL_INCOMPLETE',
  'SEALED_EXPORT_APPLY_INCOMPLETE',
  'SEALED_EXPORT_GENERATION_VERIFY_FAILED',
  'SEALED_EXPORT_VISIBILITY_CAS_CONFLICT',
  'SEALED_EXPORT_INTERNAL_ERROR',
]

function readSealedSources() {
  const names = fs.readdirSync(SEALED_DIR).filter((name) => name.endsWith('.cjs')).sort()
  return names.map((name) => ({ name, text: fs.readFileSync(path.join(SEALED_DIR, name), 'utf8') }))
}

function throws(fn, label) {
  let caught = null
  try { fn() } catch (error) { caught = error }
  assert.ok(caught instanceof vocabulary.SealedExportError, 'expected SealedExportError: ' + label)
  return caught
}

// ---------------------------------------------------------------------------
function vocabularyExactPin() {
  assert.equal(DOCUMENT_SECTION_10_REASONS.length, 30, 'the document lists 30 reasons')
  // Exact: same members, same spelling, same ORDER.
  assert.deepEqual(
    Array.from(vocabulary.SEALED_EXPORT_FAILURE_REASONS),
    DOCUMENT_SECTION_10_REASONS,
    'vocabulary must match §10 exactly',
  )
  assert.equal(new Set(DOCUMENT_SECTION_10_REASONS).size, 30, 'no duplicates')
  assert.ok(Object.isFrozen(vocabulary.SEALED_EXPORT_FAILURE_REASONS))
  assert.equal(vocabulary.SEALED_EXPORT_FIXED_INTERNAL_REASON, 'SEALED_EXPORT_INTERNAL_ERROR')

  // Membership predicate: exact equality, not prefix or substring.
  assert.equal(vocabulary.isDeclaredFailureReason('SEALED_EXPORT_MANIFEST_INVALID'), true)
  assert.equal(vocabulary.isDeclaredFailureReason('SEALED_EXPORT_MANIFEST_INVALID_EXTRA'), false)
  assert.equal(vocabulary.isDeclaredFailureReason('SEALED_EXPORT_'), false)
  assert.equal(vocabulary.isDeclaredFailureReason('sealed_export_manifest_invalid'), false)
  assert.equal(vocabulary.isDeclaredFailureReason(null), false)
}

// ---------------------------------------------------------------------------
// PIN 2 — latent-surface partition, and it must be DERIVED, not hand-matched.
// ---------------------------------------------------------------------------
function latentSurfacePin() {
  const reached = new Set(vocabulary.SEALED_EXPORT_S1_REACHED_REASONS)
  const unreached = new Set(vocabulary.SEALED_EXPORT_S1_UNREACHED_REASONS)

  // Disjoint, and together exactly the vocabulary.
  for (const reason of reached) assert.equal(unreached.has(reason), false, 'partition overlap: ' + reason)
  assert.equal(reached.size + unreached.size, 30, 'partition must cover the vocabulary')
  const union = Array.from(new Set([...reached, ...unreached])).sort()
  assert.deepEqual(union, DOCUMENT_SECTION_10_REASONS.slice().sort(), 'partition union')

  // The REACHED half is derived MECHANICALLY from the source, then set-compared.
  // Hand-matching would be the "count guard" antipattern: it would assert the
  // constant equals itself.
  const summary = harness.runSealedExportComplianceHarness({
    vectorSet: null,
    sources: readSealedSources(),
    declaredReasons: vocabulary.SEALED_EXPORT_FAILURE_REASONS,
    allowedThrowModule: 'failure-vocabulary.cjs',
  })
  // Non-literal reason arguments cannot be read by ANY source scan, so the set of
  // modules containing one is pinned by enumeration...
  assert.deepEqual(summary.dynamicReasonSites, ['contracts.cjs'],
    'exactly one module may compute a reason; adding another must RED')

  // ...and the one enumerated producer is proven BEHAVIOURALLY to yield only
  // vocabulary members, over its whole closed input domain. Those observed reasons
  // are UNIONED into the derived set before the comparison: structuralReasonFor
  // returns its reasons rather than passing them as literals, so a scan alone would
  // collect them only by the accident of their appearing as direct arguments
  // elsewhere in the same file. Deleting those other sites would silently shrink the
  // pin while the reasons stayed reachable.
  const observed = new Set(summary.reachedReasons)
  for (let index = 0; index < contracts.SEALED_EXPORT_CONTRACT_OBJECTS.length; index += 1) {
    const objectName = contracts.SEALED_EXPORT_CONTRACT_OBJECTS[index]
    const error = throws(() => contracts.SCHEMAS_BY_OBJECT[objectName] && validateByName(objectName, null),
      'structural refusal for ' + objectName)
    assert.equal(vocabulary.isDeclaredFailureReason(error.reason), true,
      'computed reason must be a vocabulary member: ' + objectName)
    observed.add(error.reason)
  }

  assert.deepEqual(
    Array.from(observed).sort(),
    Array.from(reached).sort(),
    'declared S1-reached set must equal the set the surface actually raises',
  )
}

function validateByName(objectName, input) {
  const byName = {
    EXPORT_REQUEST_ENVELOPE: contracts.validateExportRequestEnvelope,
    SIGNED_MANIFEST: contracts.validateSignedManifest,
    CHUNK_DESCRIPTOR: contracts.validateChunkDescriptor,
    CHUNK_RECEIPT: contracts.validateChunkReceipt,
    CHUNK_SUBMISSION: contracts.validateChunkSubmission,
    LIFECYCLE_EVIDENCE: contracts.validateLifecycleEvidence,
  }
  return byName[objectName](input)
}

// ---------------------------------------------------------------------------
// PIN 3 — source-level throw-site invariant, with its own positive control.
// A scan that only ever runs over clean source proves nothing about its power.
// ---------------------------------------------------------------------------
function throwSiteInvariant() {
  const sources = readSealedSources()
  assert.ok(sources.length >= 6, 'all sealed-export modules are scanned')

  const clean = harness.collectThrowSiteFindings(
    sources, vocabulary.SEALED_EXPORT_FAILURE_REASONS, 'failure-vocabulary.cjs',
  )
  assert.deepEqual(clean.findings, [], 'real source must satisfy the throw-site invariant')
  assert.ok(clean.throwSiteCount >= 1, 'the single throw site is present')

  // POSITIVE CONTROL A — an undeclared reason literal is caught.
  const undeclared = harness.collectThrowSiteFindings(
    [{ name: 'synthetic.cjs', text: "failSealedExport('NOT_A_REAL_REASON', {})" }],
    vocabulary.SEALED_EXPORT_FAILURE_REASONS, 'failure-vocabulary.cjs',
  )
  assert.equal(undeclared.findings.length, 1)
  assert.equal(undeclared.findings[0].checkId, 'THROW_SITE_REASON_UNDECLARED')

  // POSITIVE CONTROL B — a throw outside the single throw site is caught.
  const strayThrow = harness.collectThrowSiteFindings(
    [{ name: 'synthetic.cjs', text: 'function f() { throw new Error("x") }' }],
    vocabulary.SEALED_EXPORT_FAILURE_REASONS, 'failure-vocabulary.cjs',
  )
  assert.equal(strayThrow.findings.length, 1)
  assert.equal(strayThrow.findings[0].checkId, 'THROW_SITE_MODULE')

  // POSITIVE CONTROL C — a declared reason in the allowed module is NOT flagged.
  const allowed = harness.collectThrowSiteFindings(
    [{ name: 'failure-vocabulary.cjs', text: "throw 0; failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')" }],
    vocabulary.SEALED_EXPORT_FAILURE_REASONS, 'failure-vocabulary.cjs',
  )
  assert.deepEqual(allowed.findings, [], 'the allowed module with a declared reason is clean')

  // The stripper must blank comments and strings, so a `throw` mentioned in prose or
  // inside a quoted example cannot mask — or fabricate — a real one.
  const masked = harness.collectThrowSiteFindings(
    [{ name: 'synthetic.cjs', text: '// this module does not throw\nconst s = "throw"\n/* throw */' }],
    vocabulary.SEALED_EXPORT_FAILURE_REASONS, 'failure-vocabulary.cjs',
  )
  assert.deepEqual(masked.findings, [], 'commented/quoted `throw` must not count as a throw site')
  assert.equal(masked.throwSiteCount, 0)
  assert.equal(harness.stripCommentsAndStrings('const a = "x" // y').indexOf('x'), -1)
  assert.equal(harness.stripCommentsAndStrings('const a = 1 // throw').indexOf('throw'), -1)
}

// ---------------------------------------------------------------------------
// Runtime-consumer pin, second half: S1 is LATENT, so nothing outside the
// directory may require these modules.
// ---------------------------------------------------------------------------
function zeroConsumerSweep() {
  const packageRoot = path.join(__dirname, '..')
  const skipDirectories = new Set(['node_modules', '__tests__', 'dist', '.git', 'sealed-export'])
  const offenders = []
  let scanned = 0

  const walk = (directory) => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!skipDirectories.has(entry.name)) walk(full)
        continue
      }
      if (!/\.(cjs|js|mjs|ts)$/.test(entry.name)) continue
      scanned += 1
      if (fs.readFileSync(full, 'utf8').indexOf('sealed-export') >= 0) {
        offenders.push(path.relative(packageRoot, full))
      }
    }
  }
  walk(packageRoot)

  // POSITIVE CONTROL: the sweep actually visited a meaningful number of files. A
  // sweep that walked nothing would report zero offenders and prove nothing.
  assert.ok(scanned > 50, 'zero-consumer sweep must actually traverse the package, scanned=' + scanned)
  assert.deepEqual(offenders, [], 'S1 must have no runtime consumer outside lib/sealed-export/')
}

// ---------------------------------------------------------------------------
// §10 rule: an undeclared reason becomes the fixed SEALED_EXPORT_INTERNAL_ERROR,
// "never an echoed value".
// ---------------------------------------------------------------------------
function undeclaredReasonIsNeverEchoed() {
  const marker = 'ZZ-UNDECLARED-MARKER-4636'
  const error = throws(() => vocabulary.failSealedExport(marker, { chunkIndex: 3 }), 'undeclared reason')

  assert.equal(error.reason, 'SEALED_EXPORT_INTERNAL_ERROR', 'substituted with the fixed reason')
  // The rejected value must not survive anywhere on the error.
  assert.equal(error.message.indexOf(marker), -1, 'not echoed in the message')
  assert.equal(JSON.stringify(error.details).indexOf(marker), -1, 'not echoed in the details')
  assert.equal(String(error.stack).indexOf(marker), -1, 'not echoed in the stack')
  assert.deepEqual(error.details, {}, 'details of an undeclared reason are dropped entirely')

  // A whole-object sweep: no enumerable property of the error carries the marker.
  assert.equal(JSON.stringify(Object.getOwnPropertyNames(error).map((k) => String(error[k])))
    .indexOf(marker), -1, 'not echoed in any own property')

  // Non-string reasons must not be coerced through toString either.
  const coercive = { toString: () => marker }
  const coerced = throws(() => vocabulary.failSealedExport(coercive), 'coercive reason object')
  assert.equal(coerced.reason, 'SEALED_EXPORT_INTERNAL_ERROR')
  assert.equal(coerced.message.indexOf(marker), -1, 'toString must not reach the message')

  // POSITIVE CONTROL: a DECLARED reason is preserved verbatim, so the substitution
  // above is discriminating and not "everything becomes INTERNAL_ERROR".
  const declared = throws(
    () => vocabulary.failSealedExport('SEALED_EXPORT_CHUNK_ORDER_INVALID', { chunkIndex: 3 }),
    'declared reason',
  )
  assert.equal(declared.reason, 'SEALED_EXPORT_CHUNK_ORDER_INVALID')
  assert.deepEqual(declared.details, { chunkIndex: 3 }, 'declared reasons keep their details')
}

// ---------------------------------------------------------------------------
// §10 rule: "details expose only fixed field names, booleans, counts, and safe
// tokens". Proven by feeding VALUE-BEARING input and finding none of it.
// ---------------------------------------------------------------------------
function detailsCarryNoCallerValues() {
  const valueBearing = 'ZZ-VALUE-BEARING-4636'

  // An unknown detail KEY refuses the whole details object.
  const unknownKey = throws(
    () => vocabulary.failSealedExport('SEALED_EXPORT_MANIFEST_INVALID', { notADetailField: 1 }),
    'unknown detail key',
  )
  assert.equal(unknownKey.reason, 'SEALED_EXPORT_INTERNAL_ERROR', 'refused, not dropped')
  assert.deepEqual(unknownKey.details, {})

  // A free-form string in a known field is REFUSED even though it is syntactically
  // clean ASCII: the token set is closed, not a syntax check.
  const freeString = throws(
    () => vocabulary.failSealedExport('SEALED_EXPORT_MANIFEST_INVALID', { field: valueBearing }),
    'free-form string detail',
  )
  assert.equal(freeString.reason, 'SEALED_EXPORT_INTERNAL_ERROR')
  assert.equal(JSON.stringify(freeString.details).indexOf(valueBearing), -1)
  assert.equal(freeString.message.indexOf(valueBearing), -1)
  assert.equal(String(freeString.stack).indexOf(valueBearing), -1)

  // POSITIVE CONTROL: the SAME field with a safe token is accepted. Without this,
  // "refuse everything" would satisfy the assertion above.
  const safe = throws(
    () => vocabulary.failSealedExport('SEALED_EXPORT_MANIFEST_INVALID', { field: 'totalRows' }),
    'safe token detail',
  )
  assert.equal(safe.reason, 'SEALED_EXPORT_MANIFEST_INVALID')
  assert.deepEqual(safe.details, { field: 'totalRows' })

  // Booleans and counts pass; negative, fractional and unsafe numbers do not.
  assert.deepEqual(
    throws(() => vocabulary.failSealedExport('SEALED_EXPORT_MANIFEST_INVALID',
      { canonical: false, observedCount: 0 })).details,
    { canonical: false, observedCount: 0 },
  )
  assert.deepEqual(throws(() => vocabulary.failSealedExport('SEALED_EXPORT_MANIFEST_INVALID',
    { observedCount: -1 })).details, {}, 'negative count refused')
  assert.deepEqual(throws(() => vocabulary.failSealedExport('SEALED_EXPORT_MANIFEST_INVALID',
    { observedCount: 1.5 })).details, {}, 'fractional count refused')
  assert.deepEqual(throws(() => vocabulary.failSealedExport('SEALED_EXPORT_MANIFEST_INVALID',
    { observedCount: Number.MAX_SAFE_INTEGER + 2 })).details, {}, 'unsafe count refused')

  // Structural smuggling: nested objects, arrays, symbols and accessors are refused.
  assert.deepEqual(throws(() => vocabulary.failSealedExport('SEALED_EXPORT_MANIFEST_INVALID',
    { field: { nested: valueBearing } })).details, {}, 'nested object refused')
  assert.deepEqual(throws(() => vocabulary.failSealedExport('SEALED_EXPORT_MANIFEST_INVALID',
    { field: [valueBearing] })).details, {}, 'array refused')
  const withSymbol = { field: 'totalRows' }
  withSymbol[Symbol('s')] = valueBearing
  assert.deepEqual(throws(() => vocabulary.failSealedExport('SEALED_EXPORT_MANIFEST_INVALID',
    withSymbol)).details, {}, 'symbol key refused')
  const accessor = {}
  Object.defineProperty(accessor, 'field', { get: () => valueBearing, enumerable: true })
  assert.deepEqual(throws(() => vocabulary.failSealedExport('SEALED_EXPORT_MANIFEST_INVALID',
    accessor)).details, {}, 'accessor refused')
  assert.deepEqual(throws(() => vocabulary.failSealedExport('SEALED_EXPORT_MANIFEST_INVALID',
    [1, 2])).details, {}, 'array details refused')

  // The returned details object is owned and frozen, so a caller cannot mutate the
  // evidence surface after the fact.
  assert.ok(Object.isFrozen(safe.details))
}

// ---------------------------------------------------------------------------
// MIRROR: every string a sibling module can put in a details VALUE position must be
// a safe token. Derived from the sibling modules' own exports — this is the check
// that caught `bindingVersion`, `state` and `targetState` missing.
// ---------------------------------------------------------------------------
function deriveRequiredDetailValueTokens() {
  const required = new Set()

  // (a) DYNAMIC value positions — derived from the sibling modules' own exports,
  //     because these values are computed at refusal time and never appear as a
  //     literal anywhere in the source. This half is what caught `bindingVersion`.
  //     `object:` carries a contract-object token.
  for (const token of contracts.SEALED_EXPORT_CONTRACT_OBJECTS) required.add(token)
  //     `field:` carries a schema field name (assertClosedObjectShape reports the
  //     missing key by name, for every field of every schema).
  for (const schema of Object.values(contracts.SCHEMAS_BY_OBJECT)) {
    for (const field of Object.keys(schema)) required.add(field)
  }
  //     `state:` / `targetState:` carry lifecycle state tokens.
  for (const token of lifecycle.SEALED_EXPORT_LIFECYCLE_STATES) required.add(token)
  //     `proofClass:` carries a source-capture proof-class token.
  for (const token of contracts.SEALED_EXPORT_SOURCE_CAPTURE_PROOF_CLASSES) required.add(token)

  // (b) LITERAL value positions — scanned out of the source, because a literal like
  //     { field: 'state' } names something no export enumerates. Detail field NAMES
  //     are deliberately NOT assumed to be values; only the ones actually written as
  //     values are required. This half is what caught `state` and `targetState`.
  const detailFields = Array.from(vocabulary.SEALED_EXPORT_DETAIL_FIELDS).join('|')
  const sources = readSealedSources()
  let literalsFound = 0
  for (let index = 0; index < sources.length; index += 1) {
    const pattern = new RegExp('\\b(' + detailFields + ")\\s*:\\s*'([^']*)'", 'g')
    let match = pattern.exec(sources[index].text)
    while (match !== null) {
      required.add(match[2])
      literalsFound += 1
      match = pattern.exec(sources[index].text)
    }
  }
  return { required, literalsFound }
}

function safeTokenMirrorIsComplete() {
  const safe = new Set(vocabulary.SEALED_EXPORT_SAFE_DETAIL_TOKENS)
  const { required, literalsFound } = deriveRequiredDetailValueTokens()

  const missing = Array.from(required).filter((token) => !safe.has(token)).sort()
  assert.deepEqual(missing, [], 'every possible details value must be a declared safe token')

  // POSITIVE CONTROL for the mirror: the derivation must be non-trivial, and the
  // comparison must be able to FAIL. Removing any one required token from a COPY of
  // the safe set must be detected — otherwise the whole check is vacuous.
  assert.ok(required.size > 40, 'the mirror derived a meaningful obligation set, size=' + required.size)
  assert.ok(literalsFound > 5, 'the literal scan found value positions, count=' + literalsFound)
  const sample = Array.from(required).sort()
  for (let index = 0; index < sample.length; index += 1) {
    const weakened = new Set(safe)
    weakened.delete(sample[index])
    const detected = Array.from(required).filter((token) => !weakened.has(token))
    assert.deepEqual(detected, [sample[index]],
      'the mirror must detect a missing token: ' + sample[index])
  }

  // Every safe token is itself accepted in a details field that admits strings, so
  // the set contains no member the discipline would reject.
  for (const token of vocabulary.SEALED_EXPORT_SAFE_DETAIL_TOKENS) {
    const error = throws(
      () => vocabulary.failSealedExport('SEALED_EXPORT_MANIFEST_INVALID', { field: token }),
      'safe token ' + token,
    )
    assert.equal(error.reason, 'SEALED_EXPORT_MANIFEST_INVALID', 'safe token rejected: ' + token)
  }
}

function main() {
  vocabularyExactPin()
  latentSurfacePin()
  throwSiteInvariant()
  zeroConsumerSweep()
  undeclaredReasonIsNeverEchoed()
  detailsCarryNoCallerValues()
  safeTokenMirrorIsComplete()
  console.log('sealed-export-failure-vocabulary.test.cjs OK')
}

main()

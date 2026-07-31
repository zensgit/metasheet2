'use strict'

// Sealed-export controlled surface — closed failure vocabulary battery. Plain
// node test, hermetic.
//
// §10 of the ratified S0 baseline requires three pins, and this file carries all
// three:
//   1. an exact vocabulary pin              -> vocabularyExactPin()
//   2. a runtime consumer pin               -> latentSurfacePin()
//                                            + controlledConsumerSweep()
//   3. a source-level throw-site invariant  -> throwSiteInvariant()
//                                            + astThrowSiteScanHasNoBlindWindow()
//
// Pin 3 is a STATIC SOURCE assertion, not a behaviour proof: it establishes that throw
// statements and the declared vocabulary are consistent in the source text. What the code
// does at runtime is proven separately, by the pins that call the real functions.
//
// GOVERNANCE NOTE — RETRACTION (2026-07-27). This note previously read: §10 says of
// this set "This exact set is **proposed**, not ratified", while §12 lists "failure
// vocabulary" among what S0 freezes; this file takes NO position. That is NO LONGER
// TRUE. The owner RATIFIED this exact set on 2026-07-27 and froze it at exactly 30
// tokens; no reason may be added, removed or renamed. The pin below is unchanged —
// it still transcribes §10 from the DOCUMENT so any drift REDs.

const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

const SEALED_DIR = path.join(__dirname, '..', 'lib', 'sealed-export')
const vocabulary = require(path.join(SEALED_DIR, 'failure-vocabulary.cjs'))
const contracts = require(path.join(SEALED_DIR, 'contracts.cjs'))
const lifecycle = require(path.join(SEALED_DIR, 'lifecycle.cjs'))
const { scanSealedExportThrowSites } = require(path.join(__dirname, 'support', 'sealed-export-source-scan.cjs'))

// Every assertion driven by scanSealedExportThrowSites is a STATIC SOURCE assertion: it
// proves the source text is internally consistent between its throw sites and the declared
// vocabulary. It is NOT a behaviour proof — that class is carried by latentSurfacePin's
// behavioural half, undeclaredReasonIsNeverEchoed and detailsCarryNoCallerValues, which
// call the real functions.
function scan(sources, parseOverride) {
  return scanSealedExportThrowSites(
    sources, vocabulary.SEALED_EXPORT_FAILURE_REASONS, 'failure-vocabulary.cjs', parseOverride,
  )
}

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

function trustedErrorIdentityPin() {
  const genuine = throws(
    () => vocabulary.failSealedExport('SEALED_EXPORT_INTERNAL_ERROR'),
    'genuine branded error',
  )
  assert.equal(vocabulary.isTrustedSealedExportError(genuine), true)
  assert.equal(
    vocabulary.isTrustedSealedExportError(
      new vocabulary.SealedExportError(
        'SEALED_EXPORT_INTERNAL_ERROR',
        Object.freeze({}),
      ),
    ),
    false,
    'the public error constructor cannot mint transaction-pass-through authority',
  )
  assert.equal(
    vocabulary.isTrustedSealedExportError(
      Object.create(vocabulary.SealedExportError.prototype),
    ),
    false,
    'prototype spoofing cannot mint transaction-pass-through authority',
  )
}

// ---------------------------------------------------------------------------
// PIN 2 — latent-surface partition, and it must be DERIVED, not hand-matched.
// ---------------------------------------------------------------------------
function latentSurfacePin() {
  const reached = new Set(vocabulary.SEALED_EXPORT_LATENT_REACHED_REASONS)
  const unreached = new Set(vocabulary.SEALED_EXPORT_LATENT_UNREACHED_REASONS)

  // Disjoint, and together exactly the vocabulary.
  for (const reason of reached) assert.equal(unreached.has(reason), false, 'partition overlap: ' + reason)
  assert.equal(reached.size + unreached.size, 30, 'partition must cover the vocabulary')
  const union = Array.from(new Set([...reached, ...unreached])).sort()
  assert.deepEqual(union, DOCUMENT_SECTION_10_REASONS.slice().sort(), 'partition union')

  // The REACHED half is derived MECHANICALLY from the source (AST), then set-compared.
  // Hand-matching would be the "count guard" antipattern: it would assert the
  // constant equals itself.
  const summary = scan(readSealedSources())
  assert.deepEqual(summary.findings, [], 'the source scan must be clean before deriving from it')
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
    'declared latent-reached set must equal the set the surface actually raises',
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
// PIN 3 — source-level throw-site invariant, over a REAL PARSE, with its own positive
// controls. A scan that only ever runs over clean source proves nothing about its power.
//
// STATIC, NOT BEHAVIOURAL: everything below reads source text. It shows throw statements
// sit only in the allowed module and that every literal reason is a vocabulary member. It
// says nothing about what the code does when run.
// ---------------------------------------------------------------------------
function throwSiteInvariant() {
  const sources = readSealedSources()
  assert.ok(sources.length >= 6, 'all sealed-export modules are scanned')

  const clean = scan(sources)
  assert.deepEqual(clean.findings, [],
    'STATIC: real source must satisfy the throw-site invariant (source consistency, not behaviour)')
  assert.ok(clean.throwSiteCount >= 1, 'the single throw site is present')
  assert.equal(clean.parsedSources, sources.length, 'every module parsed; none was skipped')

  // POSITIVE CONTROL A — an undeclared reason literal is caught.
  const undeclared = scan([{ name: 'synthetic.cjs', text: "failSealedExport('NOT_A_REAL_REASON', {})" }])
  assert.equal(undeclared.findings.length, 1)
  assert.equal(undeclared.findings[0].checkId, 'THROW_SITE_REASON_UNDECLARED')

  // POSITIVE CONTROL B — a throw outside the single throw site is caught.
  const strayThrow = scan([{ name: 'synthetic.cjs', text: 'function f() { throw new Error("x") }' }])
  assert.equal(strayThrow.findings.length, 1)
  assert.equal(strayThrow.findings[0].checkId, 'THROW_SITE_MODULE')

  // POSITIVE CONTROL C — a declared reason in the allowed module is NOT flagged.
  const allowed = scan([{
    name: 'failure-vocabulary.cjs',
    text: "function f() { throw 0 }\nfailSealedExport('SEALED_EXPORT_INTERNAL_ERROR')",
  }])
  assert.deepEqual(allowed.findings, [], 'the allowed module with a declared reason is clean')

  // A `throw` mentioned in prose or inside a quoted example is not a throw statement.
  const masked = scan([{
    name: 'synthetic.cjs',
    text: '// this module does not throw\nconst s = "throw"\n/* throw */\nconst t = `throw`\n',
  }])
  assert.deepEqual(masked.findings, [], 'commented/quoted `throw` must not count as a throw site')
  assert.equal(masked.throwSiteCount, 0)
}

// ---------------------------------------------------------------------------
// PIN 3, second half — the three properties the hand-written stripper could not hold.
//
// RETRACTION. The previous scanner blanked comments and strings with a character scan that
// could not distinguish a regex literal `/.../` from division. compliance-harness.cjs then
// contained `/failSealedExport\(\s*(['"])([^'"]*)\1/g`; the scanner read the `'` inside that
// literal as the start of a string and blanked from there to the next `'`. A real `throw`
// placed inside that window was counted ZERO, while the module's own header asserted "no
// throw ... asserted mechanically". The claim was true; the mechanism was blind.
//
// SECOND RETRACTION (2026-07-27), narrowing the first: this text used to add "desynchronising
// for the rest of the file". That overstates it. The window was BOUNDED — the scanner
// re-synchronised at a later quote — so the blindness ran from the offending literal to that
// point, not to the end of the file. Bounded was already enough to hide a real throw.
// Controls 1-3 are the regression pins.
// ---------------------------------------------------------------------------
function astThrowSiteScanHasNoBlindWindow() {
  // CONTROL 1 — a `throw` INSIDE A REGEX LITERAL is not a throw statement.
  const inRegex = scan([{
    name: 'synthetic.cjs',
    text: "const re = /throw/g\nconst also = /a throw b/\nmodule.exports = { re, also }\n",
  }])
  assert.deepEqual(inRegex.findings, [], 'a throw inside a regex literal must not be counted')
  assert.equal(inRegex.throwSiteCount, 0, 'regex-literal `throw` contributes no throw site')

  // CONTROL 2 — a REAL throw inside a TEMPLATE INTERPOLATION `${ ... }` IS counted.
  // (A throw statement cannot sit in expression position, so it is wrapped in an IIFE —
  // written the way real code would have to write it.)
  const inInterpolation = scan([{
    name: 'synthetic.cjs',
    text: "const s = `${(() => { throw new Error('sx-interp') })()}`\nmodule.exports = { s }\n",
  }])
  assert.equal(inInterpolation.throwSiteCount, 1, 'a throw inside ${ } must be counted')
  assert.equal(inInterpolation.findings.length, 1)
  assert.equal(inInterpolation.findings[0].checkId, 'THROW_SITE_MODULE')

  // CONTROL 3 — THE PROVEN BLIND WINDOW. The offending regex literal verbatim, followed by
  // a real throw. The old scanner returned 0 here; the parse-based scan must return 1.
  const afterRegexLine = scan([{
    name: 'synthetic.cjs',
    text: [
      "const reasonPattern = /failSealedExport\\(\\s*(['\"])([^'\"]*)\\1/g",
      'function later() { throw new Error("sx-after-regex") }',
      'module.exports = { reasonPattern, later }',
    ].join('\n'),
  }])
  assert.equal(afterRegexLine.throwSiteCount, 1,
    'a throw AFTER the scanner\'s own regex line must be counted — this is the proven blind window')
  assert.equal(afterRegexLine.findings.length, 1)
  assert.equal(afterRegexLine.findings[0].checkId, 'THROW_SITE_MODULE')

  // The same shape at REAL SCALE: the whole live compliance-harness.cjs source, with the
  // offending regex literal and a throw injected into it. The live module no longer
  // contains such a literal (the stripper that needed one is gone), so the literal is
  // supplied here rather than assumed — otherwise this case would not discriminate.
  const harnessText = fs.readFileSync(path.join(SEALED_DIR, 'compliance-harness.cjs'), 'utf8')
  const injectedLines = harnessText.split('\n')
  const anchor = injectedLines.findIndex((line) => line.indexOf('function formatHarnessSummary') >= 0)
  assert.ok(anchor > 0, 'anchor for the injected throw must exist')
  injectedLines.splice(
    anchor, 0,
    "const sxProbe = /failSealedExport\\(\\s*(['\"])([^'\"]*)\\1/g",
    'function sxInjected() { throw new Error("sx-injected") }',
    'module.exports.sxProbe = sxProbe',
  )
  const injected = scan([{ name: 'compliance-harness.cjs', text: injectedLines.join('\n') }])
  assert.equal(injected.throwSiteCount, 1,
    'a throw after a regex literal in the REAL module must be counted')
  assert.equal(injected.findings.length, 1)
  assert.equal(injected.findings[0].checkId, 'THROW_SITE_MODULE')

  // FAIL-CLOSED A — a source that does not parse is a FINDING, never "zero findings".
  const broken = scan([{ name: 'synthetic.cjs', text: 'function f( { const = ;;;)(' }])
  assert.equal(broken.findings.length, 1, 'a parse failure must not be reported as clean')
  assert.equal(broken.findings[0].checkId, 'SOURCE_PARSE_FAILED')
  assert.equal(broken.parsedSources, 0)

  // FAIL-CLOSED B — if parse diagnostics are not observable at all (a future compiler
  // dropping the property), the scan refuses rather than concluding "no diagnostics".
  const unverifiable = scan(
    [{ name: 'synthetic.cjs', text: 'function f() { throw new Error("x") }' }],
    () => ({}),
  )
  assert.equal(unverifiable.findings.length, 1)
  assert.equal(unverifiable.findings[0].checkId, 'SOURCE_PARSE_UNVERIFIABLE')
  assert.equal(unverifiable.throwSiteCount, 0)

  // FAIL-CLOSED C — a parser that throws, and a source entry with no text, are findings.
  const parserThrew = scan([{ name: 'synthetic.cjs', text: 'const a = 1' }], () => { throw new Error('x') })
  assert.equal(parserThrew.findings[0].checkId, 'SOURCE_PARSE_FAILED')
  const noText = scan([{ name: 'synthetic.cjs' }])
  assert.equal(noText.findings[0].checkId, 'SOURCE_UNREADABLE')

  // NEGATIVE CONTROL for all of the above: the same scan over healthy synthetic source is
  // clean, so these are not "everything is a finding".
  const healthy = scan([{ name: 'synthetic.cjs', text: 'const a = 1\nmodule.exports = { a }\n' }])
  assert.deepEqual(healthy.findings, [])
  assert.equal(healthy.parsedSources, 1)
}

// ---------------------------------------------------------------------------
// PIN 3, third half — the scan matches the BINDING, not the call NAME.
//
// OWNER POST-MERGE FINDING (P2, 2026-07-27). `calleeName` handled only `ts.isIdentifier`
// and `ts.isPropertyAccessExpression`, so the scan matched a call by the name written at
// the call site. A direct undeclared reason REDed, but a renamed destructure and an
// element access both produced ZERO findings:
//     const { failSealedExport: fail } = ...; fail('NOT_DECLARED')
//     v['failSealedExport']('NOT_DECLARED')
// Enumerating call forms is the same non-converging mistake as the hand-written stripper,
// so the scan now RESOLVES the binding — every local name bound to failSealedExport,
// renames included — and fails LOUD on any call shape it cannot statically resolve.
// Silence on an unresolvable shape is the defect.
// ---------------------------------------------------------------------------
function astScanMatchesBindingsNotNames() {
  const REQUIRE = "require('./failure-vocabulary.cjs')"

  // SHAPE 1 — the direct call. This one always worked; it is here so the three shapes
  // are compared side by side rather than asserted apart.
  const direct = scan([{
    name: 'synthetic.cjs',
    text: 'const { failSealedExport } = ' + REQUIRE + "\nfailSealedExport('NOT_DECLARED')\n",
  }])
  assert.equal(direct.findings.length, 1, 'direct call: exactly one finding')
  assert.equal(direct.findings[0].checkId, 'THROW_SITE_REASON_UNDECLARED')

  // SHAPE 2 — the RENAMED DESTRUCTURE. Zero findings before the fix.
  const renamed = scan([{
    name: 'synthetic.cjs',
    text: 'const { failSealedExport: fail } = ' + REQUIRE + "\nfail('NOT_DECLARED')\n",
  }])
  assert.equal(renamed.findings.length, 1, 'renamed destructure must be resolved to the binding')
  assert.equal(renamed.findings[0].checkId, 'THROW_SITE_REASON_UNDECLARED')

  // SHAPE 2b — an alias of the alias. Resolution is transitive or it is name matching
  // with extra steps.
  const aliasChain = scan([{
    name: 'synthetic.cjs',
    text: 'const { failSealedExport: fail } = ' + REQUIRE
      + "\nconst deeper = fail\ndeeper('NOT_DECLARED')\n",
  }])
  assert.equal(aliasChain.findings.length, 1, 'an alias of an alias must resolve')
  assert.equal(aliasChain.findings[0].checkId, 'THROW_SITE_REASON_UNDECLARED')

  // SHAPE 2c — a member alias: `const fail = vocabulary.failSealedExport`.
  const memberAlias = scan([{
    name: 'synthetic.cjs',
    text: 'const v = ' + REQUIRE + "\nconst fail = v.failSealedExport\nfail('NOT_DECLARED')\n",
  }])
  assert.equal(memberAlias.findings.length, 1, 'a member alias must resolve')
  assert.equal(memberAlias.findings[0].checkId, 'THROW_SITE_REASON_UNDECLARED')

  // SHAPE 3 — ELEMENT ACCESS with a static string. Zero findings before the fix.
  const elementAccess = scan([{
    name: 'synthetic.cjs',
    text: 'const v = ' + REQUIRE + "\nv['failSealedExport']('NOT_DECLARED')\n",
  }])
  assert.equal(elementAccess.findings.length, 1, 'static element access must be resolved')
  assert.equal(elementAccess.findings[0].checkId, 'THROW_SITE_REASON_UNDECLARED')

  // SHAPE 4 — UNRESOLVABLE. A computed callee cannot be read by any static scan. The
  // scan must say so LOUDLY; reporting nothing would be indistinguishable from clean.
  const computed = scan([{
    name: 'synthetic.cjs',
    text: 'const v = ' + REQUIRE + "\nconst name = 'failSealedExport'\nv[name]('NOT_DECLARED')\n",
  }])
  assert.equal(computed.findings.length, 1, 'an unresolvable callee must produce a finding, not silence')
  assert.equal(computed.findings[0].checkId, 'THROW_SITE_CALLEE_UNRESOLVABLE')

  // …and the same for a callee that is itself the result of a call.
  const callOfCall = scan([{
    name: 'synthetic.cjs',
    text: 'const v = ' + REQUIRE + "\npick(v)('NOT_DECLARED')\n",
  }])
  assert.equal(callOfCall.findings.length, 1, 'a call-of-call callee is unresolvable')
  assert.equal(callOfCall.findings[0].checkId, 'THROW_SITE_CALLEE_UNRESOLVABLE')

  // NEGATIVE CONTROL — a rename of something that is NOT failSealedExport must stay
  // clean. Without this, "flag every one-string-argument call" would pass everything above.
  const otherBinding = scan([{
    name: 'synthetic.cjs',
    text: 'const { isDeclaredFailureReason: fail } = ' + REQUIRE + "\nfail('NOT_DECLARED')\n",
  }])
  assert.deepEqual(otherBinding.findings, [], 'a rename of a different export must not be matched')

  // NEGATIVE CONTROL — a DECLARED reason through a rename is clean, and its reason is
  // still collected, so binding resolution did not shrink reachedReasons.
  const declaredThroughAlias = scan([{
    name: 'synthetic.cjs',
    text: 'const { failSealedExport: fail } = ' + REQUIRE
      + "\nfail('SEALED_EXPORT_MANIFEST_INVALID')\n",
  }])
  assert.deepEqual(declaredThroughAlias.findings, [], 'a declared reason through an alias is clean')
  assert.deepEqual(declaredThroughAlias.reachedReasons, ['SEALED_EXPORT_MANIFEST_INVALID'],
    'a reason reached through an alias must still be collected')

  // A dynamic reason through an alias is still an enumerated dynamic site, not silence.
  const dynamicThroughAlias = scan([{
    name: 'synthetic.cjs',
    text: 'const { failSealedExport: fail } = ' + REQUIRE + '\nfail(pickReason(), {})\n',
  }])
  assert.deepEqual(dynamicThroughAlias.dynamicReasonSites, ['synthetic.cjs'],
    'a computed reason through an alias must be enumerated')

  // An IIFE callee is a literal function, statically known not to be failSealedExport.
  // It must NOT be reported as unresolvable, or CONTROL 2 above would be a false alarm.
  const iife = scan([{
    name: 'synthetic.cjs',
    text: 'const s = (function () { return 1 })()\nmodule.exports = { s }\n',
  }])
  assert.deepEqual(iife.findings, [], 'an immediately-invoked function literal is resolvable')

  // ESCAPE — a binding handed out as a VALUE leaves this resolver's reach. Beyond the
  // owner's named finding, and reported for the same reason: an escape that is silently
  // ignored is a hole shaped exactly like the one being closed.
  const escapes = scan([{
    name: 'synthetic.cjs',
    text: 'const { failSealedExport } = ' + REQUIRE + '\nmodule.exports = { failSealedExport }\n',
  }])
  assert.equal(escapes.findings.length, 1, 'a bound name used as a value must be reported')
  assert.equal(escapes.findings[0].checkId, 'THROW_SITE_BINDING_ESCAPES')

  // A member read is itself a function value. Direct invocation and the two alias forms
  // above are the only uses this resolver follows; invocation helpers and containers escape
  // that model and must fail loud rather than looking like a clean source file.
  const assertMemberEscape = (label, body) => {
    const result = scan([{
      name: 'synthetic.cjs',
      text: 'const v = ' + REQUIRE + '\n' + body + '\n',
    }])
    assert.equal(result.findings.length, 1, label + ': exactly one escape finding')
    assert.equal(result.findings[0].checkId, 'THROW_SITE_BINDING_ESCAPES', label)
  }
  assertMemberEscape('.call', "v.failSealedExport.call(null, 'NOT_DECLARED')")
  assertMemberEscape('.apply', "v.failSealedExport.apply(null, ['NOT_DECLARED'])")
  assertMemberEscape('.bind', "const fail = v.failSealedExport.bind(null)\nfail('NOT_DECLARED')")
  assertMemberEscape('Reflect.apply', "Reflect.apply(v.failSealedExport, null, ['NOT_DECLARED'])")
  assertMemberEscape('array storage', 'const values = [v.failSealedExport]\nmodule.exports = values')
  assertMemberEscape('object storage', 'const values = { fail: v.failSealedExport }\nmodule.exports = values')

  // Wrapper syntax must not turn the two supported forms into false escapes.
  const wrappedDirect = scan([{
    name: 'synthetic.cjs',
    text: 'const v = ' + REQUIRE + ";\n(v.failSealedExport)('SEALED_EXPORT_MANIFEST_INVALID')\n",
  }])
  assert.deepEqual(wrappedDirect.findings, [], 'a parenthesized direct call remains resolved')
  const wrappedAlias = scan([{
    name: 'synthetic.cjs',
    text: 'const v = ' + REQUIRE
      + "\nconst fail = (v.failSealedExport)\nfail('SEALED_EXPORT_MANIFEST_INVALID')\n",
  }])
  assert.deepEqual(wrappedAlias.findings, [], 'a parenthesized alias remains resolved')
  const wrappedIdentifier = scan([{
    name: 'synthetic.cjs',
    text: 'const { failSealedExport: fail } = ' + REQUIRE
      + ";\n(fail)('SEALED_EXPORT_MANIFEST_INVALID')\n",
  }])
  assert.deepEqual(wrappedIdentifier.findings, [], 'a parenthesized bound identifier remains resolved')

  // …and a computed member read OF THE VOCABULARY MODULE is an unreadable binding form.
  const computedAlias = scan([{
    name: 'synthetic.cjs',
    text: 'const v = ' + REQUIRE + "\nconst k = 'failSealedExport'\nconst fail = v[k]\nfail('X')\n",
  }])
  assert.equal(computedAlias.findings.length, 1, 'a computed alias off the vocabulary module is reported')
  assert.equal(computedAlias.findings[0].checkId, 'THROW_SITE_BINDING_UNRESOLVABLE')

  // NEGATIVE CONTROL for that rule — an ordinary computed read (an array index) is NOT a
  // binding attempt. Flagging every `bytes[index]` would drown the scan in noise and is
  // why the receiver must resolve to the vocabulary module.
  const arrayIndex = scan([{
    name: 'synthetic.cjs',
    text: 'const bytes = [1, 2]\nconst index = 1\nconst one = bytes[index]\nmodule.exports = { one }\n',
  }])
  assert.deepEqual(arrayIndex.findings, [], 'an array index must not be read as an alias attempt')
}

// ---------------------------------------------------------------------------
// Runtime-consumer pin, second half: S6-A authorizes exactly three controlled
// consumers outside the sealed-export implementation directory. Any additional
// runtime import remains outside the approved single-customer surface.
//
// Both roots and the filesystem are PARAMETERS, so the sweep can be aimed at a synthetic
// tree whose offender is known. Without that, "zero offenders" is a traversal result, not
// a detection result. Nothing is written to disk: the control's filesystem is in memory.
// ---------------------------------------------------------------------------
const SWEEP_SKIP_DIRECTORIES = new Set([
  'node_modules', 'dist', 'build', 'coverage', '.next', '.git', '.turbo', '.output',
  '__tests__', 'tests', 'test', '__mocks__', 'e2e',
  'sealed-export', // the S1 modules themselves
])
const SWEEP_SOURCE_FILE = /\.(cjs|mjs|js|jsx|ts|tsx|vue)$/
const SWEEP_TEST_FILE = /\.(spec|test)\.[cm]?[jt]sx?$/

// An IMPORT, not a mention. A doc comment or a chain entry naming the directory is not a
// consumer. Both module syntaxes are covered (require / ESM), per the writer-audit rule,
// plus the computed `path.join(..., 'sealed-export', ...)` form these very tests use.
const SWEEP_CONSUMER_PATTERNS = [
  /\brequire\s*\(\s*(['"`])([^'"`\n]*sealed-export[^'"`\n]*)\1/,
  /\bimport\s*\(\s*(['"`])([^'"`\n]*sealed-export[^'"`\n]*)\1/,
  /\bfrom\s+(['"`])([^'"`\n]*sealed-export[^'"`\n]*)\1/,
  /\bimport\s+(['"`])([^'"`\n]*sealed-export[^'"`\n]*)\1/,
  /\bjoin\s*\([^)\n]*(['"`])sealed-export\1/,
]

function sweepForSealedExportConsumers(roots, io) {
  const offenders = []
  const scannedByRoot = Object.create(null)

  const walk = (directory, rootLabel) => {
    let entries
    try {
      entries = io.readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      return
    }
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (SWEEP_SKIP_DIRECTORIES.has(entry.name)) continue
        walk(full, rootLabel)
        continue
      }
      if (!SWEEP_SOURCE_FILE.test(entry.name)) continue
      if (SWEEP_TEST_FILE.test(entry.name)) continue
      scannedByRoot[rootLabel] = (scannedByRoot[rootLabel] || 0) + 1
      const text = io.readFileSync(full, 'utf8')
      for (let p = 0; p < SWEEP_CONSUMER_PATTERNS.length; p += 1) {
        if (SWEEP_CONSUMER_PATTERNS[p].test(text)) { offenders.push(full); break }
      }
    }
  }

  for (let index = 0; index < roots.length; index += 1) walk(roots[index].path, roots[index].label)
  return { offenders: offenders.sort(), scannedByRoot }
}

// A directory tree held in memory, exposing just the two calls the sweep makes.
function inMemoryFilesystem(files) {
  const names = Object.keys(files)
  const dirent = (name, isDirectory) => ({ name, isDirectory: () => isDirectory })
  return {
    readdirSync(directory) {
      const prefix = directory.endsWith(path.sep) ? directory : directory + path.sep
      const seen = new Map()
      for (let index = 0; index < names.length; index += 1) {
        if (names[index].indexOf(prefix) !== 0) continue
        const rest = names[index].slice(prefix.length)
        const cut = rest.indexOf(path.sep)
        if (cut < 0) seen.set(rest, false)
        else if (!seen.has(rest.slice(0, cut))) seen.set(rest.slice(0, cut), true)
      }
      if (seen.size === 0) throw new Error('ENOENT ' + directory)
      return Array.from(seen.entries()).map(([name, isDirectory]) => dirent(name, isDirectory))
    },
    readFileSync(file) {
      if (!Object.prototype.hasOwnProperty.call(files, file)) throw new Error('ENOENT ' + file)
      return files[file]
    },
  }
}

function controlledConsumerSweep() {
  const repoRoot = path.join(__dirname, '..', '..', '..')
  const roots = [
    { label: 'apps', path: path.join(repoRoot, 'apps') },
    { label: 'packages', path: path.join(repoRoot, 'packages') },
    { label: 'plugins', path: path.join(repoRoot, 'plugins') },
  ]
  // Fail closed on a mis-derived root: a wrong repoRoot would silently sweep nothing.
  for (let index = 0; index < roots.length; index += 1) {
    assert.ok(fs.existsSync(roots[index].path), 'sweep root must exist: ' + roots[index].label)
  }

  const real = sweepForSealedExportConsumers(roots, fs)
  for (let index = 0; index < roots.length; index += 1) {
    const label = roots[index].label
    assert.ok((real.scannedByRoot[label] || 0) > 50,
      'sweep must traverse ' + label + ', scanned=' + (real.scannedByRoot[label] || 0))
  }
  assert.deepEqual(
    real.offenders.map((f) => path.relative(repoRoot, f)),
    [
      'plugins/plugin-integration-core/index.cjs',
      'plugins/plugin-integration-core/lib/stock-preparation-sealed-snapshot-decoder.cjs',
      'plugins/plugin-integration-core/scripts/provision-stock-preparation-sqlserver-sealed-snapshot.cjs',
    ],
    'only the three S6-A controlled consumers may import sealed-export modules',
  )

  // POSITIVE CONTROL — CROSS-PACKAGE DETECTION. A synthetic consumer in a DIFFERENT
  // package must make the sweep RED and must be NAMED. Without this the assertion above
  // proves traversal only; nothing would ever have been fed to the predicate.
  const syntheticRoot = path.join(path.sep, 'sx-synthetic', 'packages')
  const consumerFile = path.join(syntheticRoot, 'core-backend', 'src', 'sx-consumer.cjs')
  const mentionFile = path.join(syntheticRoot, 'core-backend', 'src', 'sx-mention.cjs')
  const esmFile = path.join(syntheticRoot, 'other-package', 'src', 'sx-esm.ts')
  const skippedTestFile = path.join(syntheticRoot, 'core-backend', 'src', 'sx-consumer.spec.ts')
  const io = inMemoryFilesystem({
    [consumerFile]: "const c = require('../../../plugins/plugin-integration-core/lib/sealed-export/contracts.cjs')\n",
    [mentionFile]: '// mentions sealed-export in prose only; not a consumer\nmodule.exports = {}\n',
    [esmFile]: "import { x } from '../../plugins/plugin-integration-core/lib/sealed-export/lifecycle.cjs'\n",
    [skippedTestFile]: "require('../lib/sealed-export/contracts.cjs')\n",
  })
  const control = sweepForSealedExportConsumers([{ label: 'synthetic', path: syntheticRoot }], io)
  assert.deepEqual(control.offenders, [consumerFile, esmFile].sort(),
    'the sweep must NAME a cross-package consumer, in both require and ESM syntax')
  assert.equal(control.scannedByRoot.synthetic, 3, 'the .spec file is excluded from the sweep')
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

  // The `!descriptor.enumerable` token of buildSafeDetails needs its OWN discriminating
  // pair. The accessor case above does not supply one: a getter has no `descriptor.value`,
  // so the value-domain guard refuses it whatever the enumerability check does — a sibling
  // door covering for this one. These two cases differ ONLY in `enumerable`, and both carry
  // the SAME already-accepted safe token, so nothing else can explain the difference.
  const nonEnumerable = {}
  Object.defineProperty(nonEnumerable, 'field', { value: 'totalRows', enumerable: false })
  const refusedNonEnumerable = throws(() => vocabulary.failSealedExport(
    'SEALED_EXPORT_MANIFEST_INVALID', nonEnumerable), 'non-enumerable own data property')
  assert.equal(refusedNonEnumerable.reason, 'SEALED_EXPORT_INTERNAL_ERROR',
    'a non-enumerable own data property must refuse the whole details object')
  assert.deepEqual(refusedNonEnumerable.details, {})

  const enumerableTwin = {}
  Object.defineProperty(enumerableTwin, 'field', { value: 'totalRows', enumerable: true })
  const acceptedTwin = throws(() => vocabulary.failSealedExport(
    'SEALED_EXPORT_MANIFEST_INVALID', enumerableTwin), 'enumerable own data property')
  assert.equal(acceptedTwin.reason, 'SEALED_EXPORT_MANIFEST_INVALID',
    'the SAME value with enumerable:true must be accepted')
  assert.deepEqual(acceptedTwin.details, { field: 'totalRows' })

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
  trustedErrorIdentityPin()
  latentSurfacePin()
  throwSiteInvariant()
  astThrowSiteScanHasNoBlindWindow()
  astScanMatchesBindingsNotNames()
  controlledConsumerSweep()
  undeclaredReasonIsNeverEchoed()
  detailsCarryNoCallerValues()
  safeTokenMirrorIsComplete()
  console.log('sealed-export-failure-vocabulary.test.cjs OK')
}

main()

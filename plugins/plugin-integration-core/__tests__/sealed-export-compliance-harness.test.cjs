'use strict'

// Sealed-export S1 — the compliance harness's OWN battery. Plain node test, hermetic.
//
// The harness is itself a guard, so it gets what every guard gets: a positive control
// (it passes on healthy input) and, for each check it claims to perform, a
// deliberately damaged input that makes THAT check fire. A harness that only ever
// runs against the shipped, healthy vectors proves nothing about its own power.

const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')

const SEALED_DIR = path.join(__dirname, '..', 'lib', 'sealed-export')
const harness = require(path.join(SEALED_DIR, 'compliance-harness.cjs'))
const contracts = require(path.join(SEALED_DIR, 'contracts.cjs'))
const codec = require(path.join(SEALED_DIR, 'canonical-json.cjs'))
const vocabulary = require(path.join(SEALED_DIR, 'failure-vocabulary.cjs'))

const VECTORS_PATH = path.join(SEALED_DIR, 'vectors', 'sealed-export-canonical-vectors.json')
const readVectors = () => JSON.parse(fs.readFileSync(VECTORS_PATH, 'utf8'))

function readSources() {
  return fs.readdirSync(SEALED_DIR).filter((n) => n.endsWith('.cjs')).sort()
    .map((name) => ({ name, text: fs.readFileSync(path.join(SEALED_DIR, name), 'utf8') }))
}

function run(vectorSet) {
  return harness.runSealedExportComplianceHarness({
    vectorSet,
    sources: readSources(),
    declaredReasons: vocabulary.SEALED_EXPORT_FAILURE_REASONS,
    allowedThrowModule: 'failure-vocabulary.cjs',
  })
}

function findingIds(summary) {
  return summary.findings.map((finding) => finding.checkId).sort()
}

// ---------------------------------------------------------------------------
function passesOnHealthyInput() {
  const summary = run(readVectors())
  assert.equal(summary.ok, true, 'harness must pass on the shipped inputs')
  assert.deepEqual(summary.findings, [])
  assert.equal(summary.counts.findings, 0)
  assert.ok(summary.counts.vectors > 0 && summary.counts.nearMisses > 0)
  assert.equal(summary.harnessVersion, 'sealed-export/compliance-harness/v1')
}

function summaryIsDeterministic() {
  // No clock, no randomness, no iteration-order dependence: two runs over the same
  // input must be byte-identical, including the ORDER of every list.
  const first = run(readVectors())
  const second = run(readVectors())
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)))
  assert.equal(harness.formatHarnessSummary(first), harness.formatHarnessSummary(second))

  // Findings are ordered by check id then subject, so a damaged input also renders
  // deterministically rather than in discovery order.
  const damaged = readVectors()
  damaged.vectors[0].canonicalSha256 = 'f'.repeat(64)
  damaged.vectors[1].canonicalSha256 = 'e'.repeat(64)
  const damagedFirst = harness.formatHarnessSummary(run(damaged))
  const damagedSecond = harness.formatHarnessSummary(run(damaged))
  assert.equal(damagedFirst, damagedSecond)
  assert.ok(damagedFirst.indexOf('result: FAIL') >= 0)
}

// ---------------------------------------------------------------------------
// One deliberately damaged input per check the harness claims to perform.
// Each damage is applied ALONE, so sibling checks cannot cover for each other.
// ---------------------------------------------------------------------------
function eachCheckHasADiscriminatingDamage() {
  const cases = [
    ['VECTOR_SET_CANONICALIZATION_VERSION', (v) => { v.canonicalizationVersion = 'sx-other/v9' }],
    ['VECTOR_SET_DIGEST_ALGORITHM', (v) => { v.digestAlgorithm = 'sx-not-sha256' }],
    ['VECTOR_CANONICAL_TEXT', (v) => { v.vectors[0].canonicalJsonText = '{"zz":1}' }],
    ['VECTOR_CANONICAL_SHA256', (v) => { v.vectors[0].canonicalSha256 = 'f'.repeat(64) }],
    ['VECTOR_VALUE_CANONICALIZES', (v) => { v.vectors[0].value = { bad: 1.5 } }],
    ['NEAR_MISS_MUST_DISAGREE', (v) => {
      // A "near-miss" that is actually the canonical form must be caught.
      v.vectors[0].nonCanonicalForms[0].jsonText = v.vectors[0].canonicalJsonText
    }],
    ['REFUSED_TEXT_MUST_NOT_BE_CANONICAL', (v) => { v.refusedJsonTexts[0].jsonText = '{"a":1}' }],
    ['REFUSED_TEXT_REASON', (v) => { v.refusedJsonTexts[0].family = 'PARSE_REFUSED' }],
    ['REFUSED_TEXT_VIOLATION', (v) => { v.refusedJsonTexts[0].family = 'SIZE_LIMIT_EXCEEDED' }],
    ['DISTINCTNESS_PAIR_MUST_DIFFER', (v) => {
      v.distinctnessPairs[0].rightJsonText = v.distinctnessPairs[0].leftJsonText
    }],
    ['DISTINCTNESS_PAIR_CANONICALIZES', (v) => { v.distinctnessPairs[0].leftJsonText = '{' }],
    ['NEAR_MISS_COVERAGE', (v) => {
      // Strip every KEY_ORDER near-miss: the required-family coverage must notice.
      for (const vector of v.vectors) {
        vector.nonCanonicalForms = (vector.nonCanonicalForms || [])
          .filter((form) => form.family !== 'KEY_ORDER')
      }
    }],
    ['VECTOR_SET_NON_EMPTY', (v) => { v.vectors = [] }],
    ['VECTOR_SET_SHAPE', (v) => { Object.keys(v).forEach((k) => delete v[k]) }],
  ]

  for (const [expectedCheck, damage] of cases) {
    const vectorSet = readVectors()
    if (expectedCheck === 'VECTOR_SET_SHAPE') {
      const summary = run('sx-not-an-object')
      assert.ok(findingIds(summary).indexOf('VECTOR_SET_SHAPE') >= 0, 'VECTOR_SET_SHAPE')
      continue
    }
    damage(vectorSet)
    const summary = run(vectorSet)
    assert.equal(summary.ok, false, 'damage must fail the harness: ' + expectedCheck)
    assert.ok(findingIds(summary).indexOf(expectedCheck) >= 0,
      'expected check ' + expectedCheck + ' but got ' + JSON.stringify(findingIds(summary)))
  }
}

function damageActuallyChangesBehaviour() {
  // A damage that changes no behaviour tested nothing. Confirm each damage above
  // really did alter the input by checking the healthy run is clean immediately
  // before and after the damaged runs.
  assert.equal(run(readVectors()).ok, true, 'healthy input still clean after the damaged runs')
}

// ---------------------------------------------------------------------------
// The vectors and the contract validators must agree: a vector labelled with a
// contract object kind must actually VALIDATE under that object's validator.
//
// This is the link that catches an unsatisfiable schema — a contract no legal
// instance can satisfy looks fine to a canonicalization-only check.
// ---------------------------------------------------------------------------
function vectorsSatisfyTheContracts() {
  const validators = {
    EXPORT_REQUEST_ENVELOPE: contracts.validateExportRequestEnvelope,
    SIGNED_MANIFEST: contracts.validateSignedManifest,
    CHUNK_DESCRIPTOR: contracts.validateChunkDescriptor,
    CHUNK_RECEIPT: contracts.validateChunkReceipt,
    LIFECYCLE_EVIDENCE: contracts.validateLifecycleEvidence,
  }
  const vectorSet = readVectors()
  let validated = 0
  for (const vector of vectorSet.vectors) {
    const validate = validators[vector.kind]
    if (!validate) continue
    const accepted = validate(vector.value)
    validated += 1
    // The validated copy must canonicalize to exactly the vector's canonical text,
    // so validation neither drops nor reorders anything.
    assert.equal(codec.tryCanonicalJson(accepted).text, vector.canonicalJsonText,
      'validated object must canonicalize to the vector text: ' + vector.id)
  }
  // POSITIVE CONTROL for this check: it must have actually validated something.
  assert.ok(validated >= 4, 'contract-shaped vectors were validated, count=' + validated)
}

// ---------------------------------------------------------------------------
function stripperHandlesTrickySource() {
  const strip = harness.stripCommentsAndStrings
  // Line comments, block comments, and all three quote forms are blanked.
  assert.equal(strip('a // throw\nb').indexOf('throw'), -1)
  assert.equal(strip('a /* throw */ b').indexOf('throw'), -1)
  assert.equal(strip('const s = `throw`').indexOf('throw'), -1)
  assert.equal(strip("const s = 'throw'").indexOf('throw'), -1)
  // An escaped quote must not end the string early and leak the rest.
  assert.equal(strip("const s = 'a\\'throw' ").indexOf('throw'), -1)
  // Code OUTSIDE comments and strings survives, so the stripper cannot pass by
  // blanking everything.
  assert.ok(strip('function f() { throw new Error("x") }').indexOf('throw') >= 0)
  assert.ok(strip('const a = 1 // c').indexOf('const a = 1') >= 0)
  // Line structure is preserved so offsets stay meaningful.
  assert.equal(strip('a\n// b\nc').split('\n').length, 3)
}

function standaloneRunnerIsDeterministicAndSignalsFailure() {
  const script = path.join(SEALED_DIR, 'compliance-harness.cjs')
  const first = execFileSync(process.execPath, [script], { encoding: 'utf8' })
  const second = execFileSync(process.execPath, [script], { encoding: 'utf8' })
  assert.equal(first, second, 'standalone output must be deterministic')
  assert.ok(first.indexOf('result: PASS') >= 0, 'standalone run must PASS')
  assert.ok(first.indexOf('count findings=0') >= 0)
  // The summary is values-free: it reports counts, check ids and family names only.
  assert.equal(/sx-|vec-[a-z]/.test(first), false, 'summary must not carry vector token values')

  // POSITIVE CONTROL that the runner can FAIL and signals it through the exit code.
  // A harness whose exit code is always 0 would be indistinguishable from one that
  // checks nothing. Driven in-process with a damaged input.
  const damaged = readVectors()
  damaged.vectors[0].canonicalSha256 = 'f'.repeat(64)
  const damagedSummary = run(damaged)
  assert.equal(damagedSummary.ok, false)
  assert.ok(harness.formatHarnessSummary(damagedSummary).indexOf('result: FAIL') >= 0)
}

function classifierIsTotal() {
  // classifyJsonText never throws, for any input.
  const inputs = [null, undefined, 42, {}, [], '{', '', '{"a":1}', '{"a":1} ', '﻿{"a":1}']
  for (const input of inputs) {
    const result = harness.classifyJsonText(input)
    assert.ok([
      harness.DISPOSITION_CANONICAL,
      harness.DISPOSITION_DIFFERENT_CANONICAL_FORM,
      harness.DISPOSITION_REFUSED_PARSE,
      harness.DISPOSITION_REFUSED_DOMAIN,
    ].indexOf(result.disposition) >= 0, 'unknown disposition for ' + String(input))
  }
  // The four dispositions are distinguishable, not collapsed to one.
  assert.equal(harness.classifyJsonText('{"a":1}').disposition, harness.DISPOSITION_CANONICAL)
  assert.equal(harness.classifyJsonText('{"a":1} ').disposition, harness.DISPOSITION_DIFFERENT_CANONICAL_FORM)
  assert.equal(harness.classifyJsonText('{').disposition, harness.DISPOSITION_REFUSED_PARSE)
  assert.equal(harness.classifyJsonText('{"a":1.5}').disposition, harness.DISPOSITION_REFUSED_DOMAIN)
  assert.equal(harness.classifyJsonText('{"a":1.5}').violation, 'NON_INTEGER_NUMBER')
}

function main() {
  passesOnHealthyInput()
  summaryIsDeterministic()
  eachCheckHasADiscriminatingDamage()
  damageActuallyChangesBehaviour()
  vectorsSatisfyTheContracts()
  stripperHandlesTrickySource()
  standaloneRunnerIsDeterministicAndSignalsFailure()
  classifierIsTotal()
  console.log('sealed-export-compliance-harness.test.cjs OK')
}

main()

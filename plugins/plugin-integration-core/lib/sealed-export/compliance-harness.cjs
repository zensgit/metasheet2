'use strict'

// Sealed-export S1 — hermetic compliance harness (issue #4636 deliverable 1).
//
// LATENT: no route, no scheduler, no source read, no storage write. The harness
// analyses supplied data and returns a summary; it advances nothing.
//
// HERMETIC, precisely:
//   - no network, no clock read, no randomness, no environment read;
//   - the exported functions are PURE over their arguments and touch no filesystem
//     at all — the vector set and the module source texts are PARAMETERS;
//   - only the standalone CLI at the bottom reads files, and only two kinds: the
//     vectors JSON and the sibling .cjs sources in this directory.
//
// The table-as-a-parameter discipline is deliberate and is the same one
// lifecycle.cjs uses for its reachability analysis: an engine that can only ever be
// run against the shipped (healthy) inputs proves nothing about its own power. Every
// check below is exercised against a deliberately damaged input in
// __tests__/sealed-export-compliance-harness.test.cjs.
//
// NO THROW. This module contains no `throw` statement, so failure-vocabulary.cjs
// remains the single throw site of lib/sealed-export/ (asserted mechanically by
// collectThrowSiteFindings, run over this file too). Every failure is a finding in
// the returned summary.

const canonicalCodec = require('./canonical-json.cjs')
const digests = require('./digests.cjs')

const SEALED_EXPORT_HARNESS_VERSION = 'sealed-export/compliance-harness/v1'

// Near-miss dispositions. A near-miss is pinned by DISAGREEMENT: it either denotes
// the same value through different bytes (DIFFERENT_CANONICAL_FORM) or it is refused
// (REFUSED_PARSE / REFUSED_DOMAIN). CANONICAL means the near-miss was ACCEPTED as
// canonical, which is always a failure.
const DISPOSITION_CANONICAL = 'CANONICAL'
const DISPOSITION_DIFFERENT_CANONICAL_FORM = 'DIFFERENT_CANONICAL_FORM'
const DISPOSITION_REFUSED_PARSE = 'REFUSED_PARSE'
const DISPOSITION_REFUSED_DOMAIN = 'REFUSED_DOMAIN'

// The five near-miss families #4636 requires the vector set to pin.
const REQUIRED_NEAR_MISS_COVERAGE = Object.freeze([
  'KEY_ORDER',
  'UNICODE_FORM',
  'NUMBER_FORM',
  'TRAILING_ZERO',
  'WHITESPACE',
])

function frozenFinding(checkId, subjectId, detail) {
  return Object.freeze({ checkId, subjectId, detail })
}

// ---------------------------------------------------------------------------
// Disposition of one candidate JSON text under the codec.
//
// Returns { disposition, violation, canonicalText }. `violation` is the codec's own
// refusal code for REFUSED_DOMAIN and null otherwise. A parse that threw is NOT a
// parse that came back clean: it becomes REFUSED_PARSE, never a silent pass.
// ---------------------------------------------------------------------------
function classifyJsonText(jsonText) {
  if (typeof jsonText !== 'string') {
    return Object.freeze({
      disposition: DISPOSITION_REFUSED_PARSE,
      violation: null,
      canonicalText: null,
    })
  }
  let parsed = null
  let parseFailed = false
  try {
    parsed = JSON.parse(jsonText)
  } catch (error) {
    parseFailed = true
  }
  if (parseFailed) {
    return Object.freeze({
      disposition: DISPOSITION_REFUSED_PARSE,
      violation: null,
      canonicalText: null,
    })
  }
  const canonical = canonicalCodec.tryCanonicalJson(parsed)
  if (!canonical.ok) {
    return Object.freeze({
      disposition: DISPOSITION_REFUSED_DOMAIN,
      violation: canonical.violation,
      canonicalText: null,
    })
  }
  return Object.freeze({
    disposition: canonical.text === jsonText
      ? DISPOSITION_CANONICAL
      : DISPOSITION_DIFFERENT_CANONICAL_FORM,
    violation: null,
    canonicalText: canonical.text,
  })
}

// ---------------------------------------------------------------------------
// Vector-set conformance.
// ---------------------------------------------------------------------------
function checkVectorSet(vectorSet) {
  const findings = []
  const dispositions = []
  const coverage = Object.create(null)
  for (let index = 0; index < REQUIRED_NEAR_MISS_COVERAGE.length; index += 1) {
    coverage[REQUIRED_NEAR_MISS_COVERAGE[index]] = 0
  }

  if (!canonicalCodec.__internals.isStrictPlainObject(vectorSet)) {
    findings.push(frozenFinding('VECTOR_SET_SHAPE', null, 'not a plain object'))
    return { findings, dispositions, coverage, vectorCount: 0, nearMissCount: 0 }
  }
  if (vectorSet.canonicalizationVersion !== canonicalCodec.SEALED_EXPORT_CANONICALIZATION_VERSION) {
    findings.push(frozenFinding('VECTOR_SET_CANONICALIZATION_VERSION', null, 'version disagreement'))
  }
  if (vectorSet.digestAlgorithm !== digests.SEALED_EXPORT_DIGEST_ALGORITHM) {
    findings.push(frozenFinding('VECTOR_SET_DIGEST_ALGORITHM', null, 'algorithm disagreement'))
  }

  const vectors = Array.isArray(vectorSet.vectors) ? vectorSet.vectors : []
  if (vectors.length === 0) {
    findings.push(frozenFinding('VECTOR_SET_NON_EMPTY', null, 'no vectors'))
  }

  let nearMissCount = 0
  for (let index = 0; index < vectors.length; index += 1) {
    const vector = vectors[index]
    const id = vector && typeof vector.id === 'string' ? vector.id : 'vector[' + index + ']'

    // 1. The declared canonical text is what the codec emits for the declared value.
    const canonical = canonicalCodec.tryCanonicalJson(vector.value)
    if (!canonical.ok) {
      findings.push(frozenFinding('VECTOR_VALUE_CANONICALIZES', id, canonical.violation))
      continue
    }
    if (canonical.text !== vector.canonicalJsonText) {
      findings.push(frozenFinding('VECTOR_CANONICAL_TEXT', id, 'codec output differs from vector'))
    }

    // 2. The declared digest is sha256 over exactly those canonical bytes.
    const digest = digests.digestBytes(canonical.bytes)
    if (!digest.ok) {
      findings.push(frozenFinding('VECTOR_DIGEST_COMPUTABLE', id, 'digest not computed'))
    } else if (digest.digest !== vector.canonicalSha256) {
      findings.push(frozenFinding('VECTOR_CANONICAL_SHA256', id, 'digest disagreement'))
    }

    // 3. The canonical text is itself recognised as canonical (round trip).
    if (!canonicalCodec.isCanonicalJsonText(vector.canonicalJsonText)) {
      findings.push(frozenFinding('VECTOR_TEXT_IS_CANONICAL', id, 'canonical text not recognised'))
    }

    // 4. Every near-miss disagrees, and the summary records HOW it disagrees.
    const nearMisses = Array.isArray(vector.nonCanonicalForms) ? vector.nonCanonicalForms : []
    for (let form = 0; form < nearMisses.length; form += 1) {
      const nearMiss = nearMisses[form]
      const nearMissId = nearMiss && typeof nearMiss.id === 'string'
        ? nearMiss.id
        : id + '#nonCanonical[' + form + ']'
      const classified = classifyJsonText(nearMiss.jsonText)
      nearMissCount += 1
      dispositions.push(Object.freeze({
        id: nearMissId,
        family: typeof nearMiss.family === 'string' ? nearMiss.family : null,
        disposition: classified.disposition,
        violation: classified.violation,
        normalizesToVector: classified.canonicalText === vector.canonicalJsonText,
      }))
      if (classified.disposition === DISPOSITION_CANONICAL) {
        findings.push(frozenFinding('NEAR_MISS_MUST_DISAGREE', nearMissId, 'accepted as canonical'))
      }
      // The bytes path must agree with the text path: a near-miss accepted as bytes
      // while refused as text would be a transport-dependent canonicality.
      if (canonicalCodec.isCanonicalJsonText(Buffer.from(String(nearMiss.jsonText), 'utf8'))) {
        findings.push(frozenFinding('NEAR_MISS_MUST_DISAGREE_AS_BYTES', nearMissId, 'accepted as bytes'))
      }
      if (typeof nearMiss.family === 'string' && coverage[nearMiss.family] !== undefined) {
        coverage[nearMiss.family] += 1
      }
      // "trailing zeros" is a number-formatting near-miss with its own required
      // coverage slot; it is recognised by shape, not by a family label.
      if (/(^|[^0-9])[0-9]+\.[0-9]*0([^0-9]|$)/.test(String(nearMiss.jsonText))) {
        coverage.TRAILING_ZERO += 1
      }
    }
  }

  // 5. Declared-refusal texts are refused, and refused for the declared reason.
  const refused = Array.isArray(vectorSet.refusedJsonTexts) ? vectorSet.refusedJsonTexts : []
  for (let index = 0; index < refused.length; index += 1) {
    const entry = refused[index]
    const id = entry && typeof entry.id === 'string' ? entry.id : 'refused[' + index + ']'
    const classified = classifyJsonText(entry.jsonText)
    dispositions.push(Object.freeze({
      id,
      family: typeof entry.family === 'string' ? entry.family : null,
      disposition: classified.disposition,
      violation: classified.violation,
      normalizesToVector: false,
    }))
    if (classified.disposition === DISPOSITION_CANONICAL) {
      findings.push(frozenFinding('REFUSED_TEXT_MUST_NOT_BE_CANONICAL', id, 'accepted as canonical'))
      continue
    }
    // A refusal for the WRONG reason is still a finding: "everything is refused"
    // must not be able to satisfy this check.
    const declaredFamily = entry && typeof entry.family === 'string' ? entry.family : null
    if (declaredFamily === 'PARSE_REFUSED' || declaredFamily === 'BOM') {
      if (classified.disposition !== DISPOSITION_REFUSED_PARSE) {
        findings.push(frozenFinding('REFUSED_TEXT_REASON', id, 'expected parse refusal'))
      }
    } else if (declaredFamily === 'NON_CANONICAL_BYTES') {
      // The text denotes a value this codec ACCEPTS; only its bytes are refused, by
      // the byte-equality rule. Kept distinct from a domain refusal so the two
      // refusal modes cannot cover for each other.
      if (classified.disposition !== DISPOSITION_DIFFERENT_CANONICAL_FORM) {
        findings.push(frozenFinding('REFUSED_TEXT_REASON', id, 'expected byte-level refusal'))
      }
    } else if (declaredFamily !== null) {
      if (classified.disposition !== DISPOSITION_REFUSED_DOMAIN) {
        findings.push(frozenFinding('REFUSED_TEXT_REASON', id, 'expected domain refusal'))
      } else if (classified.violation !== declaredFamily) {
        findings.push(frozenFinding('REFUSED_TEXT_VIOLATION', id, 'violation disagreement'))
      }
    }
  }

  // 6. Distinctness pairs: two texts the codec must NOT conflate.
  const pairs = Array.isArray(vectorSet.distinctnessPairs) ? vectorSet.distinctnessPairs : []
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index]
    const id = pair && typeof pair.id === 'string' ? pair.id : 'pair[' + index + ']'
    const left = classifyJsonText(pair.leftJsonText)
    const right = classifyJsonText(pair.rightJsonText)
    if (left.canonicalText === null || right.canonicalText === null) {
      findings.push(frozenFinding('DISTINCTNESS_PAIR_CANONICALIZES', id, 'side did not canonicalize'))
      continue
    }
    if (left.canonicalText === right.canonicalText) {
      findings.push(frozenFinding('DISTINCTNESS_PAIR_MUST_DIFFER', id, 'sides conflated'))
    }
    if (typeof pair.family === 'string' && coverage[pair.family] !== undefined) {
      coverage[pair.family] += 1
    }
  }

  // 7. Required near-miss family coverage.
  for (let index = 0; index < REQUIRED_NEAR_MISS_COVERAGE.length; index += 1) {
    const family = REQUIRED_NEAR_MISS_COVERAGE[index]
    if (coverage[family] === 0) {
      findings.push(frozenFinding('NEAR_MISS_COVERAGE', family, 'family not covered'))
    }
  }

  return { findings, dispositions, coverage, vectorCount: vectors.length, nearMissCount }
}

// ---------------------------------------------------------------------------
// Source-level throw-site invariant (§10: "implementation requires ... a
// source-level throw-site invariant").
//
// Sources are SUPPLIED, never read here, so the scanner can be pointed at synthetic
// source text whose defect is known — which is the only way to show the scanner has
// any power at all.
//
// Comments and string/template literals are blanked before the `throw` search so a
// `throw` inside a comment or a quoted example cannot mask a real one, and the
// vocabulary-literal search runs over the ORIGINAL text because the literals are
// exactly what it needs to read.
// ---------------------------------------------------------------------------
function stripCommentsAndStrings(source) {
  let out = ''
  let index = 0
  const length = source.length
  while (index < length) {
    const two = source.slice(index, index + 2)
    if (two === '//') {
      while (index < length && source[index] !== '\n') { out += ' '; index += 1 }
      continue
    }
    if (two === '/*') {
      while (index < length && source.slice(index, index + 2) !== '*/') {
        out += source[index] === '\n' ? '\n' : ' '
        index += 1
      }
      out += '  '
      index += 2
      continue
    }
    const quote = source[index]
    if (quote === '"' || quote === "'" || quote === '`') {
      out += ' '
      index += 1
      while (index < length && source[index] !== quote) {
        if (source[index] === '\\') { out += ' '; index += 1 }
        out += source[index] === '\n' ? '\n' : ' '
        index += 1
      }
      out += ' '
      index += 1
      continue
    }
    out += source[index]
    index += 1
  }
  return out
}

function collectThrowSiteFindings(sources, declaredReasons, allowedThrowModule) {
  const findings = []
  const reasonSet = new Set(Array.isArray(declaredReasons) ? declaredReasons : [])
  const reachedReasons = new Set()
  const dynamicReasonSites = new Set()
  const list = Array.isArray(sources) ? sources : []
  let throwSiteCount = 0

  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index]
    const name = entry && typeof entry.name === 'string' ? entry.name : 'source[' + index + ']'
    const text = entry && typeof entry.text === 'string' ? entry.text : ''

    const stripped = stripCommentsAndStrings(text)
    const throwMatches = stripped.match(/\bthrow\b/g)
    const throwCount = throwMatches === null ? 0 : throwMatches.length
    if (throwCount > 0) {
      throwSiteCount += throwCount
      if (name !== allowedThrowModule) {
        findings.push(frozenFinding('THROW_SITE_MODULE', name, 'throw outside the single throw site'))
      }
    }

    // Every domain reason handed to failSealedExport must be a vocabulary member.
    const reasonPattern = /failSealedExport\(\s*(['"])([^'"]*)\1/g
    let match = reasonPattern.exec(text)
    while (match !== null) {
      const reason = match[2]
      reachedReasons.add(reason)
      if (!reasonSet.has(reason)) {
        findings.push(frozenFinding('THROW_SITE_REASON_UNDECLARED', name, 'reason not in vocabulary'))
      }
      match = reasonPattern.exec(text)
    }

    // A non-literal reason argument cannot be checked by ANY source scan. Such sites
    // are therefore not silently tolerated and not banned either: they are ENUMERATED,
    // and the caller is obliged to pin the enumeration and to prove behaviourally that
    // each listed producer yields vocabulary members only. `function failSealedExport(`
    // is the declaration, not a call site, and is excluded.
    const declarationStripped = text.replace(/function\s+failSealedExport\s*\(/g, 'function __decl__(')
    const dynamicPattern = /failSealedExport\(\s*(?!['"])[A-Za-z_$]/g
    let dynamicMatch = dynamicPattern.exec(declarationStripped)
    while (dynamicMatch !== null) {
      dynamicReasonSites.add(name)
      dynamicMatch = dynamicPattern.exec(declarationStripped)
    }
  }

  return {
    findings,
    throwSiteCount,
    reachedReasons: Object.freeze(Array.from(reachedReasons).sort()),
    dynamicReasonSites: Object.freeze(Array.from(dynamicReasonSites).sort()),
  }
}

// ---------------------------------------------------------------------------
// The harness proper. Pure; returns a deterministic, frozen summary.
// ---------------------------------------------------------------------------
function runSealedExportComplianceHarness(input) {
  const request = canonicalCodec.__internals.isStrictPlainObject(input) ? input : {}
  const vectorResult = checkVectorSet(request.vectorSet)
  const throwResult = collectThrowSiteFindings(
    request.sources,
    request.declaredReasons,
    request.allowedThrowModule,
  )

  const findings = vectorResult.findings.concat(throwResult.findings)
  findings.sort((left, right) => {
    if (left.checkId !== right.checkId) return left.checkId < right.checkId ? -1 : 1
    const leftSubject = String(left.subjectId)
    const rightSubject = String(right.subjectId)
    if (leftSubject !== rightSubject) return leftSubject < rightSubject ? -1 : 1
    return 0
  })

  const dispositionCounts = Object.create(null)
  for (let index = 0; index < vectorResult.dispositions.length; index += 1) {
    const key = vectorResult.dispositions[index].disposition
    dispositionCounts[key] = (dispositionCounts[key] || 0) + 1
  }

  return Object.freeze({
    harnessVersion: SEALED_EXPORT_HARNESS_VERSION,
    ok: findings.length === 0,
    findings: Object.freeze(findings),
    counts: Object.freeze({
      vectors: vectorResult.vectorCount,
      nearMisses: vectorResult.nearMissCount,
      dispositions: vectorResult.dispositions.length,
      throwSites: throwResult.throwSiteCount,
      findings: findings.length,
    }),
    dispositionCounts: Object.freeze(dispositionCounts),
    dispositions: Object.freeze(vectorResult.dispositions.slice().sort((left, right) => (
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    ))),
    nearMissCoverage: Object.freeze(Object.assign(Object.create(null), vectorResult.coverage)),
    reachedReasons: throwResult.reachedReasons,
    dynamicReasonSites: throwResult.dynamicReasonSites,
  })
}

// A stable, value-free, line-oriented rendering. No timing, no ordering by chance.
function formatHarnessSummary(summary) {
  const lines = []
  lines.push('sealed-export compliance harness: ' + summary.harnessVersion)
  lines.push('result: ' + (summary.ok ? 'PASS' : 'FAIL'))
  const countKeys = Object.keys(summary.counts).sort()
  for (let index = 0; index < countKeys.length; index += 1) {
    lines.push('count ' + countKeys[index] + '=' + summary.counts[countKeys[index]])
  }
  const dispositionKeys = Object.keys(summary.dispositionCounts).sort()
  for (let index = 0; index < dispositionKeys.length; index += 1) {
    lines.push('disposition ' + dispositionKeys[index] + '=' + summary.dispositionCounts[dispositionKeys[index]])
  }
  const coverageKeys = Object.keys(summary.nearMissCoverage).sort()
  for (let index = 0; index < coverageKeys.length; index += 1) {
    lines.push('coverage ' + coverageKeys[index] + '=' + summary.nearMissCoverage[coverageKeys[index]])
  }
  for (let index = 0; index < summary.findings.length; index += 1) {
    const finding = summary.findings[index]
    lines.push('finding ' + finding.checkId + ' ' + String(finding.subjectId) + ' ' + finding.detail)
  }
  return lines.join('\n')
}

module.exports = {
  SEALED_EXPORT_HARNESS_VERSION,
  REQUIRED_NEAR_MISS_COVERAGE,
  DISPOSITION_CANONICAL,
  DISPOSITION_DIFFERENT_CANONICAL_FORM,
  DISPOSITION_REFUSED_PARSE,
  DISPOSITION_REFUSED_DOMAIN,
  classifyJsonText,
  stripCommentsAndStrings,
  collectThrowSiteFindings,
  runSealedExportComplianceHarness,
  formatHarnessSummary,
}

// ---------------------------------------------------------------------------
// Standalone runner. `node lib/sealed-export/compliance-harness.cjs`
// Reads only the vectors JSON and the sibling .cjs sources in this directory.
// ---------------------------------------------------------------------------
if (require.main === module) {
  const fs = require('node:fs')
  const path = require('node:path')
  const { SEALED_EXPORT_FAILURE_REASONS } = require('./failure-vocabulary.cjs')
  const here = __dirname
  const moduleNames = [
    'canonical-json.cjs',
    'compliance-harness.cjs',
    'contracts.cjs',
    'digests.cjs',
    'failure-vocabulary.cjs',
    'lifecycle.cjs',
  ]
  const sources = moduleNames.map((name) => ({
    name,
    text: fs.readFileSync(path.join(here, name), 'utf8'),
  }))
  const vectorSet = JSON.parse(
    fs.readFileSync(path.join(here, 'vectors', 'sealed-export-canonical-vectors.json'), 'utf8'),
  )
  const summary = runSealedExportComplianceHarness({
    vectorSet,
    sources,
    declaredReasons: SEALED_EXPORT_FAILURE_REASONS,
    allowedThrowModule: 'failure-vocabulary.cjs',
  })
  process.stdout.write(formatHarnessSummary(summary) + '\n')
  process.exitCode = summary.ok ? 0 : 1
}

'use strict'

// Sealed-export S1 — §10's "source-level throw-site invariant", implemented as a REAL
// PARSE over the TypeScript compiler's JavaScript parser.
//
// TEST-ONLY, deliberately. §10's throw-site rule is a property of the SOURCE TEXT, not
// of anything the shipped library does at runtime, so the scan lives under __tests__/
// and `lib/sealed-export/` acquires no TypeScript dependency. Nothing in `lib/` requires
// this file.
//
// WHY A PARSER AND NOT A HAND-WRITTEN STRIPPER. The previous implementation blanked
// comments and quoted strings with a character scanner and then searched for `\bthrow\b`.
// That scanner could not tell a regular-expression literal from division, so the very
// first `/.../` literal containing a quote character desynchronised it and everything
// after that line was blanked — including real code. A regex-literal case can be patched;
// the class cannot. A parser has no such window: a `throw` is a ThrowStatement node or it
// is not a throw at all.
//
// WHAT THIS PROVES, AND WHAT IT DOES NOT. This is a STATIC SOURCE assertion. It shows the
// source text is internally consistent — throw statements only in the allowed module, and
// every literal reason handed to failSealedExport is a declared vocabulary member. It is
// NOT a behaviour proof: that the runtime actually raises those reasons, and only those,
// is a separate class of test (see latentSurfacePin / undeclaredReasonIsNeverEchoed in
// sealed-export-failure-vocabulary.test.cjs, which drive the real functions).
//
// FAIL-CLOSED IS THE POINT. A scanner that returns "zero findings" when it could not read
// its input is worse than no scanner. Two doors enforce that here, and both are exercised
// by positive controls:
//   - a source that does not parse yields SOURCE_PARSE_FAILED (never an empty result);
//   - a parse result whose `parseDiagnostics` array is absent — a future compiler version
//     dropping the property, say — yields SOURCE_PARSE_UNVERIFIABLE, because "no
//     diagnostics visible" must never be read as "no diagnostics".
// A missing TypeScript module throws out of this require and reds the suite.

let ts
try {
  ts = require('typescript')
} catch (error) {
  throw new Error(
    'sealed-export source scan requires the TypeScript parser (root devDependency `typescript`); '
    + 'refusing to run a weaker scan: ' + String(error && error.message),
  )
}

const SEALED_EXPORT_SOURCE_SCAN_VERSION = 'sealed-export/source-scan/ast-v1'

const FAIL_SEALED_EXPORT = 'failSealedExport'

function frozenFinding(checkId, subjectId, detail) {
  return Object.freeze({ checkId, subjectId, detail })
}

function defaultParse(name, text) {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, /* setParentNodes */ false, ts.ScriptKind.JS)
}

// The callee is `failSealedExport(...)` or `something.failSealedExport(...)`.
function calleeName(node) {
  const callee = node.expression
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) return callee.name.text
  return null
}

// A reason argument is READABLE only when it is a plain string literal. A template with
// no substitutions is equally static and is accepted; anything else is dynamic.
function literalReasonOf(node) {
  if (node.arguments.length === 0) return null
  const first = node.arguments[0]
  if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) return first.text
  return null
}

/**
 * @param sources  [{ name, text }] — supplied, never read from disk here.
 * @param declaredReasons  the closed §10 vocabulary.
 * @param allowedThrowModule  the one module name permitted to contain a ThrowStatement.
 * @param parseOverride  optional (name, text) => SourceFile, for fail-closed controls.
 */
function scanSealedExportThrowSites(sources, declaredReasons, allowedThrowModule, parseOverride) {
  const parse = typeof parseOverride === 'function' ? parseOverride : defaultParse
  const findings = []
  const reasonSet = new Set(Array.isArray(declaredReasons) ? declaredReasons : [])
  const reachedReasons = new Set()
  const dynamicReasonSites = new Set()
  const list = Array.isArray(sources) ? sources : []
  let throwSiteCount = 0
  let parsedSources = 0

  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index]
    const name = entry && typeof entry.name === 'string' ? entry.name : 'source[' + index + ']'
    if (!entry || typeof entry.text !== 'string') {
      // No text is not clean source. Refuse rather than scan an empty string.
      findings.push(frozenFinding('SOURCE_UNREADABLE', name, 'no source text supplied'))
      continue
    }

    let sourceFile = null
    let parseThrew = false
    try {
      sourceFile = parse(name, entry.text)
    } catch (error) {
      parseThrew = true
    }
    if (parseThrew || sourceFile === null || typeof sourceFile !== 'object') {
      findings.push(frozenFinding('SOURCE_PARSE_FAILED', name, 'parser did not return a source file'))
      continue
    }
    if (!Array.isArray(sourceFile.parseDiagnostics)) {
      findings.push(frozenFinding('SOURCE_PARSE_UNVERIFIABLE', name, 'parse diagnostics not observable'))
      continue
    }
    if (sourceFile.parseDiagnostics.length > 0) {
      findings.push(frozenFinding('SOURCE_PARSE_FAILED', name, 'source did not parse cleanly'))
      continue
    }
    parsedSources += 1

    let throwCount = 0
    const walk = (node) => {
      if (ts.isThrowStatement(node)) throwCount += 1
      if (ts.isCallExpression(node) && calleeName(node) === FAIL_SEALED_EXPORT) {
        const reason = literalReasonOf(node)
        if (reason === null) {
          // Not readable by ANY source scan. Enumerated, not tolerated and not banned:
          // the caller is obliged to pin the enumeration and prove behaviourally that each
          // listed producer yields vocabulary members only.
          dynamicReasonSites.add(name)
        } else {
          reachedReasons.add(reason)
          if (!reasonSet.has(reason)) {
            findings.push(frozenFinding('THROW_SITE_REASON_UNDECLARED', name, 'reason not in vocabulary'))
          }
        }
      }
      node.forEachChild(walk)
    }
    sourceFile.forEachChild(walk)

    if (throwCount > 0) {
      throwSiteCount += throwCount
      if (name !== allowedThrowModule) {
        findings.push(frozenFinding('THROW_SITE_MODULE', name, 'throw outside the single throw site'))
      }
    }
  }

  return Object.freeze({
    scanVersion: SEALED_EXPORT_SOURCE_SCAN_VERSION,
    findings: Object.freeze(findings),
    throwSiteCount,
    parsedSources,
    reachedReasons: Object.freeze(Array.from(reachedReasons).sort()),
    dynamicReasonSites: Object.freeze(Array.from(dynamicReasonSites).sort()),
  })
}

module.exports = {
  SEALED_EXPORT_SOURCE_SCAN_VERSION,
  scanSealedExportThrowSites,
}

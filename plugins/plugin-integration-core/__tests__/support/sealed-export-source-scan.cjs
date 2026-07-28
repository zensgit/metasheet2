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
// That scanner could not tell a regular-expression literal from division, so a `/.../`
// literal containing a quote character desynchronised it and opened a BLIND WINDOW —
// bounded, not unbounded: the scanner re-synchronised at a later quote, so the damage ran
// from the offending literal to that point, and real code inside the window was blanked.
// RETRACTION: an earlier version of this comment said "everything after that line was
// blanked", which overstates a bounded window as a permanent desynchronisation. A
// regex-literal case can be patched; the class cannot. A parser has no such window: a
// `throw` is a ThrowStatement node or it is not a throw at all.
//
// WHY BINDINGS AND NOT CALL NAMES. Owner post-merge finding (2026-07-27): matching a call
// by the name written at the call site is the same non-converging mistake one level up.
// `const { failSealedExport: fail } = ...; fail('NOT_DECLARED')` and
// `v['failSealedExport']('NOT_DECLARED')` both produced ZERO findings. The scan now
// RESOLVES the binding — every local name bound to failSealedExport by a declaration, an
// assignment, an import or a transitive alias — and matches those names. Any call shape
// whose callee cannot be resolved statically (a computed member, a callee that is itself
// a call) is a LOUD finding, because silence on an unreadable shape is indistinguishable
// from a clean result.
//
// WHAT THIS PROVES, AND WHAT IT DOES NOT. This is a STATIC SOURCE assertion. It shows the
// source text is internally consistent — throw statements only in the allowed module, and
// every literal reason handed to failSealedExport is a declared vocabulary member. It is
// NOT a behaviour proof: that the runtime actually raises those reasons, and only those,
// is a separate class of test (see latentSurfacePin / undeclaredReasonIsNeverEchoed in
// sealed-export-failure-vocabulary.test.cjs, which drive the real functions).
//
// RESOLUTION LIMIT, stated rather than hidden: this is a syntactic binding resolver, not a
// type-checked dataflow analysis. A binding that ESCAPES — handed to a function, returned,
// or stored in an object — cannot be followed to its call site by any such resolver, so
// escapes are reported as THROW_SITE_BINDING_ESCAPES in every module except the one that
// declares the function (which necessarily exports it).
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

const SEALED_EXPORT_SOURCE_SCAN_VERSION = 'sealed-export/source-scan/ast-binding-v2'

const FAIL_SEALED_EXPORT = 'failSealedExport'

function frozenFinding(checkId, subjectId, detail) {
  return Object.freeze({ checkId, subjectId, detail })
}

function defaultParse(name, text) {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, /* setParentNodes */ false, ts.ScriptKind.JS)
}

// Parent pointers are NOT requested from the parser (a parseOverride may return anything),
// so the parent is threaded explicitly by the walker.
function walkWithParent(node, parent, visit) {
  visit(node, parent)
  node.forEachChild((child) => walkWithParent(child, node, visit))
}

// Strip parentheses / `as T` / `<T>x` / `x!` so `(fail)('X')` still resolves to `fail`.
function unwrap(node) {
  let current = node
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression
    else if (ts.isAsExpression && ts.isAsExpression(current)) current = current.expression
    else if (ts.isNonNullExpression(current)) current = current.expression
    else if (ts.isTypeAssertionExpression && ts.isTypeAssertionExpression(current)) current = current.expression
    else return current
  }
}

function staticStringOf(node) {
  if (node === undefined || node === null) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return null
}

// The member name a `<expr>.name` / `<expr>['name']` reads, when it is static.
// Returns { kind: 'static', name } | { kind: 'dynamic' } | { kind: 'none' }.
function staticMemberRead(node) {
  const expression = unwrap(node)
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) {
    return { kind: 'static', name: expression.name.text }
  }
  if (ts.isElementAccessExpression(expression)) {
    const literal = staticStringOf(expression.argumentExpression)
    if (literal !== null) return { kind: 'static', name: literal }
    return { kind: 'dynamic' }
  }
  return { kind: 'none' }
}

// A callee is RESOLVABLE when its identity can be read from the syntax alone.
// Returns { resolvable: true, name } | { resolvable: true, name: null } | { resolvable: false }.
//   - name is the callee's identifier or static member name;
//   - name === null means "a callee that is statically known NOT to be a named binding",
//     i.e. a function/arrow literal invoked in place, or `super(...)` / `import(...)`.
function resolveCallee(node) {
  const callee = unwrap(node.expression)
  if (ts.isIdentifier(callee)) return { resolvable: true, name: callee.text }
  if (callee.kind === ts.SyntaxKind.SuperKeyword || callee.kind === ts.SyntaxKind.ImportKeyword) {
    return { resolvable: true, name: null }
  }
  if (ts.isFunctionExpression(callee) || ts.isArrowFunction(callee)) {
    return { resolvable: true, name: null }
  }
  const member = staticMemberRead(callee)
  if (member.kind === 'static') return { resolvable: true, name: member.name }
  return { resolvable: false }
}

// A reason argument is READABLE only when it is a plain string literal. A template with
// no substitutions is equally static and is accepted; anything else is dynamic.
function literalReasonOf(node) {
  if (node.arguments.length === 0) return null
  return staticStringOf(node.arguments[0])
}

// Every local name bound to failSealedExport in this source, renames and transitive
// aliases included. Iterated to a fixed point so declaration order does not matter.
// `unresolvedBindings` collects binding forms that cannot be read statically.
function collectFailBindings(sourceFile, unresolvedBindings) {
  const bound = new Set([FAIL_SEALED_EXPORT])
  const namespaces = collectVocabularyNamespaces(sourceFile)
  let changed = true
  let rounds = 0
  while (changed && rounds < 16) {
    changed = false
    rounds += 1
    walkWithParent(sourceFile, null, (node) => {
      // (a) import { failSealedExport as fail } from '...'
      if (ts.isImportSpecifier(node)) {
        const source = node.propertyName ? node.propertyName.text : node.name.text
        if (source === FAIL_SEALED_EXPORT && !bound.has(node.name.text)) {
          bound.add(node.name.text)
          changed = true
        }
        return
      }
      // (b) const { failSealedExport: fail } = <expr>
      if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
        if (node.propertyName && ts.isComputedPropertyName(node.propertyName)) {
          unresolvedBindings.add('computed destructuring key')
          return
        }
        const source = node.propertyName && !ts.isComputedPropertyName(node.propertyName)
          ? node.propertyName.text
          : node.name.text
        if (source === FAIL_SEALED_EXPORT && !bound.has(node.name.text)) {
          bound.add(node.name.text)
          changed = true
        }
        return
      }
      // (c) const fail = <expr>.failSealedExport   /   const fail = <bound name>
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (bindsFailSealedExport(node.initializer, bound, unresolvedBindings, namespaces)
          && !bound.has(node.name.text)) {
          bound.add(node.name.text)
          changed = true
        }
        return
      }
      // (d) fail = <expr>.failSealedExport  (assignment, not declaration)
      if (ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(unwrap(node.left))) {
        const target = unwrap(node.left)
        if (bindsFailSealedExport(node.right, bound, unresolvedBindings, namespaces) && !bound.has(target.text)) {
          bound.add(target.text)
          changed = true
        }
      }
    })
  }
  return bound
}

function bindsFailSealedExport(initializer, bound, unresolvedBindings, namespaces) {
  const init = unwrap(initializer)
  if (ts.isIdentifier(init)) return bound.has(init.text)
  const member = staticMemberRead(init)
  if (member.kind === 'static') return member.name === FAIL_SEALED_EXPORT
  if (member.kind === 'dynamic') {
    // `const fail = v[k]` where `v` is the vocabulary module cannot be read, and could be
    // failSealedExport. Recorded so it cannot pass as "not a binding".
    //
    // Deliberately NOT reported for an arbitrary receiver: `bytes[index]` is an array
    // read, and flagging every computed read would drown the scan in noise and make its
    // findings worthless. The receiver must resolve to the vocabulary module itself.
    const receiver = unwrap(init.expression)
    if (ts.isIdentifier(receiver) && namespaces.has(receiver.text)) {
      unresolvedBindings.add('computed member alias on the vocabulary module')
    }
  }
  return false
}

// Identifiers bound to the vocabulary module as a whole: `const v = require('…')`,
// `import * as v from '…'`. The specifier is matched by module basename, not by path.
function collectVocabularyNamespaces(sourceFile) {
  const namespaces = new Set()
  const isVocabularySpecifier = (node) => {
    const literal = staticStringOf(node)
    return literal !== null && literal.indexOf('failure-vocabulary') >= 0
  }
  walkWithParent(sourceFile, null, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrap(node.initializer)
      if (ts.isCallExpression(init)
        && ts.isIdentifier(unwrap(init.expression))
        && unwrap(init.expression).text === 'require'
        && isVocabularySpecifier(init.arguments[0])) {
        namespaces.add(node.name.text)
      }
    }
    if (ts.isNamespaceImport(node)) namespaces.add(node.name.text)
  })
  return namespaces
}

// A bound name used anywhere other than as a callee, a declaration/binding name, a member
// NAME, or the right-hand side of an alias, has escaped this resolver's reach.
function isTrackedUse(node, parent, bound) {
  if (parent === null) return true
  if (ts.isCallExpression(parent) && unwrap(parent.expression) === node) return true
  if (ts.isVariableDeclaration(parent)) return true
  if (ts.isBindingElement(parent)) return true
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent)) return true
  if (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)) return true
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true
  if (ts.isBinaryExpression(parent)
    && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    // Either side of an alias assignment is tracked; the left side is added to `bound`.
    return ts.isIdentifier(unwrap(parent.left)) ? bound.has(unwrap(parent.left).text) : false
  }
  return false
}

function declaresFailSealedExport(sourceFile) {
  let declares = false
  walkWithParent(sourceFile, null, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text === FAIL_SEALED_EXPORT) {
      declares = true
    }
  })
  return declares
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
    if (typeof sourceFile.forEachChild !== 'function') {
      findings.push(frozenFinding('SOURCE_PARSE_UNVERIFIABLE', name, 'source file is not walkable'))
      continue
    }
    parsedSources += 1

    const unresolvedBindings = new Set()
    const bound = collectFailBindings(sourceFile, unresolvedBindings)
    for (const detail of unresolvedBindings) {
      findings.push(frozenFinding('THROW_SITE_BINDING_UNRESOLVABLE', name, detail))
    }
    // The declaring module necessarily exports the function by value; every other module
    // that lets a bound name escape puts it beyond this resolver's reach.
    const isDeclaringModule = declaresFailSealedExport(sourceFile)

    let throwCount = 0
    const seenUnresolvableCallee = new Set()
    const seenEscape = new Set()
    walkWithParent(sourceFile, null, (node, parent) => {
      if (ts.isThrowStatement(node)) throwCount += 1

      if (ts.isIdentifier(node) && bound.has(node.text) && !isDeclaringModule
        && !isTrackedUse(node, parent, bound)) {
        seenEscape.add(node.text)
      }

      if (!ts.isCallExpression(node)) return
      const callee = resolveCallee(node)
      if (!callee.resolvable) {
        // Not readable by ANY static scan. Reported, never skipped: a callee this scan
        // cannot read could be failSealedExport, and silence would look identical to clean.
        seenUnresolvableCallee.add(node.getStart(sourceFile))
        return
      }
      if (callee.name === null || !bound.has(callee.name)) return

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
    })

    for (let count = 0; count < seenUnresolvableCallee.size; count += 1) {
      findings.push(frozenFinding('THROW_SITE_CALLEE_UNRESOLVABLE', name, 'callee not statically readable'))
    }
    for (const escaped of seenEscape) {
      findings.push(frozenFinding('THROW_SITE_BINDING_ESCAPES', name, 'bound name used as a value'))
    }

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

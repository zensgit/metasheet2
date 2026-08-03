'use strict'

// Member-read scan over a REAL PARSE of a CommonJS module's source.
//
// TEST-ONLY, deliberately — the same reasoning as support/sealed-export-source-scan.cjs.
// What this scan asserts is a property of the SOURCE TEXT, not of anything the shipped
// library does at runtime, so it lives under __tests__/ and `lib/sealed-export/` acquires
// no TypeScript dependency. Nothing in `lib/` requires this file.
//
// WHY A PARSER AND NOT A BRACE COUNTER. The scan this replaces extracted a function body
// by counting `{` / `}` over the raw source. That counter is not comment-aware or
// string-aware, so a single comment carrying an unbalanced brace —
//
//     // the closing } of the config block above
//
// — truncated the extracted body there, and EVERYTHING AFTER IT BECAME UNPINNED. Proven by
// execution, not argued: with that comment inserted, a live `system['name']` read added
// below it left the suite GREEN, and so did the dotted `system.name` form, which means the
// truncation also defeated the pre-existing dotted read-set assertion. Making the counter
// cleverer is the non-converging move this repository has already paid for twice (a
// hand-written comment/string stripper defeated first by a regex literal, then by template
// interpolation and regex-vs-division). A parse has no such window: a member read is a
// PropertyAccessExpression / ElementAccessExpression node or it is not a member read.
//
// FAIL-CLOSED IS THE POINT, and it is structural here rather than by convention. A scanner
// that reports "zero findings" when it could not read its input is worse than no scanner,
// and a caller can forget to check a `failures` array. So when this scan cannot read its
// input it sets `functions` and `occurrences` to NULL, not to an empty object: a consumer
// that skips the failure check crashes on property access instead of silently reading an
// empty read set and passing. Four doors, each exercised by a control in the calling test:
//   - the parser throws, or returns a non-object          -> SOURCE_PARSE_FAILED
//   - `parseDiagnostics` is not an array                  -> SOURCE_PARSE_UNVERIFIABLE
//       ("no diagnostics visible" must never read as "no diagnostics")
//   - `parseDiagnostics` is non-empty                     -> SOURCE_PARSE_FAILED
//   - the result is not walkable                          -> SOURCE_PARSE_UNVERIFIABLE
// A missing TypeScript module throws out of this require and reds the suite.
//
// RESOLUTION LIMIT, and how it is closed rather than hidden. Receivers are resolved
// SYNTACTICALLY: a member access is attributed to a receiver only when the receiver
// expression unwraps to a plain Identifier, so `system.config[KEY]` is attributed to
// `system.config` and not to `system` — which is correct, and is why the pinned direct-read
// set stays exact. But that leaves a read-set assertion alone incomplete: an access whose
// receiver does not bottom out in an Identifier (`(cond ? system : other)['name']`) is
// attributed to nobody and would be invisible.
//
// A blanket "unreadable receiver" finding does NOT close that — ordinary method chains
// (`crypto.createHmac(k).update(x).digest('hex')`, `[...fields].sort()`) have unreadable
// receivers too, and flagging them drowns the scan in false positives, which is how a
// scanner becomes something people delete.
//
// It is closed instead by `occurrences`: EVERY syntactic occurrence of an identifier is
// classified, and the caller pins the exact multiset. A receiver that only ever appears as
// `property-access-receiver` / `element-access-receiver` has a read set that is complete by
// construction — there is no other syntax through which a member of it could be reached.
// Banning read FORMS one at a time does not converge (`const { name } = record`,
// `{ ...record }`, `JSON.stringify(record)`, `for (const k in record)`); pinning the use
// multiset does, because anything unanticipated lands as an unrecognised descriptor.

let ts
try {
  ts = require('typescript')
} catch (error) {
  throw new Error(
    'sealed-export member-read scan requires the TypeScript parser (root devDependency '
    + '`typescript`); refusing to run a weaker scan: ' + String(error && error.message),
  )
}

const SEALED_EXPORT_MEMBER_READ_SCAN_VERSION = 'sealed-export/member-read-scan/ast-v1'

function frozenFailure(checkId, subjectId, detail) {
  return Object.freeze({ checkId, subjectId, detail })
}

function defaultParse(name, text) {
  return ts.createSourceFile(
    name,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.JS,
  )
}

// Parent pointers are NOT requested from the parser (a parseOverride may return anything),
// so parent and ancestors are threaded explicitly by the walker. `ancestors` is reused
// across visits — copy it if you need to keep it.
function walkWithParent(node, parent, visit, ancestors = []) {
  visit(node, parent, ancestors)
  ancestors.push(node)
  node.forEachChild((child) => walkWithParent(child, node, visit, ancestors))
  ancestors.pop()
}

// Strip parentheses / `as T` / `<T>x` / `x!` so `(system)['name']` still resolves to `system`.
function unwrap(node) {
  let current = node
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression
    else if (ts.isAsExpression && ts.isAsExpression(current)) current = current.expression
    else if (ts.isNonNullExpression(current)) current = current.expression
    else if (ts.isTypeAssertionExpression && ts.isTypeAssertionExpression(current)) {
      current = current.expression
    } else return current
  }
}

function staticStringOf(node) {
  if (node === undefined || node === null) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isNumericLiteral(node)) return node.text
  return null
}

// The identifier a member access is taken DIRECTLY off, when that is statically readable.
function receiverIdentifierOf(expression) {
  const receiver = unwrap(expression)
  return ts.isIdentifier(receiver) ? receiver.text : null
}

// The identifier a whole member CHAIN bottoms out in. Used only to tell an access whose
// receiver is another member access (readable, attributed elsewhere) from one whose
// receiver cannot be read at all (reported).
function rootIdentifierOf(expression) {
  let current = unwrap(expression)
  for (;;) {
    if (ts.isIdentifier(current)) return current.text
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = unwrap(current.expression)
      continue
    }
    return null
  }
}

// The statically readable dotted path of a callee, or null.
function calleeTextOf(expression) {
  const callee = unwrap(expression)
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
    const prefix = calleeTextOf(callee.expression)
    return prefix === null ? null : prefix + '.' + callee.name.text
  }
  if (ts.isElementAccessExpression(callee)) {
    const literal = staticStringOf(callee.argumentExpression)
    if (literal === null) return null
    const prefix = calleeTextOf(callee.expression)
    return prefix === null ? null : prefix + '.' + literal
  }
  return null
}

function memberAccessOf(node) {
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
    return Object.freeze({
      receiver: receiverIdentifierOf(node.expression),
      root: rootIdentifierOf(node.expression),
      kind: 'static',
      member: node.name.text,
      keyIdentifier: null,
    })
  }
  if (ts.isElementAccessExpression(node)) {
    const literal = staticStringOf(node.argumentExpression)
    const key = unwrap(node.argumentExpression)
    return Object.freeze({
      receiver: receiverIdentifierOf(node.expression),
      root: rootIdentifierOf(node.expression),
      // A string-literal computed key names a member exactly as a dotted access does, so it
      // is folded into the STATIC read set. `system['projectId']` is drift, not a syntax
      // question, and pinning it as drift is what makes the read-set assertion complete.
      kind: literal === null ? 'dynamic' : 'static',
      member: literal,
      keyIdentifier: literal === null && ts.isIdentifier(key) ? key.text : null,
    })
  }
  return null
}

function functionNameOf(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) {
    return node.name.text
  }
  return null
}

function parameterNamesOf(node) {
  const names = []
  for (const parameter of node.parameters || []) {
    if (ts.isIdentifier(parameter.name)) names.push(parameter.name.text)
    else if (ts.isObjectBindingPattern(parameter.name)) {
      for (const element of parameter.name.elements) {
        if (ts.isIdentifier(element.name)) names.push('{' + element.name.text + '}')
      }
    } else names.push('<pattern>')
  }
  return names
}

// Everything the pins need about ONE function, computed over its BODY only — the parameter
// list is reported separately, so a parameter name is never counted as a read of itself.
function analyzeFunctionBody(fn, name, failures, subjectId) {
  const memberAccesses = []
  const identifierCounts = Object.create(null)
  const calls = []
  const forOf = []
  if (!fn.body) {
    failures.push(frozenFailure('FUNCTION_BODY_ABSENT', subjectId, name))
    return null
  }
  walkWithParent(fn.body, null, (node) => {
    if (ts.isIdentifier(node)) {
      identifierCounts[node.text] = (identifierCounts[node.text] || 0) + 1
    }
    const access = memberAccessOf(node)
    if (access !== null) memberAccesses.push(access)
    if (ts.isCallExpression(node)) {
      calls.push(Object.freeze({
        callee: calleeTextOf(node.expression),
        argumentIdentifiers: Object.freeze(node.arguments.map((argument) => {
          const value = unwrap(argument)
          return ts.isIdentifier(value) ? value.text : null
        })),
        // Statically readable string arguments, `null` where an argument is computed. A
        // caller pinning a registry of literal call arguments MUST treat null as a finding
        // rather than skip it — an argument this scan cannot read could be anything.
        argumentLiterals: Object.freeze(node.arguments.map(
          (argument) => staticStringOf(unwrap(argument)),
        )),
      }))
    }
    if (ts.isForOfStatement(node)) {
      const initializer = node.initializer
      let bindingName = null
      if (ts.isVariableDeclarationList(initializer)
        && initializer.declarations.length === 1
        && ts.isIdentifier(initializer.declarations[0].name)) {
        bindingName = initializer.declarations[0].name.text
      }
      const iterable = unwrap(node.expression)
      forOf.push(Object.freeze({
        bindingName,
        iterableName: ts.isIdentifier(iterable) ? iterable.text : null,
      }))
    }
  })
  return Object.freeze({
    name,
    parameters: Object.freeze(parameterNamesOf(fn)),
    memberAccesses: Object.freeze(memberAccesses),
    identifierCounts: Object.freeze({ ...identifierCounts }),
    calls: Object.freeze(calls),
    forOf: Object.freeze(forOf),
  })
}

function enclosingFunctionName(ancestors) {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const name = functionNameOf(ancestors[index])
    if (name !== null) return name
  }
  return '<module>'
}

// Every syntactic occurrence of an identifier in the WHOLE file, each classified into a
// stable descriptor string. This is the shape a use ALLOWLIST is asserted against: banning
// the member-read forms one at a time does not converge (`const { name } = record`,
// `{ ...record }`, `JSON.stringify(record)`, `for (const k in record)` are all reads or
// enumerations that no member-access ban would see), so the calling test pins the exact
// multiset of uses instead and anything else — any other callee, any initializer, any
// spread, any destructuring target — falls out as an unrecognised descriptor.
function describeOccurrence(node, parent, ancestors) {
  const where = enclosingFunctionName(ancestors)
  if (parent === null) return 'root|' + where + '|'

  if (ts.isBindingElement(parent) && parent.name === node) {
    return 'binding-element|' + where + '|'
  }
  if (ts.isParameter(parent) && parent.name === node) return 'parameter|' + where + '|'
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return 'member-name|' + where + '|' + node.text
  }
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
    return 'property-access-receiver|' + where + '|' + (
      ts.isIdentifier(parent.name) ? parent.name.text : '?'
    )
  }
  if (ts.isElementAccessExpression(parent) && parent.expression === node) {
    const literal = staticStringOf(parent.argumentExpression)
    return 'element-access-receiver|' + where + '|' + (literal === null ? '<dynamic>' : literal)
  }
  if (ts.isCallExpression(parent) && parent.expression !== node) {
    const index = parent.arguments.indexOf(node)
    if (index >= 0) {
      const callee = calleeTextOf(parent.expression)
      return 'call-argument|' + where + '|' + (callee === null ? '<unreadable>' : callee)
        + '@' + index
    }
  }
  if (ts.isCallExpression(parent) && parent.expression === node) {
    return 'callee|' + where + '|' + node.text
  }
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
    // `f({ externalSystem })` — a value pass, which fires no accessor. Attributed to the
    // call it is an argument of, so the ALLOWLIST pins the callee rather than accepting
    // "shorthand property" in general.
    const literal = ancestors.length >= 2 ? ancestors[ancestors.length - 2] : null
    const call = ancestors.length >= 3 ? ancestors[ancestors.length - 3] : null
    if (literal !== null && ts.isObjectLiteralExpression(literal)
      && call !== null && ts.isCallExpression(call)) {
      const index = call.arguments.indexOf(literal)
      if (index >= 0) {
        const callee = calleeTextOf(call.expression)
        return 'shorthand-argument|' + where + '|'
          + (callee === null ? '<unreadable>' : callee) + '@' + index
      }
    }
    return 'shorthand-property|' + where + '|'
  }
  if (ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent)) {
    return 'spread|' + where + '|'
  }
  if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
    return 'variable-initializer|' + where + '|'
      + (ts.isIdentifier(parent.name) ? parent.name.text : '<pattern>')
  }
  if (ts.isVariableDeclaration(parent) && parent.name === node) {
    return 'variable-name|' + where + '|'
  }
  if (ts.isFunctionDeclaration(parent) && parent.name === node) {
    return 'function-name|' + where + '|'
  }
  if (ts.isForInStatement(parent) && parent.expression === node) {
    return 'for-in-subject|' + where + '|'
  }
  return 'other|' + where + '|' + ts.SyntaxKind[parent.kind]
}

/**
 * @param name           a label for the source, used in failure subjects.
 * @param text           the module source. Supplied, never read from disk here.
 * @param parseOverride  optional (name, text) => SourceFile, for fail-closed controls.
 */
function analyzeModuleSource({ name, text, parseOverride } = {}) {
  const parse = typeof parseOverride === 'function' ? parseOverride : defaultParse
  const subjectId = typeof name === 'string' ? name : '<unnamed>'
  const failures = []

  const unreadable = (checkId, detail) => Object.freeze({
    scanVersion: SEALED_EXPORT_MEMBER_READ_SCAN_VERSION,
    failures: Object.freeze([frozenFailure(checkId, subjectId, detail)]),
    // NOT an empty object. A consumer that forgets the failure check must crash, never read
    // an empty read set and pass.
    functions: null,
    occurrences: null,
  })

  if (typeof text !== 'string') {
    return unreadable('SOURCE_UNREADABLE', 'no source text supplied')
  }

  let sourceFile = null
  let parseThrew = false
  try {
    sourceFile = parse(subjectId, text)
  } catch (error) {
    parseThrew = true
  }
  if (parseThrew || sourceFile === null || typeof sourceFile !== 'object') {
    return unreadable('SOURCE_PARSE_FAILED', 'parser did not return a source file')
  }
  if (!Array.isArray(sourceFile.parseDiagnostics)) {
    return unreadable('SOURCE_PARSE_UNVERIFIABLE', 'parse diagnostics not observable')
  }
  if (sourceFile.parseDiagnostics.length > 0) {
    return unreadable('SOURCE_PARSE_FAILED', 'source did not parse cleanly')
  }
  if (typeof sourceFile.forEachChild !== 'function') {
    return unreadable('SOURCE_PARSE_UNVERIFIABLE', 'source file is not walkable')
  }

  const declarations = new Map()
  const duplicated = new Set()
  walkWithParent(sourceFile, null, (node) => {
    const fnName = functionNameOf(node)
    if (fnName === null || !ts.isFunctionDeclaration(node)) return
    if (declarations.has(fnName)) duplicated.add(fnName)
    else declarations.set(fnName, node)
  })
  for (const fnName of duplicated) {
    failures.push(frozenFailure('FUNCTION_NAME_AMBIGUOUS', subjectId, fnName))
  }

  const functions = Object.create(null)
  for (const [fnName, node] of declarations) {
    const info = analyzeFunctionBody(node, fnName, failures, subjectId)
    if (info !== null) functions[fnName] = info
  }

  const occurrences = Object.create(null)
  walkWithParent(sourceFile, null, (node, parent, ancestors) => {
    if (!ts.isIdentifier(node)) return
    const list = occurrences[node.text] || (occurrences[node.text] = [])
    list.push(describeOccurrence(node, parent, ancestors))
  })
  for (const key of Object.keys(occurrences)) {
    occurrences[key] = Object.freeze(occurrences[key].slice().sort())
  }

  if (failures.length > 0) {
    return Object.freeze({
      scanVersion: SEALED_EXPORT_MEMBER_READ_SCAN_VERSION,
      failures: Object.freeze(failures),
      functions: null,
      occurrences: null,
    })
  }
  return Object.freeze({
    scanVersion: SEALED_EXPORT_MEMBER_READ_SCAN_VERSION,
    failures: Object.freeze([]),
    functions: Object.freeze(functions),
    occurrences: Object.freeze(occurrences),
  })
}

// The direct reads a function takes off ONE receiver identifier.
//   static  — sorted member names, string-literal computed keys folded in
//   dynamic — computed keys that name no member statically (reported, never ignored)
function memberReadReport(functionInfo, receiver) {
  if (!functionInfo || !Array.isArray(functionInfo.memberAccesses)) {
    throw new Error('memberReadReport: no function info for receiver ' + receiver)
  }
  const staticMembers = new Set()
  const dynamic = []
  for (const access of functionInfo.memberAccesses) {
    if (access.receiver !== receiver) continue
    if (access.kind === 'static') staticMembers.add(access.member)
    else dynamic.push(access)
  }
  return Object.freeze({
    static: Object.freeze([...staticMembers].sort()),
    dynamic: Object.freeze(dynamic),
  })
}

// Occurrence descriptors for one identifier, optionally narrowed to one enclosing function.
// Throws rather than returning [] when the report could not be read or the identifier does
// not occur at all: an empty multiset must never be produced by a failed lookup, which is
// the same class of defect this whole scan exists to close.
function occurrencesOf(report, identifier, enclosing) {
  if (!report || report.occurrences === null) {
    throw new Error('occurrencesOf: report carries no occurrences (scan failed)')
  }
  const all = report.occurrences[identifier]
  if (all === undefined) {
    throw new Error('occurrencesOf: identifier never occurs in the source: ' + identifier)
  }
  if (enclosing === undefined) return all
  const scoped = all.filter((descriptor) => descriptor.split('|')[1] === enclosing)
  if (scoped.length === 0) {
    throw new Error(
      'occurrencesOf: identifier ' + identifier + ' never occurs in ' + enclosing,
    )
  }
  return Object.freeze(scoped)
}

module.exports = {
  SEALED_EXPORT_MEMBER_READ_SCAN_VERSION,
  analyzeModuleSource,
  memberReadReport,
  occurrencesOf,
}

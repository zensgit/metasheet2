'use strict'

// #4556 W4C-0 follow-up — owner ruling on the report-sync job control-plane writes.
//
// Resolves MODULE-LEVEL `const IDENT = <rhs>` bindings to literal table-name strings, for the
// dynamic (`${IDENT}` / `${IDENT.prop}`) DML-target form collector.cjs's DML_LINE_PATTERN cannot
// see at all (it only matches a bare/quoted identifier immediately after the verb, never `${`).
// The report-sync sites reach `plugin_attendance_report_sync_jobs` exactly this way:
//   const ATTENDANCE_REPORT_SYNC_JOB_TABLE = 'plugin_attendance_report_sync_jobs'
//   ... `INSERT INTO ${ATTENDANCE_REPORT_SYNC_JOB_TABLE} ...`
//
// Forms handled (documented, not inferred — a form not on this list is UNRESOLVABLE):
//   1. direct literal      const X = 'lit' | "lit" | `lit` (template with ZERO interpolations)
//   2. alias / re-export   const X = Y            (Y itself must resolve — chased transitively,
//                          cycle-guarded)
//   3. single-interpolation template
//                          const X = `${Y}suffix` | `prefix${Y}` | `prefix${Y}suffix`
//                          (exactly one ${...}; its inner expression must be a bare identifier
//                          that itself resolves)
//   4. object property     const X = { key: 'lit', other: 'lit2', ... }
//                          (only string-literal property values register; used via `X.key`)
//
// Forms explicitly NOT handled — a chain that bottoms out on one of these is UNRESOLVABLE, not
// "unknown treated as no table":
//   - function-call-derived value:      const X = getTableName()
//   - conditional/ternary value:        const X = cond ? 'a' : 'b'
//   - string concatenation:             const X = PREFIX + '_jobs'
//   - destructuring:                    const { X } = require(...)
//   - reassignment / let / var:         only a single top-level `const` counts
//   - multi-interpolation template:     const X = `${A}${B}`
//   - computed member access:           OBJ[key] where key is not a literal
//   - cross-file import/re-export:      resolution never crosses a require()/import boundary —
//     only bindings declared IN THE SAME FILE (module-level, column 0) are considered.
//
// Contract this module exists to enforce (the "must FAIL, not skip" requirement):
//   - `resolveModuleLevelConstantBindings` NEVER silently drops a module-level `const`
//     declaration from its result. Every one gets an entry, tagged either with a resolved shape
//     (`status: 'literal' | 'alias' | 'template' | 'object'`) or `status: 'unresolvable'` with a
//     `reason` and the raw RHS text. Nothing is silently omitted.
//   - `resolveIdentifierToTable` — the function callers use to turn one specific identifier
//     reference into a table name — THROWS `UnresolvableConstantBindingError` the instant the
//     chain it is following bottoms out at an unresolvable entry, a missing declaration, a
//     circular alias, or an unsupported `.prop` access. It never returns `null`/`undefined` for
//     "couldn't resolve" — a caller cannot accidentally treat a thrown failure as "not a table,
//     skip" by forgetting to check a falsy return value; it must explicitly catch (or let
//     propagate) the throw.

class UnresolvableConstantBindingError extends Error {
  constructor(identifier, reason) {
    super(`ATTENDANCE_W4C0_UNRESOLVABLE_CONSTANT_BINDING: ${identifier} (${reason})`)
    this.name = 'UnresolvableConstantBindingError'
    this.identifier = identifier
    this.reason = reason
  }
}

// Module-level only: `^(export )?const` with NO leading whitespace (the `m` flag anchors `^` to
// line starts). The optional `export` covers ESM script files (this repo's `scripts/ops/*.mjs`
// convention is `export const X = 'literal'`) — it is the SAME direct-literal/alias/etc. form,
// not a fifth binding shape; only the keyword prefix differs. A `const` declared inside a
// function body is indented and never matches this pattern at all. The `d` flag exposes
// per-group character offsets so the RHS capture's start index in the ORIGINAL string is exact,
// not reconstructed via a fragile indexOf.
const MODULE_LEVEL_CONST_PATTERN =
  /^(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(.+?)(?:\r?\n|$)/gmd

function stringLiteralValue(text) {
  const trimmed = text.trim()
  const m = trimmed.match(/^(['"])((?:\\.|(?!\1).)*)\1$/)
  if (!m) return null
  return m[2].replace(/\\(.)/g, '$1')
}

function bareIdentifier(text) {
  const trimmed = text.trim()
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(trimmed) ? trimmed : null
}

function dottedPath(text) {
  const trimmed = text.trim()
  const m = trimmed.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\.([A-Za-z_$][A-Za-z0-9_$]*)$/)
  return m ? { root: m[1], prop: m[2] } : null
}

// A template literal with EXACTLY one ${...} interpolation whose inner expression is a bare
// identifier: `prefix${IDENT}suffix`. Two or more `${...}` groups, or an interpolation whose
// inner text is not a bare identifier, is not this form (falls through to "unresolvable").
function singleInterpolationTemplate(text) {
  const trimmed = text.trim()
  const m = trimmed.match(/^`([^`]*)`$/)
  if (!m) return null
  const body = m[1]
  const interpolations = [...body.matchAll(/\$\{([^}]*)\}/g)]
  if (interpolations.length !== 1) return null
  const ref = bareIdentifier(interpolations[0][1])
  if (!ref) return null
  const [prefix, suffix] = body.split(/\$\{[^}]*\}/)
  return { prefix, suffix, ref }
}

function findMatchingBrace(content, openIndex) {
  let depth = 0
  for (let i = openIndex; i < content.length; i += 1) {
    if (content[i] === '{') depth += 1
    else if (content[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

// `{ a: 'lit', b: 'lit2', c: someExpr, ... }` — only string-literal property values register.
// If the count of top-level `key:` occurrences does not match the count of literal-valued
// properties parsed, the whole object is rejected as this form (nested braces, spread, and
// computed keys all fail this equality check, which is deliberately conservative rather than
// risk a partially-parsed object silently under-reporting its own properties).
function objectLiteralProps(text) {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
  const body = trimmed.slice(1, -1)
  const props = new Map()
  const propPattern = /([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*('(?:\\.|[^'])*'|"(?:\\.|[^"])*")\s*,?/g
  let match
  while ((match = propPattern.exec(body))) {
    props.set(match[1], stringLiteralValue(match[2]))
  }
  const keyCount = (body.match(/[A-Za-z_$][A-Za-z0-9_$]*\s*:/g) || []).length
  if (props.size === 0 || keyCount !== props.size) return null
  return props
}

function resolveModuleLevelConstantBindings(content) {
  const bindings = new Map()
  MODULE_LEVEL_CONST_PATTERN.lastIndex = 0
  let m
  while ((m = MODULE_LEVEL_CONST_PATTERN.exec(content))) {
    const identifier = m[1]
    let rhs = m[2]
    const rhsTrimmed = rhs.trim()
    // The RHS capture is greedy-to-end-of-line; extend a `{`-opening capture that did not also
    // close on the same line out to its matching closing brace.
    if (rhsTrimmed.startsWith('{') && !/\}\s*;?\s*$/.test(rhsTrimmed)) {
      const rhsStart = m.indices[2][0]
      const closeIndex = findMatchingBrace(content, rhsStart)
      if (closeIndex !== -1) rhs = content.slice(rhsStart, closeIndex + 1)
    }
    rhs = rhs.trim().replace(/;\s*$/, '')

    const literal = stringLiteralValue(rhs)
    if (literal !== null) {
      bindings.set(identifier, { status: 'literal', table: literal, form: 'direct_literal' })
      continue
    }
    const alias = bareIdentifier(rhs)
    if (alias) {
      bindings.set(identifier, { status: 'alias', of: alias, form: 'alias' })
      continue
    }
    const template = singleInterpolationTemplate(rhs)
    if (template) {
      bindings.set(identifier, { status: 'template', ...template, form: 'single_interpolation_template' })
      continue
    }
    const objectProps = objectLiteralProps(rhs)
    if (objectProps) {
      bindings.set(identifier, { status: 'object', props: objectProps, form: 'object_property' })
      continue
    }
    bindings.set(identifier, {
      status: 'unresolvable',
      reason: 'unsupported_binding_form',
      raw: rhs.slice(0, 200),
    })
  }
  return bindings
}

// Resolves `reference` (a bare identifier or `identifier.prop`) to a literal table-name string
// using `bindings` (the output of resolveModuleLevelConstantBindings for ONE file). Throws
// UnresolvableConstantBindingError — never returns null/undefined — for: a missing declaration,
// an `unresolvable`-tagged binding anywhere in the chain, a circular alias chain, a `.prop`
// access against a non-object binding, or a `.prop` access naming a property the object form did
// not capture as a literal.
function resolveIdentifierToTable(bindings, reference, seen = new Set()) {
  const dotted = dottedPath(reference)
  const rootName = dotted ? dotted.root : reference

  if (seen.has(rootName)) {
    throw new UnresolvableConstantBindingError(reference, 'circular_alias_chain')
  }
  const nextSeen = new Set(seen)
  nextSeen.add(rootName)

  const entry = bindings.get(rootName)
  if (!entry) {
    throw new UnresolvableConstantBindingError(reference, 'no_module_level_declaration')
  }

  if (dotted) {
    if (entry.status !== 'object') {
      throw new UnresolvableConstantBindingError(reference, 'dotted_access_on_non_object_binding')
    }
    if (!entry.props.has(dotted.prop) || entry.props.get(dotted.prop) === null) {
      throw new UnresolvableConstantBindingError(reference, 'unresolved_object_property')
    }
    return entry.props.get(dotted.prop)
  }

  if (entry.status === 'literal') return entry.table
  if (entry.status === 'alias') return resolveIdentifierToTable(bindings, entry.of, nextSeen)
  if (entry.status === 'template') {
    const refValue = resolveIdentifierToTable(bindings, entry.ref, nextSeen)
    return `${entry.prefix}${refValue}${entry.suffix}`
  }
  if (entry.status === 'object') {
    throw new UnresolvableConstantBindingError(reference, 'bare_reference_to_object_binding')
  }
  throw new UnresolvableConstantBindingError(reference, entry.reason || 'unsupported_binding_form')
}

module.exports = {
  UnresolvableConstantBindingError,
  resolveModuleLevelConstantBindings,
  resolveIdentifierToTable,
}

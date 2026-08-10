'use strict'

// #4556 W4C-0 follow-up — owner ruling on the report-sync job control-plane writes.
//
// Builds the census of `plugin_attendance_*`-prefixed DML sites reached through a `${IDENT}` /
// `${IDENT.prop}` dynamic table-target — the shape collector.cjs's literal-only DML_LINE_PATTERN
// cannot see, and the shape all four registered report-sync sites use.
//
// Strategy (deliberately NOT a parallel scanner): resolve each scannable file's module-level
// constant bindings, substitute every resolvable `${...}` dynamic DML-verb target with its
// literal table name IN A COPY of the file's content (same character length per line — no
// newline is added or removed, so line numbers stay stable), and hand that copy to collector.cjs's
// own already-exported, already-tested `scanFileForDmlSites`. This inherits comment masking, verb
// parsing, SQL-reserved-word filtering, migration-DDL skip, and — critically — IDENTICAL
// nearest-enclosing-symbol attribution to every literal site collector.cjs already classifies.
// It also means this module never needs to duplicate or export that private heuristic.
//
// Scope gate, and why it is a PREFIX check and not "table ∈ migrations-derived domain":
// a table name is in THIS census's scope purely by matching `plugin_attendance_[a-z0-9_]+` — the
// derived-domain membership (plugin-attendance-table-domain.cjs) is applied later, by the
// classifier, as its own named bucket ("undomained"). If scope itself required domain
// membership, re-pointing the ATTENDANCE_REPORT_SYNC_JOB_TABLE constant at an undomained sibling
// name would make the site invisible to this census entirely — a mutation that should RED would
// instead silently vanish from scope. See operational-control-plane-classify.cjs.
//
// Fast pre-filter: a file whose content does not contain the literal substring
// "plugin_attendance_" anywhere cannot define or use a module-level constant bound (through any
// of the four documented forms) to a `plugin_attendance_*` table, so it is skipped before the
// (more expensive) binding-resolution pass runs at all. This is exact substring matching, not a
// heuristic — verified against the real repository to touch exactly the files that actually
// reference the table (see the collector-test file's own positive-control assertion).
//
// "Must FAIL, not skip" (constant-table-binding-resolver.cjs's contract) is exercised, and can
// only fire, for identifiers that ARE module-level constants in an ALREADY-prefiltered file AND
// ARE used at a DML-verb `${...}` target position. It never touches the wider, disclosed set of
// ~112 unrelated dynamic write targets elsewhere in the repo (different files, different
// identifiers, none containing the "plugin_attendance_" substring) — this module does not widen
// that disclosure, and does not attempt to close it.

const crypto = require('crypto')
const {
  discoverRuntimeRoots,
  isScannablePath,
  maskCommentsForDmlScan,
  scanFileForDmlSites,
} = require('./collector.cjs')
const {
  resolveModuleLevelConstantBindings,
  resolveIdentifierToTable,
} = require('./constant-table-binding-resolver.cjs')

const PLUGIN_ATTENDANCE_SUBSTRING_MARKER = 'plugin_attendance_'
const PLUGIN_ATTENDANCE_TABLE_PREFIX_PATTERN = /^plugin_attendance_[a-z0-9_]+$/

// A DML verb immediately followed by a `${...}` interpolation whose inner text is a bare
// identifier or one `identifier.prop` hop — the shape the resolver documents as handled at the
// use site. Anything else inside the braces (an operator, a call, two hops) never matches this
// pattern at all, so it is left completely alone by construction, not filtered after the fact.
const DML_DYNAMIC_TARGET_PATTERN =
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|MERGE\s+INTO|CREATE(?:\s+TEMP(?:ORARY)?)?\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|ALTER\s+TABLE)\s+\$\{\s*([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?)\s*\}/g

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

function normalizeStatementText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

function fingerprintForStatement(text) {
  return sha256Hex(normalizeStatementText(text))
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split(/\r?\n/).length
}

// Finds the backtick template literal containing `index` (a character offset into `content`).
// Every dynamic verb-target site this module resolves is, in this codebase, written as SQL
// inside a backtick template — the same convention collector.cjs's own internal
// sqlLiteralContainingIndex relies on for its (unexported) predicate-fingerprint helper. This is
// a small, self-contained equivalent, not a copy of unexported private state.
function backtickTemplateContaining(content, index) {
  let start = -1
  for (let i = index; i >= 0; i -= 1) {
    if (content[i] === '`') {
      start = i
      break
    }
  }
  if (start === -1) return null
  let end = -1
  for (let i = index + 1; i < content.length; i += 1) {
    if (content[i] === '`') {
      end = i
      break
    }
  }
  if (end === -1) return null
  return content.slice(start + 1, end)
}

// Resolves and substitutes every in-scope `${...}` dynamic DML-verb target found in `content`,
// returning the substituted copy plus a fingerprint (of the ORIGINAL statement text, `${...}`
// left intact) keyed by 1-based line number. Substitution happens on offsets found in the
// COMMENT-MASKED text (so a `${...}` inside a comment never substitutes) but is applied to the
// ORIGINAL content (masking never changes string length or line breaks, so offsets carry over
// exactly) — the returned content therefore still carries the file's real comments verbatim.
//
// Throws UnresolvableConstantBindingError (propagated, not swallowed) the moment a `${...}`
// target's root identifier IS a module-level constant in this file but its binding form is one
// constant-table-binding-resolver.cjs does not support. A root identifier that is NOT a
// module-level constant at all (a function parameter, a local variable, an imported binding) is
// left untouched — that is the documented non-module-level / cross-file blind spot, not a
// silently-skipped resolvable form.
function substituteResolvedDynamicTargets(content) {
  const masked = maskCommentsForDmlScan(content)
  const bindings = resolveModuleLevelConstantBindings(content)
  const edits = [] // { start, end, table, statementText, line }

  DML_DYNAMIC_TARGET_PATTERN.lastIndex = 0
  let m
  while ((m = DML_DYNAMIC_TARGET_PATTERN.exec(masked))) {
    const reference = m[2]
    const rootName = reference.split('.')[0]
    if (!bindings.has(rootName)) continue // not a module-level constant here — out of scope

    const table = resolveIdentifierToTable(bindings, reference) // throws, never swallowed
    if (!PLUGIN_ATTENDANCE_TABLE_PREFIX_PATTERN.test(table)) continue // out of this census's scope

    const dollarBraceStart = m.index + m[0].indexOf('${')
    const closeBraceIndex = masked.indexOf('}', dollarBraceStart)
    const statementText = backtickTemplateContaining(content, m.index) || m[0]
    edits.push({
      start: dollarBraceStart,
      end: closeBraceIndex + 1,
      table,
      statementText,
      line: lineNumberAt(content, m.index),
    })
  }

  const fingerprintsByLine = new Map()
  for (const edit of edits) {
    fingerprintsByLine.set(edit.line, fingerprintForStatement(edit.statementText))
  }

  if (edits.length === 0) return { content, fingerprintsByLine }

  const sorted = [...edits].sort((a, b) => b.start - a.start) // back-to-front: earlier offsets stay valid
  let out = content
  for (const edit of sorted) {
    out = out.slice(0, edit.start) + edit.table + out.slice(edit.end)
  }
  return { content: out, fingerprintsByLine }
}

// Builds the full plugin_attendance_*-prefix census across the same file universe collector.cjs
// scans (discoverRuntimeRoots + isScannablePath — no separate hand-picked root list).
function buildOperationalControlPlaneCensus(source) {
  const roots = discoverRuntimeRoots(source)
  const seen = new Set()
  const sites = []
  for (const root of roots) {
    for (const relPath of source.listAllFiles(root)) {
      if (seen.has(relPath)) continue
      seen.add(relPath)
      if (!isScannablePath(relPath)) continue
      const content = source.readFile(relPath)
      if (content == null) continue
      if (!content.includes(PLUGIN_ATTENDANCE_SUBSTRING_MARKER)) continue

      const { content: substituted, fingerprintsByLine } = substituteResolvedDynamicTargets(content)
      for (const site of scanFileForDmlSites(relPath, substituted)) {
        if (!PLUGIN_ATTENDANCE_TABLE_PREFIX_PATTERN.test(site.table)) continue
        sites.push({
          ...site,
          fingerprint: fingerprintsByLine.get(site.line) || null,
        })
      }
    }
  }
  sites.sort((a, b) => (a.relPath === b.relPath ? a.line - b.line : a.relPath < b.relPath ? -1 : 1))
  return { roots, sites }
}

module.exports = {
  PLUGIN_ATTENDANCE_TABLE_PREFIX_PATTERN,
  DML_DYNAMIC_TARGET_PATTERN,
  fingerprintForStatement,
  substituteResolvedDynamicTargets,
  buildOperationalControlPlaneCensus,
}

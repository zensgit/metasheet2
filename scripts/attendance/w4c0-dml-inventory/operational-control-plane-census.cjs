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
// instead silently vanish from scope. See operational-control-plane-classify.cjs. A resolved
// constant value may itself carry a schema qualifier baked into the string
// (`'public.plugin_attendance_report_sync_jobs'`) rather than one written directly in SQL text —
// `stripLeadingSchemaQualifiers` strips that before the prefix test so a schema-qualified constant
// cannot silently fall out of scope the way an unqualified one would be in scope (fail-closed: it
// can only widen what is in scope, never narrow it). A schema qualifier written directly in SQL
// text (`UPDATE public.${IDENT}` or a literal `UPDATE public.plugin_attendance_x`) is handled by
// collector.cjs's own DML_LINE_PATTERN, which resolves the qualifier down to the real table name
// before this module ever sees `site.table` — see that pattern's docblock.
//
// Fast pre-filter: a file whose content does not contain the literal substring
// "plugin_attendance_" anywhere cannot define or use a module-level constant bound (through any
// of the four documented forms) to a `plugin_attendance_*` table, so it is skipped before the
// (more expensive) binding-resolution pass runs at all. This is exact substring matching, not a
// heuristic — verified against the real repository to touch exactly the files that actually
// reference the table (see the collector-test file's own positive-control assertion).
//
// DISCLOSED BLIND SPOT — cross-file import (not closed): the pre-filter above is a SAME-FILE
// substring test, and `resolveModuleLevelConstantBindings` only ever considers bindings declared
// in the file being scanned (see constant-table-binding-resolver.cjs's own docblock, "cross-file
// import/re-export" — resolution never crosses a require()/import boundary). A file that imports
// an ALREADY-declared `plugin_attendance_*`-valued constant from another module (e.g.
// `import { REPORT_SYNC_JOB_TABLE } from './other-file.mjs'`) and uses it at a DML-verb `${...}`
// target is therefore invisible TWICE over: the importing file's own source text need never
// contain the literal substring "plugin_attendance_" anywhere (so the pre-filter skips it before
// binding resolution even starts), and even if it somehow did, the binding resolver would not
// find a same-file `const` declaration for the imported name (so it would fall into the
// `non_module_level_root`-reported bucket below — the pre-filter is what stands between that and
// even being attempted). This module deliberately does NOT close this by following imports: doing
// so would require resolving `require()`/`import` module graphs — real static analysis, not text
// substitution — and would also widen the substring pre-filter into a real per-file cost increase
// across the ~112-file wider population of unrelated dynamic write targets the pre-filter exists
// to keep this module OFF of (see collector-test's "files without the plugin_attendance_ substring
// are never even attempted" case, which pins that narrowing). The trade-off taken here: keep the
// narrow, cheap, same-file-only pre-filter, and accept that a constant re-exported through an
// import boundary is outside this census's reach — disclosed, not silently absorbed.
//
// DISCLOSED BLIND SPOT — kysely query-builder writes (not detected): every detector this module
// uses (collector.cjs's DML_LINE_PATTERN, and the DML-verb + `${...}` scanner below) is raw-SQL
// text matching. This repository also writes via kysely's fluent builder
// (`db.insertInto(...)`/`.updateTable(...)`/`.deleteFrom(...)`, ~291 occurrences across
// packages/core-backend and other plugins at the point this was checked) — those calls contain no
// SQL-verb keyword text at all, so neither detector can see them, and no report-sync or other
// `plugin_attendance_*` site in this repository is written this way today (verified: zero
// `insertInto`/`updateTable`/`deleteFrom` occurrences target a `plugin_attendance_*` table at the
// point this was checked). This is a PROSPECTIVE blind spot, not a currently-live undetected
// write: if a future `plugin_attendance_*` write is added via the kysely builder, this census
// will not see it, will not classify it, and will not RED for it. See the collector test's kysely
// pin, which fails loudly if this module's behavior toward a synthetic builder-form write ever
// silently changes without this disclosure being updated.
//
// "Must FAIL, not skip" — EXACT scope of this guarantee (constant-table-binding-resolver.cjs's
// contract): a root identifier that IS a module-level constant in an already-prefiltered file AND
// is referenced at a recognized DML-verb `${...}` target THROWS (never silently vanishes) the
// moment its binding form is unsupported. This guarantee's OWN triggering condition — being
// "referenced at a recognized target" — is narrower than "every `${...}` next to a DML verb":
//   - RECOGNIZED shape: the `${...}` interpolation's inner text, trimmed, is a bare identifier or
//     exactly one `identifier.prop` hop (`${IDENT}`, `${IDENT.prop}`) — nothing else. A two-hop
//     path (`${MAP.a.b}`), a call (`${tableName()}`), a ternary (`${cond ? a : b}`), a binary
//     expression (`${PREFIX + SUFFIX}`), a computed member access (`${arr[0]}`), or any other
//     non-bare-reference expression is NOT a recognized shape.
//   - Even for a recognized shape, the root identifier must be a module-level (column-0) `const`
//     IN THE SAME FILE — a function parameter, a local variable, a loop variable, or an imported
//     binding sharing the same textual shape is NOT a module-level constant.
// A `${...}` that fails EITHER condition is NOT silently absent from this module's output: it is
// pushed into `unresolvedDynamicTargetShapes` (returned by `substituteResolvedDynamicTargets` and
// `buildOperationalControlPlaneCensus`) tagged with a `reason` — `'unsupported_shape'` for the
// first condition, `'non_module_level_root'` for the second — so "we did not look there" is
// visible output, not silence. It is only the RESOLVER's own throw contract (an in-scope,
// recognized reference whose binding form the resolver itself cannot handle — a function-call- or
// ternary-derived module-level constant, for example) that remains an uncaught, propagated throw;
// everything documented above as "not recognized" is instead a reported, non-throwing skip.
//
// FINGERPRINT SPAN — what `fingerprintForStatement` actually hashes, and what it does not:
// `statementExpressionContaining` captures the backtick template's full text PLUS any chained
// `.identifier` / `.identifier(args)` segments immediately following the closing backtick
// (arbitrarily many, e.g. `` `...`.replace(a, b).trim() ``), using balanced-paren/quote/template
// scanning so a `)` or `` ` `` inside a chained call's own string argument cannot end the chain
// early. This closes the exact class of mutation that caused this to need re-hardening: appending
// `.replace(' AND org_id = $2', '')` (or any other chained call) right after a registered
// statement's closing backtick now changes the hash (see the collector test's
// `fingerprintDrift: chained .replace() after the statement` case). It starts at the opening
// backtick (not the DML verb) and ends at the end of the chained-call sequence (not at the
// enclosing call's comma or closing paren) — a superset of "verb through end of statement", not a
// narrower span.
//
// What it does NOT cover — attacked and left OPEN, in order of how directly they parallel the
// `.replace()` finding that caused this hardening (same class: executed behavior changes, hash
// does not):
//   1. Bind-parameter mutation in the query call's SECOND argument (the values array) — e.g.
//      reordering `[id, orgId, ...]` to `[orgId, id, ...]` changes which value binds to which `$N`
//      placeholder with byte-identical SQL text. This span deliberately covers only the ONE call
//      argument that holds the query text (per the hardening direction this module was given);
//      covering the whole call would also fingerprint incidental changes to the bind-array
//      (reformatting, an added inline comment) as drift, which was judged a bigger, undirected
//      change than this hardening pass should make unilaterally. OPEN, disclosed here rather than
//      silently assumed closed.
//   2. String concatenation around the template (`` `...` + ' extra clause' ``) — the chain
//      scanner only recognizes `.identifier` segments, not binary operators. OPEN.
//   3. A wrapping function call around the template (`sanitize(\`...\`)`) whose own body performs
//      the equivalent of a chained `.replace()` — the scanner only extends FORWARD from the
//      closing backtick, never looks for an enclosing call. OPEN.
//   4. Reassignment across separate statements (`let stmt = \`...\`; stmt = stmt.replace(...)`) —
//      this module is text substitution over one file, not a data-flow analysis; a mutation
//      expressed as a later, separate statement is invisible by construction. OPEN.
// Each of these is a real, executed counterexample against the FIXED span, verified against this
// module's own functions (see the collector test's "fingerprint span residuals" cases), not
// merely asserted in prose.

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

// A DML verb immediately followed by `${` — the OPEN half of a dynamic table-target
// interpolation. Deliberately does not try to match the interpolation's closing `}` or inner
// content inline (a fixed-width character class cannot tell a recognized shape from an
// unrecognized one without also silently discarding the unrecognized ones) — the closing brace is
// found by balanced-depth scanning below, and the inner text's shape is classified explicitly, so
// every occurrence produces a resolved edit OR a reported unresolved-shape entry, never neither.
// Case-sensitive by design, same rationale as collector.cjs's DML_LINE_PATTERN (see that pattern's
// docblock): this codebase's real SQL is written in uppercase keywords; a case-insensitive pattern
// would match English prose in comments and flood this census with non-SQL noise. A lowercase or
// mixed-case SQL keyword at a dynamic target is therefore an undetected escape of THIS module too
// — the same stated, disclosed limitation collector.cjs carries for its own pattern, not a
// silently-narrower guarantee introduced here.
const DML_VERB_DOLLAR_BRACE_OPEN_PATTERN =
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|MERGE\s+INTO|CREATE(?:\s+TEMP(?:ORARY)?)?\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|ALTER\s+TABLE)\s+\$\{/g

// The "recognized" use-site shape the resolver documents as handled: a bare identifier or exactly
// one `identifier.prop` hop, and nothing else (no call, no operator, no second hop).
const NARROW_DYNAMIC_TARGET_SHAPE_PATTERN =
  /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?$/

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

// A resolved binding's table VALUE may itself carry a schema qualifier baked into the string
// (`'public.plugin_attendance_report_sync_jobs'`) — distinct from a qualifier written directly in
// SQL text, which collector.cjs's own DML_LINE_PATTERN already resolves. Strips one or more
// leading `identifier.` segments before the prefix scope-test so this cannot silently fall out of
// scope; only ever widens what is treated as in-scope, never narrows it.
function stripLeadingSchemaQualifiers(table) {
  return String(table ?? '').replace(/^(?:[A-Za-z_][A-Za-z0-9_]*\s*\.\s*)+/, '')
}

// Finds the index of the `}` matching the `{` at `content[openBraceIndex]`, honoring nested
// braces (e.g. `${render({a:1})}`). Returns -1 if unmatched.
function findMatchingBraceIndex(content, openBraceIndex) {
  let depth = 0
  for (let i = openBraceIndex; i < content.length; i += 1) {
    if (content[i] === '{') depth += 1
    else if (content[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function isIdentifierStart(ch) {
  return ch != null && /[A-Za-z_$]/.test(ch)
}
function isIdentifierPart(ch) {
  return ch != null && /[A-Za-z0-9_$]/.test(ch)
}

// Finds the index of the `)` matching the `(` at `content[openIndex]`, honoring nested
// parens and skipping over the contents of `'...'`, `"..."`, and `` `...` `` (including simple
// `${...}` interpolations inside a nested template) so a paren/quote INSIDE a chained call's own
// string argument cannot end the scan early.
function findMatchingParenIndex(content, openIndex) {
  let depth = 0
  let i = openIndex
  while (i < content.length) {
    const ch = content[i]
    if (ch === '(') {
      depth += 1
      i += 1
      continue
    }
    if (ch === ')') {
      depth -= 1
      if (depth === 0) return i
      i += 1
      continue
    }
    if (ch === "'" || ch === '"') {
      const quote = ch
      i += 1
      while (i < content.length) {
        if (content[i] === '\\') {
          i += 2
          continue
        }
        if (content[i] === quote) {
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    if (ch === '`') {
      i += 1
      while (i < content.length) {
        if (content[i] === '\\') {
          i += 2
          continue
        }
        if (content[i] === '`') {
          i += 1
          break
        }
        if (content[i] === '$' && content[i + 1] === '{') {
          let braceDepth = 1
          i += 2
          while (i < content.length && braceDepth > 0) {
            if (content[i] === '{') braceDepth += 1
            else if (content[i] === '}') braceDepth -= 1
            i += 1
          }
          continue
        }
        i += 1
      }
      continue
    }
    i += 1
  }
  return -1
}

// Extends `cursor` (an index into `content`, "just past" the last consumed character) forward
// across any DIRECTLY chained `.identifier` / `.identifier(args)` segments — e.g.
// `` `...`.replace(a, b).trim() `` — allowing whitespace/newlines between segments. Stops at the
// first token that is not `.identifier`. Returns `cursor` unchanged if no chain segment follows.
function extendPastChainedCalls(content, cursor) {
  for (;;) {
    let i = cursor
    while (i < content.length && /\s/.test(content[i])) i += 1
    if (content[i] !== '.') return cursor
    let j = i + 1
    if (!isIdentifierStart(content[j])) return cursor
    j += 1
    while (j < content.length && isIdentifierPart(content[j])) j += 1
    let k = j
    while (k < content.length && /\s/.test(content[k])) k += 1
    if (content[k] === '(') {
      const close = findMatchingParenIndex(content, k)
      if (close === -1) return cursor // malformed — do not guess, stop extending
      cursor = close + 1
      continue
    }
    cursor = j // bare property access — keep scanning for further chain segments
  }
}

// Finds the backtick template literal containing `index` (a character offset into `content`) and
// extends the captured span past any directly-chained post-processing (see the module docblock's
// "FINGERPRINT SPAN" section for exactly what this does and does not cover). Every dynamic
// verb-target site this module resolves is, in this codebase, written as SQL inside a backtick
// template — the same convention collector.cjs's own internal sqlLiteralContainingIndex relies on
// for its (unexported) predicate-fingerprint helper. This is a small, self-contained equivalent,
// not a copy of unexported private state.
function statementExpressionContaining(content, index) {
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
  const extended = extendPastChainedCalls(content, end + 1)
  const stop = extended > end + 1 ? extended : end // no chain found -> exclude the backtick itself, byte-identical to the pre-hardening span
  return content.slice(start + 1, stop)
}

// Resolves and substitutes every in-scope `${...}` dynamic DML-verb target found in `content`,
// returning the substituted copy, a fingerprint (of the statement EXPRESSION — see
// statementExpressionContaining) keyed by 1-based line number, and every DML-verb `${...}`
// occurrence this module did NOT resolve, tagged with why (see the module docblock's "must FAIL,
// not skip" section). Substitution happens on offsets found in the COMMENT-MASKED text (so a
// `${...}` inside a comment never substitutes) but is applied to the ORIGINAL content (masking
// never changes string length or line breaks, so offsets carry over exactly) — the returned
// content therefore still carries the file's real comments verbatim.
//
// Throws UnresolvableConstantBindingError (propagated, not swallowed) the moment a RECOGNIZED
// `${...}` target's root identifier IS a module-level constant in this file but its binding form
// is one constant-table-binding-resolver.cjs does not support.
function substituteResolvedDynamicTargets(content) {
  const masked = maskCommentsForDmlScan(content)
  const bindings = resolveModuleLevelConstantBindings(content)
  const edits = [] // { start, end, table, statementText, line }
  const unresolvedDynamicTargetShapes = [] // { line, reason, raw }

  DML_VERB_DOLLAR_BRACE_OPEN_PATTERN.lastIndex = 0
  let m
  while ((m = DML_VERB_DOLLAR_BRACE_OPEN_PATTERN.exec(masked))) {
    const dollarBraceStart = m.index + m[0].length - 2 // index of '$'
    const openBraceIndex = dollarBraceStart + 1 // index of '{'
    const closeBraceIndex = findMatchingBraceIndex(masked, openBraceIndex)
    const line = lineNumberAt(content, m.index)
    if (closeBraceIndex === -1) {
      unresolvedDynamicTargetShapes.push({ line, reason: 'malformed_no_closing_brace', raw: '' })
      continue
    }
    const innerRaw = masked.slice(openBraceIndex + 1, closeBraceIndex)
    const innerTrimmed = innerRaw.trim()

    if (!NARROW_DYNAMIC_TARGET_SHAPE_PATTERN.test(innerTrimmed)) {
      unresolvedDynamicTargetShapes.push({
        line,
        reason: 'unsupported_shape',
        raw: innerTrimmed.slice(0, 200),
      })
      continue
    }

    const rootName = innerTrimmed.split('.')[0]
    if (!bindings.has(rootName)) {
      unresolvedDynamicTargetShapes.push({
        line,
        reason: 'non_module_level_root',
        raw: innerTrimmed.slice(0, 200),
      })
      continue
    }

    const resolvedTable = resolveIdentifierToTable(bindings, innerTrimmed) // throws, never swallowed
    const table = stripLeadingSchemaQualifiers(resolvedTable)
    if (!PLUGIN_ATTENDANCE_TABLE_PREFIX_PATTERN.test(table)) continue // resolved fine, just out of this census's scope — not a hidden failure

    const statementText = statementExpressionContaining(content, m.index) || masked.slice(m.index, closeBraceIndex + 1)
    edits.push({
      start: dollarBraceStart,
      end: closeBraceIndex + 1,
      table,
      statementText,
      line,
    })
  }

  const fingerprintsByLine = new Map()
  for (const edit of edits) {
    fingerprintsByLine.set(edit.line, fingerprintForStatement(edit.statementText))
  }

  if (edits.length === 0) return { content, fingerprintsByLine, unresolvedDynamicTargetShapes }

  const sorted = [...edits].sort((a, b) => b.start - a.start) // back-to-front: earlier offsets stay valid
  let out = content
  for (const edit of sorted) {
    out = out.slice(0, edit.start) + edit.table + out.slice(edit.end)
  }
  return { content: out, fingerprintsByLine, unresolvedDynamicTargetShapes }
}

// Builds the full plugin_attendance_*-prefix census across the same file universe collector.cjs
// scans (discoverRuntimeRoots + isScannablePath — no separate hand-picked root list).
function buildOperationalControlPlaneCensus(source) {
  const roots = discoverRuntimeRoots(source)
  const seen = new Set()
  const sites = []
  const unresolvedDynamicTargetShapes = []
  for (const root of roots) {
    for (const relPath of source.listAllFiles(root)) {
      if (seen.has(relPath)) continue
      seen.add(relPath)
      if (!isScannablePath(relPath)) continue
      const content = source.readFile(relPath)
      if (content == null) continue
      if (!content.includes(PLUGIN_ATTENDANCE_SUBSTRING_MARKER)) continue

      const { content: substituted, fingerprintsByLine, unresolvedDynamicTargetShapes: fileShapes } =
        substituteResolvedDynamicTargets(content)
      for (const shape of fileShapes) {
        unresolvedDynamicTargetShapes.push({ relPath, ...shape })
      }
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
  unresolvedDynamicTargetShapes.sort((a, b) =>
    a.relPath === b.relPath ? a.line - b.line : a.relPath < b.relPath ? -1 : 1,
  )
  return { roots, sites, unresolvedDynamicTargetShapes }
}

module.exports = {
  PLUGIN_ATTENDANCE_TABLE_PREFIX_PATTERN,
  DML_VERB_DOLLAR_BRACE_OPEN_PATTERN,
  NARROW_DYNAMIC_TARGET_SHAPE_PATTERN,
  stripLeadingSchemaQualifiers,
  fingerprintForStatement,
  statementExpressionContaining,
  substituteResolvedDynamicTargets,
  buildOperationalControlPlaneCensus,
}

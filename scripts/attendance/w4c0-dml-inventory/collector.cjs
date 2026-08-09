'use strict'

// #4556 W4C-0 Stage D — section 8.4 "source, effect, and result mechanical bypass guard".
//
// This module is the collector engine: root discovery (from workspace/package manifests, not a
// handwritten plugin directory — §8.4 "Paths come from workspace/package manifests"), a
// syntax-class DML scanner, and a bucket/debt classifier. It is deliberately regex-based, not an
// AST walker: the "enclosingSymbol" attribution is a nearest-preceding-declaration heuristic and
// is stated as best-effort everywhere it is used. Its job is to make an unreviewed new/renamed
// business-table DML site impossible to land silently — not to prove program semantics.
//
// Excluded from every scan by construction: `node_modules`, build output directories, and this
// tool's own directory (`scripts/attendance/w4c0-dml-inventory/`) — the tool is not itself a
// runtime attendance writer, and its curated-debt-entries.cjs file contains literal SQL-keyword
// strings as *data* that would otherwise false-positive against its own scanner.

const crypto = require('crypto')
const path = require('path')

const {
  classifyTable,
  P25_OPERATIONAL_TABLE_SPECS,
  TRACKED_BUCKETS,
  W4_CANONICAL_PATH_PREFIXES,
} = require('./table-classification.cjs')

// `.tsx`/`.jsx` are included even though the domain contains none today (measured: 0 files under
// every discovered root, on the live tree and at the pinned baseline ref alike) — a React-shaped
// module appearing later must be scanned, not silently invisible.
// `.vue` is deliberately NOT scannable, and that is a stated residue rather than an oversight:
// `maskCommentsForDmlScan` is a JS/SQL quote state machine, and an SFC's HTML `<template>` section
// desynchronises it (an apostrophe in ordinary prose opens a phantom string literal), after which
// `//` comments stop being masked. Measured over the 242 `.vue` files in `apps/web`, enabling the
// extension produces exactly one DML-pattern match and it is a false positive of exactly that
// shape — the words "on UPDATE so" inside a `//` comment in `UserManagementView.vue`. Scanning
// SFCs needs an SFC-aware masker first; until then the extension would add prose noise, not
// coverage. Zero attendance-owned matches exist in any `.vue` file today.
const SCANNABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs', '.sql', '.sh'])

const EXCLUDED_PATH_SEGMENTS = [
  '/node_modules/',
  '/dist/',
  '/build/',
  '/coverage/',
  '/.turbo/',
  '/__tests__/',
  '/tests/',
  '/test/',
  '/__fixtures__/',
  // This collector's own tooling directory: data files (curated-debt-entries.cjs) contain
  // literal SQL-keyword strings as match-predicate data, not runtime DML.
  '/scripts/attendance/w4c0-dml-inventory/',
]

const EXCLUDED_FILENAME_MARKERS = ['.test.', '.spec.', '.d.ts']

// The lock names workspace packages plus a short, explicit list of extra non-package roots
// ("generated SQL, migrations, and operator scripts"). Migrations live inside the core-backend
// package's own src tree and are covered by ordinary package discovery. `scripts/` is the only
// root that is not itself a workspace package; it is included by the literal name the lock gives
// it (§8.4 "operator scripts"), not as a stand-in for a single hand-picked plugin path.
const EXTRA_NAMED_ROOTS = Object.freeze(['scripts'])

function isScannablePath(relPath) {
  const posixPath = relPath.split(path.sep).join('/')
  if (!posixPath.startsWith('/')) {
    // normalize for segment matching below
  }
  const withSlashes = `/${posixPath}/`
  for (const seg of EXCLUDED_PATH_SEGMENTS) {
    if (withSlashes.includes(seg)) return false
  }
  const base = posixPath.slice(posixPath.lastIndexOf('/') + 1)
  for (const marker of EXCLUDED_FILENAME_MARKERS) {
    if (base.includes(marker)) return false
  }
  const ext = path.extname(base)
  return SCANNABLE_EXTENSIONS.has(ext)
}

// --- pnpm-workspace.yaml parsing (minimal: this repo's file is a flat `packages:` list of
// single-quoted literal/glob-suffix-`*` entries; no general YAML support is needed or wanted) ---
function parseWorkspacePatterns(yamlText) {
  const patterns = []
  const lines = yamlText.split(/\r?\n/)
  let inPackages = false
  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true
      continue
    }
    if (inPackages) {
      const m = line.match(/^\s*-\s*'([^']+)'\s*$/) || line.match(/^\s*-\s*"([^"]+)"\s*$/)
      if (m) {
        patterns.push(m[1])
        continue
      }
      if (/^\S/.test(line)) break // next top-level key
    }
  }
  return patterns
}

function expandWorkspacePattern(pattern, { listDir }) {
  if (pattern.endsWith('/*')) {
    const base = pattern.slice(0, -2)
    return listDir(base).map((name) => `${base}/${name}`)
  }
  return [pattern]
}

// Discover the scan domain: EVERY directory named by a pnpm-workspace.yaml pattern, plus the
// extra named roots. `source` supplies `readFile(relPath) -> string|null` and
// `listDir(relDir) -> string[]` (empty array if absent).
//
// MEMBERSHIP IS THE MANIFEST, NOT A MARKER FILE. This function used to promote a
// workspace-matched directory to a scan root only when `<dir>/package.json` existed. That made
// census membership hinge on an incidental packaging artifact: `plugins/plugin-after-sales` — a
// live product plugin with a `plugin.json` manifest (manifestVersion 2.0.0), an 850-line
// `index.cjs`, a contributed route `/p/plugin-after-sales/after-sales` and 13 `lib/*.cjs`
// modules, in the same after-sales approval domain this gate's own probes use — matches the
// `plugins/*` workspace pattern but ships no `package.json`, so nothing in it was scanned at all.
// The failure mode is worse than a missed classification: an unscanned directory does not move
// the RAW census either, so a write there is invisible rather than unclaimed.
//
// Swapping one marker file for two (`package.json` OR `plugin.json`) would only move the same
// fragility one file along. The rule is therefore derived from the manifest alone and FAILS
// CLOSED: a directory the collector cannot classify is SCANNED, not skipped. Directories that
// are absent, non-package, or source-free cost nothing — `listAllFiles` simply yields no
// scannable file for them, which is why widening the root set from 13 to 20 directories added
// zero census sites on the live tree and zero at the pinned baseline ref.
function discoverRuntimeRoots(source) {
  const workspaceYaml = source.readFile('pnpm-workspace.yaml')
  if (workspaceYaml == null) {
    throw new Error('ATTENDANCE_W4C0_DML_COLLECTOR_MISSING_WORKSPACE_MANIFEST')
  }
  const patterns = parseWorkspacePatterns(workspaceYaml)
  const candidateDirs = new Set()
  for (const pattern of patterns) {
    for (const dir of expandWorkspacePattern(pattern, source)) {
      candidateDirs.add(dir)
    }
  }
  for (const named of EXTRA_NAMED_ROOTS) {
    candidateDirs.add(named)
  }
  return [...candidateDirs].sort()
}

// --- DML statement scanning -------------------------------------------------------------------

// Matches the verb + immediately-following bare/quoted table identifier for the statement forms
// named in §8.4: INSERT/UPDATE/DELETE/TRUNCATE/MERGE, COPY FROM|TO, and staging CREATE/DROP/ALTER
// TABLE. The pattern runs against the structurally masked whole file so whitespace between a
// verb and table name may include newlines.
// CASE — two independent axes, handled differently on purpose.
//
// (1) KEYWORDS are matched case-SENSITIVELY. This codebase's real SQL is written in uppercase
//     keywords (verified against the runtime roots before this pattern was chosen); a
//     case-insensitive pattern instead matches ordinary English prose in comments ("update a
//     record") and floods the census with non-SQL noise. A lowercase/mixed-case SQL keyword
//     bypassing this scan is a stated collector limitation (see the collector's own CI test and
//     the Stage D handoff note), not a silently-claimed guarantee.
//
// (2) The TABLE IDENTIFIER is resolved per PostgreSQL folding rules — see
//     `resolveTableIdentifier` below — and the attendance-ownership test is case-insensitive.
//     This axis is NOT covered by (1) and must not be confused with it. Case-folding a captured
//     identifier adds no prose noise whatsoever, because the verb still has to match uppercase to
//     reach the capture at all; the trade that buys (1) buys nothing here. Before this was fixed,
//     `INSERT INTO ATTENDANCE_RECORDS` DID mint a census site (the keywords are uppercase, so the
//     pattern matched) and was then discarded by `isAttendanceOwnedCandidate`, silently and
//     before `classifyTable` — not tracked, not unclaimed, not even unclassified — while naming
//     the very same relation as the approved lowercase site. The three READ legs below
//     (`P25_READ_TABLE_PATTERN`, `ATTENDANCE_RECORD_READ_PATTERN`,
//     `ATTENDANCE_CALCULATION_READ_PATTERN`) have always matched tables case-insensitively; the
//     write census was the only leg that did not.
//
// SCHEMA QUALIFIERS: `INSERT INTO public.attendance_records` must resolve to the table
// `attendance_records`, not to `public`. Without the qualifier group below, the capture took the
// FIRST identifier, so a schema prefix silently renamed the site to a non-attendance table and the
// write left the tracked buckets entirely — a one-token bypass of the whole gate, and one this
// repository's other DML scanner (multitable-revision-disposition) already handles. The group is
// `*`, not `?`, so `db.schema.table` resolves to `table` too. This can only ever WIDEN what the
// scan sees (a previously mis-captured qualifier now resolves to its real table), never narrow it,
// so the change direction is fail-closed.
// Group 2 captures the WHOLE final table token, quotes included, so that the quoted/unquoted
// distinction survives the match instead of being thrown away by the regex. It is parsed in JS by
// `resolveTableIdentifier`, which keeps the group indices stable (m[1] = verb, m[2] = table token)
// and keeps the asymmetric-quote case an explicit decision rather than a backreference subtlety.
// `ONLY` is a PostgreSQL inheritance modifier, not a table: `UPDATE ONLY t` and
// `DELETE FROM ONLY t` both target `t`. Without the optional group below the capture took `ONLY`
// as the table name, which is not attendance-owned, so the write left the tracked buckets
// entirely — the same one-token bypass shape as the schema qualifier. It is consumed
// STRUCTURALLY here and deliberately NOT added to `SQL_RESERVED_NON_TABLE_WORDS`: that set
// `continue`s, i.e. discards the site, which would be fail-OPEN and would leave the real write
// invisible rather than mis-named. Measured: zero `ONLY` DML targets exist in the domain today,
// so this closes a latent hole at zero census cost.
const DML_LINE_PATTERN =
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|MERGE\s+INTO|COPY|CREATE(?:\s+TEMP(?:ORARY)?)?\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|ALTER\s+TABLE)\s+(?:ONLY\s+)?(?:"?[a-zA-Z_][a-zA-Z0-9_]*"?\s*\.\s*)*("?[a-zA-Z_][a-zA-Z0-9_]*"?)/g

// `TRUNCATE a, b` and `DROP TABLE a, b` take a LIST of targets; the pattern above matches the verb
// once and so produced a site for `a` only, leaving every later target invisible. This sticky
// continuation consumes the rest of the list from immediately after the first target.
//
// Restricted to the two verbs where a comma list is actually a target list. Applying it to every
// verb was measured first and is wrong: it produces 12 false sites in this tree (`CONSTRAINT`
// captured from `ALTER TABLE`-shaped DDL, and one prose fragment). Restricted, it produces ZERO
// today — so, like `ONLY`, this closes a latent hole at zero census cost. Sticky (`y`) rather than
// slicing so nothing depends on a fixed-width window that could cut an identifier in half.
const MULTI_TARGET_VERBS = new Set(['truncate', 'staging_drop'])
const TABLE_LIST_CONTINUATION =
  /\s*,\s*(?:ONLY\s+)?(?:"?[a-zA-Z_][a-zA-Z0-9_]*"?\s*\.\s*)*("?[a-zA-Z_][a-zA-Z0-9_]*"?)/y

// PostgreSQL identifier folding, applied to the captured table token.
//
//   INSERT INTO ATTENDANCE_RECORDS      -> unquoted: PostgreSQL folds it to `attendance_records`,
//                                          so this is the SAME relation as the approved
//                                          lowercase site and must resolve to the same name.
//   INSERT INTO "Attendance_Records"    -> double-quoted: PostgreSQL preserves the spelling, so
//                                          this is a DIFFERENT relation and must NOT be folded
//                                          into the approved one. It resolves verbatim, is still
//                                          admitted to attendance scope by the case-insensitive
//                                          ownership test below, and then fails `classifyTable`
//                                          (the registry holds only the real, lowercase tables) —
//                                          landing in `unclassifiedTableSites`, a hard CI failure.
//                                          That is the correct disposition twice over: it is not
//                                          silently accepted as the approved table, and it is not
//                                          silently dropped either.
//   INSERT INTO "Attendance_Records     -> asymmetric quoting is not a quoted identifier in any
//                                          dialect; treated as unquoted, i.e. folded, which is the
//                                          wider (fail-closed) of the two readings.
//
// The attendance-owned tables are PostgreSQL relations, so PostgreSQL's folding rule is the right
// one. `packages/mssql-readonly-utils` is inside the scan domain but is a read-only SQL Server
// utility that owns none of them; under SQL Server's default collation identifiers are
// case-insensitive whether quoted or not, so folding is at worst redundant there, never wrong.
function resolveTableIdentifier(token) {
  const raw = String(token)
  const quoted = raw.length > 1 && raw.startsWith('"') && raw.endsWith('"')
  const bare = raw.replace(/^"/, '').replace(/"$/, '')
  return { table: quoted ? bare : bare.toLowerCase(), quoted }
}

const P25_READ_TABLE_PATTERN = new RegExp(
  `\\b(?:FROM|JOIN)\\s+"?(${Object.keys(P25_OPERATIONAL_TABLE_SPECS).join('|')})"?(?![A-Za-z0-9_])`,
  'gi',
)

const ATTENDANCE_RECORD_READ_PATTERN =
  /\b(?:FROM|JOIN)\s+"?(attendance_records|attendance_current_records)"?(?![A-Za-z0-9_])/gi
const ATTENDANCE_CALCULATION_READ_PATTERN =
  /\b(?:FROM|JOIN)\s+"?(attendance_record_calculations|attendance_record_segments)"?(?![A-Za-z0-9_])/gi
const DYNAMIC_READ_PATTERN = /\b(?:FROM|JOIN)\s+\$\{([^}]+)\}/gi
const JS_IDENTIFIER_PATTERN = /\b[A-Za-z_$][A-Za-z0-9_$]*\b/g

function sqlLiteralContainingIndex(content, index) {
  let quote = null
  let start = -1
  let escaped = false
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i]
    if (quote !== null) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === quote) {
        if (start < index && index < i) return content.slice(start + 1, i)
        quote = null
        start = -1
      }
      continue
    }
    if (ch === '`' || ch === "'" || ch === '"') {
      quote = ch
      start = i
    }
  }
  return null
}

function maskSqlComments(query) {
  const src = String(query ?? '')
  let out = ''
  let quote = null
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]
    if (quote !== null) {
      out += ch
      if (ch === '\\' && i + 1 < src.length) {
        out += src[i + 1]
        i += 2
        continue
      }
      if (ch === quote && next === quote) {
        out += next
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      out += ch
      i += 1
      continue
    }
    if (ch === '-' && next === '-') {
      out += '  '
      i += 2
      while (i < src.length && src[i] !== '\n' && src[i] !== '\r') {
        out += ' '
        i += 1
      }
      continue
    }
    if (ch === '/' && next === '*') {
      out += '  '
      i += 2
      while (i < src.length) {
        if (src[i] === '*' && src[i + 1] === '/') {
          out += '  '
          i += 2
          break
        }
        out += src[i] === '\n' || src[i] === '\r' ? src[i] : ' '
        i += 1
      }
      continue
    }
    out += ch
    i += 1
  }
  return out
}

function requiredPredicateFingerprint(content, index) {
  const query = sqlLiteralContainingIndex(String(content ?? ''), index)
  if (!query) return null
  const maskedQuery = maskSqlComments(query)
  if (/\b(?:[A-Za-z_$][A-Za-z0-9_$]*\.)?visibility_state\s*=\s*['"]active['"]/i.test(maskedQuery)) {
    return 'visibility_state=active'
  }
  if (/\b(?:attendance_current_records|ATTENDANCE_ACTIVE_CURRENT_RELATION_V1)\b/.test(maskedQuery)) {
    return 'current_relation=attendance_current_records'
  }
  return null
}

// Reserved words that can legally follow a DML verb without being a table name — most notably
// `... ON CONFLICT (...) DO UPDATE SET col = ...` (an upsert), where "SET" immediately follows
// "UPDATE" with no table name at all (the target is implicit from the INSERT INTO on the same
// statement, which is captured separately by its own INSERT INTO match). Filtering these out
// here is a scanner-precision fix, not a scope reduction: no real table name is ever equal to a
// SQL reserved word.
const SQL_RESERVED_NON_TABLE_WORDS = new Set([
  'SET',
  'ON',
  'OF',
  'WHERE',
  'VALUES',
  'RETURNING',
  'SELECT',
  'FROM',
  'INTO',
  'TABLE',
  'IF',
  'EXISTS',
  'NOT',
  'AND',
  'OR',
  'IS',
  'AS',
  'IN',
  'THEN',
  'WHEN',
  'MATCHED',
  'USING',
  'STDIN',
  'STDOUT',
])

function verbFromKeyword(keyword) {
  const k = keyword.trim().toUpperCase().replace(/\s+/g, ' ')
  if (k.startsWith('INSERT')) return 'insert'
  if (k === 'UPDATE') return 'update'
  if (k.startsWith('DELETE')) return 'delete'
  if (k.startsWith('TRUNCATE')) return 'truncate'
  if (k.startsWith('MERGE')) return 'merge'
  if (k === 'COPY') return 'copy'
  if (k.startsWith('CREATE') && k.includes('TABLE')) return 'staging_create'
  if (k.startsWith('DROP TABLE')) return 'staging_drop'
  if (k.startsWith('ALTER TABLE')) return 'staging_alter'
  return 'unknown'
}

// Nearest-preceding-declaration symbol attribution (best-effort, not AST-accurate — see module
// header). Scanned backward from the DML line; the first matching line wins regardless of which
// pattern matched, so a DML site inside a small helper function is attributed to that helper even
// when the helper itself is called from a named route.
const SYMBOL_PATTERNS = [
  // Express-style route registration: router.post('/path', ...
  /\b(?:router|r|app)\.(get|post|put|patch|delete)\(\s*(['"`])((?:\\.|(?!\2).)*)\2/,
  // function foo( / async function foo(
  /\b(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/,
  // const foo = ( / const foo = async ( / const foo = function
  /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:function\b|\()/,
]

const JS_KEYWORDS_NOT_SYMBOLS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return'])

function symbolForLine(line) {
  const routeMatch = line.match(SYMBOL_PATTERNS[0])
  if (routeMatch) return `${routeMatch[1].toUpperCase()} ${routeMatch[3]}`
  const fnMatch = line.match(SYMBOL_PATTERNS[1])
  if (fnMatch && !JS_KEYWORDS_NOT_SYMBOLS.has(fnMatch[1])) return fnMatch[1]
  const constMatch = line.match(SYMBOL_PATTERNS[2])
  if (constMatch && !JS_KEYWORDS_NOT_SYMBOLS.has(constMatch[1])) return constMatch[1]
  return null
}

function isMigrationPath(relPath) {
  return /(^|\/)migrations\//.test(relPath)
}

const MAX_BACKWARD_SCAN_LINES = 4000

function nearestEnclosingSymbol(lines, dmlLineIndex) {
  const floor = Math.max(0, dmlLineIndex - MAX_BACKWARD_SCAN_LINES)
  for (let i = dmlLineIndex; i >= floor; i -= 1) {
    const sym = symbolForLine(lines[i])
    if (sym) return sym
  }
  return '(module-scope)'
}

/**
 * String-aware comment masker for DML scanning. Layout (newlines + approximate
 * column width) is preserved so 1-based line numbers remain meaningful.
 *
 * Outside JS/TS string/template tokens:
 *  - mask `//` line comments and `/* ... *\/` block comments
 *  - do NOT mask `--` (that is not a JS comment and must not blank later live DML
 *    after a string like `const s = '--'` or `const u = 'http://x'`)
 *
 * Inside template literals (typical SQL):
 *  - preserve template content for DML scan
 *  - mask SQL line comments `-- ...` and block comments `/* ... *\/` only within
 *    that template token (never blank later JS after the closing backtick)
 *  - handle `${ ... }` interpolations by re-entering JS code mode recursively
 *
 * Inside single/double-quoted JS strings: never treat `//`, `--`, or `/*` as comments.
 *
 * CONSEQUENCE, stated so it is not discovered later as a surprise: SQL-comment masking is a
 * TEMPLATE-LITERAL behaviour. A comment deliberately wedged between the words of a DML verb —
 * `INSERT/*c*\/INTO`, or `INSERT --c\n INTO` — is masked away, and so still seen, inside a
 * template literal; inside a single- or double-quoted string the bytes are preserved verbatim, so
 * the verb does not match and the site is NOT seen. This is narrow, not a general hole: ordinary
 * quoted SQL with no interleaved comment IS seen in all three token kinds. It is an evasion that
 * requires deliberately splitting a keyword inside a non-template string, and it belongs to the
 * already-stated "lowercase/mixed-case keyword" class of scanner limitations.
 */
function maskCommentsForDmlScan(content) {
  const src = String(content ?? '')
  const n = src.length
  let out = ''
  let i = 0
  /** @type {Array<'code' | 'squote' | 'dquote' | 'template' | 'template_expr'>} */
  const stack = ['code']
  /** One brace-depth counter for each nested template expression on the stack. */
  const templateExpressionBraceDepth = []

  function maskJsLineComment() {
    out += '  '
    i += 2
    while (i < n && src[i] !== '\n' && src[i] !== '\r') {
      out += ' '
      i += 1
    }
  }

  function maskJsBlockComment() {
    out += '  '
    i += 2
    while (i < n) {
      if (src[i] === '\n' || src[i] === '\r') {
        out += src[i]
        i += 1
        continue
      }
      if (src[i] === '*' && src[i + 1] === '/') {
        out += '  '
        i += 2
        return
      }
      out += ' '
      i += 1
    }
  }

  function maskSqlLineCommentInTemplate() {
    out += '  '
    i += 2
    while (i < n && src[i] !== '\n' && src[i] !== '\r' && src[i] !== '`') {
      out += ' '
      i += 1
    }
  }

  function maskSqlBlockCommentInTemplate() {
    out += '  '
    i += 2
    while (i < n && src[i] !== '`') {
      if (src[i] === '\n' || src[i] === '\r') {
        out += src[i]
        i += 1
        continue
      }
      if (src[i] === '*' && src[i + 1] === '/') {
        out += '  '
        i += 2
        return
      }
      out += ' '
      i += 1
    }
  }

  while (i < n) {
    const mode = stack[stack.length - 1]
    const ch = src[i]
    const next = src[i + 1]

    if (mode === 'code' || mode === 'template_expr') {
      if (ch === '/' && next === '/') {
        maskJsLineComment()
        continue
      }
      if (ch === '/' && next === '*') {
        maskJsBlockComment()
        continue
      }
      if (ch === "'" ) {
        stack.push('squote')
        out += ch
        i += 1
        continue
      }
      if (ch === '"') {
        stack.push('dquote')
        out += ch
        i += 1
        continue
      }
      if (ch === '`') {
        stack.push('template')
        out += ch
        i += 1
        continue
      }
      if (mode === 'template_expr' && ch === '{') {
        templateExpressionBraceDepth[templateExpressionBraceDepth.length - 1] += 1
        out += ch
        i += 1
        continue
      }
      if (mode === 'template_expr' && ch === '}') {
        const depthIndex = templateExpressionBraceDepth.length - 1
        if (templateExpressionBraceDepth[depthIndex] > 0) {
          templateExpressionBraceDepth[depthIndex] -= 1
          out += ch
          i += 1
          continue
        }
        stack.pop()
        templateExpressionBraceDepth.pop()
        out += ch
        i += 1
        continue
      }
      out += ch
      i += 1
      continue
    }

    if (mode === 'squote') {
      if (ch === '\\' && i + 1 < n) {
        out += ch
        out += src[i + 1]
        i += 2
        continue
      }
      if (ch === "'") {
        stack.pop()
        out += ch
        i += 1
        continue
      }
      out += ch
      i += 1
      continue
    }

    if (mode === 'dquote') {
      if (ch === '\\' && i + 1 < n) {
        out += ch
        out += src[i + 1]
        i += 2
        continue
      }
      if (ch === '"') {
        stack.pop()
        out += ch
        i += 1
        continue
      }
      out += ch
      i += 1
      continue
    }

    if (mode === 'template') {
      // Template SQL: mask SQL comments only inside this token.
      if (ch === '-' && next === '-') {
        maskSqlLineCommentInTemplate()
        continue
      }
      if (ch === '/' && next === '*') {
        maskSqlBlockCommentInTemplate()
        continue
      }
      if (ch === '\\' && i + 1 < n) {
        out += ch
        out += src[i + 1]
        i += 2
        continue
      }
      if (ch === '`' ) {
        stack.pop()
        out += ch
        i += 1
        continue
      }
      if (ch === '$' && next === '{') {
        out += '${'
        i += 2
        stack.push('template_expr')
        templateExpressionBraceDepth.push(0)
        continue
      }
      out += ch
      i += 1
      continue
    }

    out += ch
    i += 1
  }
  return out
}

/**
 * After structural comment masking, detect a live DML verb targeting a table.
 * Used by P15/P16 guards and tests — comments/examples never count.
 */
function hasLiveDmlOnTable(content, verb, table) {
  const masked = maskCommentsForDmlScan(String(content ?? ''))
  const sites = scanFileForDmlSites('__live_dml_probe__', masked)
  const verbNorm = String(verb).toLowerCase()
  // Case-folded on BOTH sides. Every caller of this helper asserts an ABSENCE
  // (`!hasLiveDmlOnTable(...)` — the P15 operator-cleanup and P16 guards assert that a generator
  // or module emits no live DELETE/UPDATE on a table), so matching more spellings can only make
  // those guards red more often: the fail-closed direction. A guard that says "this path never
  // deletes attendance_records" must not be satisfiable by a shift key.
  const tableNorm = String(table).toLowerCase()
  return sites.some((site) => site.verb === verbNorm && String(site.table).toLowerCase() === tableNorm)
}

// Scans one file's content for DML sites. Returns an array of raw sites (before bucket
// classification) with 1-based line numbers retained ONLY as informational metadata — the debt
// key never includes the line number (an unrelated edit elsewhere in the file must not red this
// guard). Comments and documentation examples are masked first so they cannot mint sites.
// --- statement fingerprint ---------------------------------------------------------------------
//
// The site identity (relPath, enclosingSymbol, table, verb) says WHERE a write is and WHAT it
// touches. It says nothing about what the statement DOES. Deleting the entire
// `WHERE org_id = $1 AND request_id = $2 AND …` from an approved tenant-scoped UPDATE — turning
// it into an unbounded, cross-tenant, table-wide UPDATE — changes no component of the identity,
// so the gate stayed green with byte-identical counters. That is not the substitution residue
// (which is about two different call sites colliding on one symbol name): the file, symbol, table
// and verb here are all the legitimate ones, and only the meaning of the SQL changed.
//
// The fingerprint closes that. It is deliberately a NORMALISED TEXT hash, not a parse:
//   - whitespace runs collapse to one space, so reformatting/indentation does NOT churn the gate
//     (measured: the same statement re-indented across six lines fingerprints identically);
//   - comments are already blanked by the masker, so a comment edit does not churn it either;
//   - case is folded, consistent with the identifier rule above;
//   - everything else is significant — a changed WHERE, a changed SET list, a changed target
//     column list, and a changed `${dynamicTable}` expression all move the hash (each measured).
// A parser would be narrower and would need a dialect; this is the fail-closed direction: it can
// only red MORE often than a semantic diff would, and every red is a real edit to a statement
// somebody once approved.
function normalizeStatementText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function statementFingerprintOf(text) {
  return sha256Hex(normalizeStatementText(text)).slice(0, 16)
}

// One pass per file producing the [start, end) content ranges of every JS string/template literal,
// so the per-site lookup is a scan of a small sorted array rather than a fresh O(file) walk each
// time. Same tokenisation rule as sqlLiteralContainingIndex, which it replaces for bulk use.
function sqlLiteralRanges(content) {
  const src = String(content ?? '')
  const ranges = []
  let quote = null
  let start = -1
  let escaped = false
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (quote !== null) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === quote) {
        ranges.push([start + 1, i])
        quote = null
        start = -1
      }
      continue
    }
    if (ch === '`' || ch === "'" || ch === '"') { quote = ch; start = i }
  }
  return ranges
}

// The statement text a site is fingerprinted over: the SQL literal containing it when there is
// one (the normal case — SQL in this codebase lives in template literals), otherwise a bounded
// slice from the verb to the end of the statement, for `.sql` and `.sh` files where the SQL is
// not wrapped in a JS literal at all. The fallback is bounded so a file with no `;` cannot make
// one site's fingerprint cover the whole file.
const STATEMENT_SLICE_LIMIT = 4000
function statementTextAt(masked, index, ranges) {
  for (const [start, end] of ranges) {
    if (start <= index && index < end) return masked.slice(start, end)
  }
  const semicolon = masked.indexOf(';', index)
  const end = semicolon === -1 ? Math.min(masked.length, index + STATEMENT_SLICE_LIMIT) : semicolon
  return masked.slice(index, Math.min(end, index + STATEMENT_SLICE_LIMIT))
}

function scanFileForDmlSites(relPath, content) {
  const masked = maskCommentsForDmlScan(content)
  const literalRanges = sqlLiteralRanges(masked)
  // Original lines for symbol attribution (function names live in non-comment code).
  const originalLines = String(content ?? '').split(/\r?\n/)
  const sites = []
  DML_LINE_PATTERN.lastIndex = 0
  let m
  while ((m = DML_LINE_PATTERN.exec(masked))) {
    const verb = verbFromKeyword(m[1])
    // `site.table` is the RESOLVED relation name (see resolveTableIdentifier): folded for an
    // unquoted identifier, verbatim for a double-quoted one. Everything downstream — ownership,
    // bucket classification, the debt key and the site identity — reads this resolved name, so
    // there is one spelling of a table per relation and no second code path to keep in step.
    const { table } = resolveTableIdentifier(m[2])
    if (SQL_RESERVED_NON_TABLE_WORDS.has(table.toUpperCase())) continue
    // §8.4 scans "staging-table CREATE/DROP/ALTER" — i.e. runtime staging-table lifecycle
    // (e.g. a temp table created inside an import-commit code path), not ordinary schema
    // migration DDL. Migration files legitimately reshape tables on every release; treating
    // every `ALTER TABLE` in a migration as source/effect/result debt would conflate schema
    // evolution with calculation-truth writes. Migration files are still scanned for real row
    // mutation (INSERT/UPDATE/DELETE backfills), just not for CREATE/DROP/ALTER TABLE.
    const isStagingDdlVerb = verb === 'staging_create' || verb === 'staging_drop' || verb === 'staging_alter'
    if (isStagingDdlVerb && isMigrationPath(relPath)) continue
    const lineIndex = lineIndexAt(masked, m.index)
    const statementFingerprint = statementFingerprintOf(statementTextAt(masked, m.index, literalRanges))
    sites.push({
      relPath,
      line: lineIndex + 1,
      verb,
      table,
      enclosingSymbol: nearestEnclosingSymbol(originalLines, lineIndex),
      statementFingerprint,
    })

    // Remaining targets of a `TRUNCATE a, b, c` / `DROP TABLE a, b` list. Each becomes its own
    // site at its own line, so a second target can neither hide behind the first nor collapse
    // into it. Placed AFTER the staging-DDL/migration `continue` above on purpose: if the first
    // target of a statement is out of scope for a reason, every target of that statement is.
    if (MULTI_TARGET_VERBS.has(verb)) {
      TABLE_LIST_CONTINUATION.lastIndex = m.index + m[0].length
      let continuation
      while ((continuation = TABLE_LIST_CONTINUATION.exec(masked)) !== null) {
        const { table: nextTable } = resolveTableIdentifier(continuation[1])
        if (SQL_RESERVED_NON_TABLE_WORDS.has(nextTable.toUpperCase())) break
        const nextLineIndex = lineIndexAt(masked, continuation.index)
        sites.push({
          relPath,
          line: nextLineIndex + 1,
          verb,
          table: nextTable,
          enclosingSymbol: nearestEnclosingSymbol(originalLines, nextLineIndex),
          // Every target of one statement shares that statement's fingerprint — they are the
          // same statement, and a change to it must red all of them together.
          statementFingerprint,
        })
      }
    }
  }
  return sites
}

function lineIndexAt(content, index) {
  return content.slice(0, index).split(/\r?\n/).length - 1
}

function isDeleteTargetAt(content, fromIndex) {
  return /\bDELETE\s*$/i.test(content.slice(Math.max(0, fromIndex - 32), fromIndex))
}

function collectDynamicReadSites(content, lines, tableNames) {
  const alternation = [...tableNames]
    .sort((a, b) => b.length - a.length)
    .map((table) => table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  const literalPattern = new RegExp(`(['"\`])(${alternation})\\1`, 'g')
  const declarationPattern = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*/g
  const valueBindings = []
  const latestBinding = (values, identifier, beforeIndex) => [...values]
    .reverse()
    .find((binding) => binding.identifier === identifier && binding.index < beforeIndex)
  let match
  while ((match = declarationPattern.exec(content))) {
    literalPattern.lastIndex = 0
    const literal = literalPattern.exec(content.slice(declarationPattern.lastIndex))
    if (literal?.index === 0) {
      valueBindings.push({ identifier: match[1], index: match.index, tables: new Set([literal[2]]) })
    }
  }

  const arrayPattern = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*\[([\s\S]*?)\]/g
  while ((match = arrayPattern.exec(content))) {
    literalPattern.lastIndex = 0
    let literal
    const tables = new Set()
    while ((literal = literalPattern.exec(match[2]))) tables.add(literal[2])
    if (tables.size > 0) valueBindings.push({ identifier: match[1], index: match.index, tables })
  }
  valueBindings.sort((a, b) => a.index - b.index)

  const forOfBindings = []
  const forOfPattern = /\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+of\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\)/g
  while ((match = forOfPattern.exec(content))) {
    const sourceBinding = latestBinding(valueBindings, match[2], match.index)
    forOfBindings.push({
      identifier: match[1],
      index: match.index,
      tables: new Set(sourceBinding?.tables || []),
    })
  }

  const inlineForOfPattern = /\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+of\s+\[([\s\S]*?)\]\s*\)/g
  while ((match = inlineForOfPattern.exec(content))) {
    literalPattern.lastIndex = 0
    let literal
    const tables = new Set()
    while ((literal = literalPattern.exec(match[2]))) tables.add(literal[2])
    forOfBindings.push({ identifier: match[1], index: match.index, tables })
  }

  const sites = []
  DYNAMIC_READ_PATTERN.lastIndex = 0
  while ((match = DYNAMIC_READ_PATTERN.exec(content))) {
    const lineIndex = lineIndexAt(content, match.index)
    if (isDeleteTargetAt(content, match.index)) continue
    const enclosingSymbol = nearestEnclosingSymbol(lines, lineIndex)
    const resolved = new Set()

    literalPattern.lastIndex = 0
    let literal
    while ((literal = literalPattern.exec(match[1]))) resolved.add(literal[2])

    JS_IDENTIFIER_PATTERN.lastIndex = 0
    let identifier
    while ((identifier = JS_IDENTIFIER_PATTERN.exec(match[1]))) {
      const binding = latestBinding(
        [...valueBindings, ...forOfBindings].sort((a, b) => a.index - b.index),
        identifier[0],
        match.index,
      )
      for (const table of binding?.tables || []) resolved.add(table)
    }

    for (const table of resolved) {
      sites.push({ lineIndex, index: match.index, table, enclosingSymbol, dynamic: true })
    }
  }
  return sites
}

// P25 needs more than the DML census: operational state becomes dangerous when a caller reads
// it as authority. This deliberately scans only SQL table positions (DML targets plus FROM/JOIN),
// not every string occurrence, and preserves the same nearest-symbol attribution used by the
// existing generated inventory.
function scanFileForP25CallPathSites(relPath, content) {
  const lines = content.split(/\r?\n/)
  const sites = scanFileForDmlSites(relPath, content)
    .filter((site) => P25_OPERATIONAL_TABLE_SPECS[site.table])
    .map((site) => ({ ...site, access: 'write' }))

  P25_READ_TABLE_PATTERN.lastIndex = 0
  let match
  while ((match = P25_READ_TABLE_PATTERN.exec(content))) {
    const lineIndex = lineIndexAt(content, match.index)
    // DELETE FROM names its write target, not a second read. INSERT ... SELECT and UPDATE ...
    // FROM still retain their source-table read, which is the evidence this guard needs.
    if (isDeleteTargetAt(content, match.index)) continue
    sites.push({
      relPath,
      line: lineIndex + 1,
      verb: 'select',
      table: match[1],
      enclosingSymbol: nearestEnclosingSymbol(lines, lineIndex),
      access: 'read',
    })
  }
  for (const dynamic of collectDynamicReadSites(
    content,
    lines,
    Object.keys(P25_OPERATIONAL_TABLE_SPECS),
  )) {
    sites.push({
      relPath,
      line: dynamic.lineIndex + 1,
      verb: 'select',
      table: dynamic.table,
      enclosingSymbol: dynamic.enclosingSymbol,
      access: 'read',
      dynamic: true,
    })
  }
  return sites
}

function scanFileForAttendanceRecordReadSites(relPath, content) {
  const lines = content.split(/\r?\n/)
  const sites = []
  ATTENDANCE_RECORD_READ_PATTERN.lastIndex = 0
  let match
  while ((match = ATTENDANCE_RECORD_READ_PATTERN.exec(content))) {
    const table = match[1]
    const lineIndex = lineIndexAt(content, match.index)
    if (isDeleteTargetAt(content, match.index)) continue
    sites.push({
      relPath,
      line: lineIndex + 1,
      table,
      enclosingSymbol: nearestEnclosingSymbol(lines, lineIndex),
    })
  }

  for (const dynamic of collectDynamicReadSites(
    content,
    lines,
    ['attendance_records', 'attendance_current_records'],
  )) {
    sites.push({
      relPath,
      line: dynamic.lineIndex + 1,
      table: dynamic.table,
      enclosingSymbol: dynamic.enclosingSymbol,
      dynamic: true,
    })
  }
  return sites
}

// W4C-4 §12.7: calculation/segment reads must not inherit the attendance-record
// inventory's allowlist. Every direct read receives an explicit current or history owner.
function scanFileForAttendanceCalculationReadSites(relPath, content) {
  const lines = content.split(/\r?\n/)
  const sites = []
  ATTENDANCE_CALCULATION_READ_PATTERN.lastIndex = 0
  let match
  while ((match = ATTENDANCE_CALCULATION_READ_PATTERN.exec(content))) {
    const lineIndex = lineIndexAt(content, match.index)
    if (isDeleteTargetAt(content, match.index)) continue
    sites.push({
      relPath,
      line: lineIndex + 1,
      table: match[1],
      enclosingSymbol: nearestEnclosingSymbol(lines, lineIndex),
      requiredPredicateFingerprint: requiredPredicateFingerprint(content, match.index),
    })
  }
  for (const dynamic of collectDynamicReadSites(
    content,
    lines,
    ['attendance_record_calculations', 'attendance_record_segments'],
  )) {
    sites.push({
      relPath,
      line: dynamic.lineIndex + 1,
      table: dynamic.table,
      enclosingSymbol: dynamic.enclosingSymbol,
      dynamic: true,
      requiredPredicateFingerprint: requiredPredicateFingerprint(content, dynamic.index),
    })
  }
  return sites
}

// Builds the full raw census across every scannable file under the discovered runtime roots.
// `source` supplies `readFile(relPath) -> string|null` and `listAllFiles(rootDir) -> relPath[]`.
function buildRawCensus(source) {
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
      for (const site of scanFileForDmlSites(relPath, content)) {
        sites.push(site)
      }
    }
  }
  sites.sort((a, b) => (a.relPath === b.relPath ? a.line - b.line : a.relPath < b.relPath ? -1 : 1))
  return { roots, sites }
}

function buildP25CallPathCensus(source) {
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
      sites.push(...scanFileForP25CallPathSites(relPath, content))
    }
  }
  sites.sort((a, b) => (a.relPath === b.relPath ? a.line - b.line : a.relPath < b.relPath ? -1 : 1))
  return { roots, sites }
}

function buildAttendanceRecordReadCensus(source) {
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
      sites.push(...scanFileForAttendanceRecordReadSites(relPath, content))
    }
  }
  sites.sort((a, b) => (a.relPath === b.relPath ? a.line - b.line : a.relPath < b.relPath ? -1 : 1))
  return { roots, sites }
}

function buildAttendanceCalculationReadCensus(source) {
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
      sites.push(...scanFileForAttendanceCalculationReadSites(relPath, content))
    }
  }
  sites.sort((a, b) => (a.relPath === b.relPath ? a.line - b.line : a.relPath < b.relPath ? -1 : 1))
  return { roots, sites }
}

// Scope gate: this collector only tracks *attendance-owned* tables (attendance_* plus the small
// named shared-approval set §8.4 calls out by name). Every other table hit anywhere in the
// workspace (thousands of them, across other products) is simply out of scope — not reported,
// not counted as "unclassified" — because §8.4's "unclassified table... fails CI" language is
// scoped to attendance-owned discovery ("additional attendance-owned source/effect tables"), not
// to the whole monorepo's schema.
const SHARED_TABLE_NAMES = new Set(['approval_instances', 'approval_records', 'approval_assignments'])

function isAttendanceOwnedName(name) {
  return name.startsWith('attendance_') || SHARED_TABLE_NAMES.has(name)
}

// Scope test on the RESOLVED identifier (already folded when unquoted), UNION its case-folded
// form. The union is what makes the quoted axis fail closed: `"Attendance_Records"` resolves
// verbatim and is not literally an attendance-owned name, but it is one shift key away from one,
// so it is admitted to scope and then reds as an unclassified table rather than being dropped in
// silence. Union-only, never intersection: this predicate can only ever put MORE sites in scope
// than the exact-match form it replaced, so no site that was tracked before can stop being
// tracked because of it.
function isAttendanceOwnedCandidate(tableName) {
  const name = String(tableName)
  return isAttendanceOwnedName(name) || isAttendanceOwnedName(name.toLowerCase())
}

function isCanonicalBoundaryPath(relPath) {
  return W4_CANONICAL_PATH_PREFIXES.some((prefix) => relPath.startsWith(prefix))
}

// Coarse 50-line block index. The nearest-preceding-symbol heuristic reuses generic local helper
// names (e.g. a small `const dataTypeFor = (key) => ...` closure declared right before a SQL
// block, repeated verbatim at unrelated locations thousands of lines apart in the same file) —
// without a tiebreaker, two genuinely different call sites that happen to share a nearby helper
// name would collide onto the same debt key and hide one bypass behind the other's legitimacy.
// A 50-line block is coarse enough that ordinary nearby edits (adding a field, a log line, a
// comment) do not cross a boundary and red the guard, while still separating call sites that are
// hundreds or thousands of lines apart. This is a heuristic disambiguator, not a claim that the
// key is immune to every possible line-shift — see the collector's own limitations note.
function blockIndexForLine(line) {
  return Math.floor((line - 1) / 50)
}

// debt key: stable across small unrelated line-number shifts; renames/moves naturally show up as
// one key disappearing and another appearing (which the caller treats as "removed" + "new").
function debtKey(site) {
  return `${site.bucket}::${site.relPath}::${site.table}::${site.verb}::${site.enclosingSymbol}::b${blockIndexForLine(site.line)}`
}

// Classifies a raw census into:
//   - trackedSites: business/schedule_fact/shared_hook bucket sites (require curated P0x match)
//   - bucketAllowlistedSites: operational/reference bucket sites (allowlisted, no P0x needed)
//   - canonicalSites: w4_canonical-bucket sites inside the canonical path prefix (allowlisted)
//   - outsideBoundarySites: w4_canonical-bucket sites OUTSIDE the canonical path prefix (hard fail)
//   - unclassifiedTableSites: table not present in table-classification.cjs at all (hard fail)
function classifyCensus(rawSites) {
  const trackedSites = []
  const bucketAllowlistedSites = []
  const canonicalSites = []
  const outsideBoundarySites = []
  const unclassifiedTableSites = []

  for (const site of rawSites) {
    if (!isAttendanceOwnedCandidate(site.table)) continue
    const bucket = classifyTable(site.table)
    if (!bucket) {
      unclassifiedTableSites.push(site)
      continue
    }
    const p25 = P25_OPERATIONAL_TABLE_SPECS[site.table]
    const classified = p25 ? { ...site, bucket, p25 } : { ...site, bucket }
    if (bucket === 'w4_canonical') {
      if (isCanonicalBoundaryPath(site.relPath)) {
        canonicalSites.push(classified)
      } else {
        outsideBoundarySites.push(classified)
      }
      continue
    }
    if (TRACKED_BUCKETS.includes(bucket)) {
      trackedSites.push({ ...classified, key: debtKey(classified) })
      continue
    }
    bucketAllowlistedSites.push(classified)
  }

  return { trackedSites, bucketAllowlistedSites, canonicalSites, outsideBoundarySites, unclassifiedTableSites }
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

// Canonical, order-independent content hash over a set of tracked-site keys (used both for the
// pinned baseline artifact's own integrity hash and for per-debt-entry content hashes).
function contentHashOfKeys(keys) {
  const sorted = [...keys].sort()
  return sha256Hex(sorted.join('\n'))
}

module.exports = {
  discoverRuntimeRoots,
  parseWorkspacePatterns,
  isScannablePath,
  maskCommentsForDmlScan,
  resolveTableIdentifier,
  statementFingerprintOf,
  normalizeStatementText,
  statementTextAt,
  sqlLiteralRanges,
  hasLiveDmlOnTable,
  scanFileForDmlSites,
  scanFileForP25CallPathSites,
  scanFileForAttendanceRecordReadSites,
  scanFileForAttendanceCalculationReadSites,
  buildRawCensus,
  buildP25CallPathCensus,
  buildAttendanceRecordReadCensus,
  buildAttendanceCalculationReadCensus,
  classifyCensus,
  debtKey,
  isCanonicalBoundaryPath,
  isAttendanceOwnedCandidate,
  contentHashOfKeys,
  sha256Hex,
}

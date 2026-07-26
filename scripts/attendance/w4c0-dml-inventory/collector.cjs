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

const { classifyTable, TRACKED_BUCKETS, W4_CANONICAL_PATH_PREFIXES } = require('./table-classification.cjs')

const SCANNABLE_EXTENSIONS = new Set(['.ts', '.js', '.cjs', '.mjs', '.sql', '.sh'])

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

// Discover workspace package root directories (each dir that both matches a pnpm-workspace.yaml
// pattern AND has its own package.json) plus the extra named roots. `source` supplies
// `readFile(relPath) -> string|null` and `listDir(relDir) -> string[]` (empty array if absent).
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
  const packageRoots = []
  for (const dir of candidateDirs) {
    if (source.readFile(`${dir}/package.json`) != null) {
      packageRoots.push(dir)
    }
  }
  const roots = [...packageRoots, ...EXTRA_NAMED_ROOTS].sort()
  return roots
}

// --- DML statement scanning -------------------------------------------------------------------

// Matches the verb + immediately-following bare/quoted table identifier for the statement forms
// named in §8.4: INSERT/UPDATE/DELETE/TRUNCATE/MERGE, COPY FROM|TO, and staging CREATE/DROP/ALTER
// TABLE. Multi-line statements are matched per physical line (a template literal that splits
// `INSERT INTO\n  table` across lines will not be caught here — see the collector's stated
// limitations in the CI test/handoff, not silently claimed as covered).
// Case-sensitive by design: this codebase's real SQL is written in uppercase keywords
// (verified against the runtime roots before this pattern was chosen); a case-insensitive
// pattern instead matches ordinary English prose in comments ("update a record") and floods the
// census with non-SQL noise. A lowercase/mixed-case SQL keyword bypassing this scan is a stated
// collector limitation (see the collector's own CI test and the Stage D handoff note), not a
// silently-claimed guarantee.
const DML_LINE_PATTERN =
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|MERGE\s+INTO|COPY|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|ALTER\s+TABLE)\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?/g

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
  if (k.startsWith('CREATE TABLE')) return 'staging_create'
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
  /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/,
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

// Scans one file's content for DML sites. Returns an array of raw sites (before bucket
// classification) with 1-based line numbers retained ONLY as informational metadata — the debt
// key never includes the line number (an unrelated edit elsewhere in the file must not red this
// guard).
function scanFileForDmlSites(relPath, content) {
  const lines = content.split(/\r?\n/)
  const sites = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    DML_LINE_PATTERN.lastIndex = 0
    let m
    while ((m = DML_LINE_PATTERN.exec(line))) {
      const verb = verbFromKeyword(m[1])
      const table = m[2]
      if (SQL_RESERVED_NON_TABLE_WORDS.has(table.toUpperCase())) continue
      // §8.4 scans "staging-table CREATE/DROP/ALTER" — i.e. runtime staging-table lifecycle
      // (e.g. a temp table created inside an import-commit code path), not ordinary schema
      // migration DDL. Migration files legitimately reshape tables on every release; treating
      // every `ALTER TABLE` in a migration as source/effect/result debt would conflate schema
      // evolution with calculation-truth writes. Migration files are still scanned for real row
      // mutation (INSERT/UPDATE/DELETE backfills), just not for CREATE/DROP/ALTER TABLE.
      const isStagingDdlVerb = verb === 'staging_create' || verb === 'staging_drop' || verb === 'staging_alter'
      if (isStagingDdlVerb && isMigrationPath(relPath)) continue
      sites.push({
        relPath,
        line: i + 1,
        verb,
        table,
        enclosingSymbol: nearestEnclosingSymbol(lines, i),
      })
    }
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

// Scope gate: this collector only tracks *attendance-owned* tables (attendance_* plus the small
// named shared-approval set §8.4 calls out by name). Every other table hit anywhere in the
// workspace (thousands of them, across other products) is simply out of scope — not reported,
// not counted as "unclassified" — because §8.4's "unclassified table... fails CI" language is
// scoped to attendance-owned discovery ("additional attendance-owned source/effect tables"), not
// to the whole monorepo's schema.
const SHARED_TABLE_NAMES = new Set(['approval_instances', 'approval_records', 'approval_assignments'])

function isAttendanceOwnedCandidate(tableName) {
  return tableName.startsWith('attendance_') || SHARED_TABLE_NAMES.has(tableName)
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
    const classified = { ...site, bucket }
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
  scanFileForDmlSites,
  buildRawCensus,
  classifyCensus,
  debtKey,
  isCanonicalBoundaryPath,
  isAttendanceOwnedCandidate,
  contentHashOfKeys,
  sha256Hex,
}

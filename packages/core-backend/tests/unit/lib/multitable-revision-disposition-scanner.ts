/**
 * OD-6 revision-disposition guard — scanner core.
 *
 * Pure, file-I/O-free functions so the defeat-then-fix proofs (see
 * `multitable-revision-disposition-scanner.test.ts`) can feed synthetic source strings directly,
 * without ever touching a real tracked file on disk.
 *
 * Supersedes the #4227 draft's line-by-line, case-sensitive scanner. Two proven blockers fixed here:
 *
 *   1. CASE-INSENSITIVE + MULTILINE. The #4227 scanner tested `MUTATION_RE` against ONE LINE AT A TIME
 *      with no `i` flag. A live-guard mutation proved: an unmarked UPPERCASE `UPDATE meta_records` reds
 *      the guard, but the LOWERCASE twin passes undetected, and a verb/table split across two lines
 *      (`UPDATE\n  meta_records`) is invisible to a per-line test. This scanner instead comment-strips
 *      the WHOLE FILE (preserving every character's line position — see `stripComments`), then runs one
 *      case-insensitive, `\s+`-tolerant regex over the whole text with `matchAll`. `\s` already matches
 *      `\n`, so a verb and `meta_records` on separate lines still match one statement.
 *
 *   2. STABLE SITE IDS, NOT LINE NUMBERS. The #4227 scanner keyed its `PENDING_REVISION_SITES` allowlist
 *      by literal `(file, line)`, so ANY edit above a pending site silently drifted its line number and
 *      broke the allowlist. This scanner instead hashes `(file, enclosing-anchor, statement fingerprint,
 *      occurrence-index)` — content the edit doesn't touch — into a `siteId` that survives unrelated
 *      edits above it (proven by `scanner.stability.test.ts`'s "insert 3 lines above, siteId unchanged").
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export type Disposition = 'EMITTED' | 'EXEMPT' | 'PENDING'

export interface Site {
  file: string
  /** 1-based line where the mutation VERB (INSERT/UPDATE/DELETE) starts. */
  line: number
  /** The matched line's trimmed text, for readable failure messages. */
  sql: string
  disposition: Disposition | null
  /** Nearest enclosing function/route name — see `findEnclosingAnchor`. Debug/readability aid only. */
  anchor: string
  /** Stable content hash — see module docstring point 2. */
  siteId: string
}

/** How many physical lines ABOVE (through) the statement's start line a marker may sit. Mirrors the
 *  rank-8 lock guard's own `MARKER_WINDOW` exactly (`multitable-record-lock-guard.guard.test.ts:74`),
 *  so a marker legal for one guard is legal for the other and a contributor learns one convention. */
export const MARKER_WINDOW = 3

/**
 * Every form a `meta_records` row-mutation can take in this codebase: raw SQL (case-insensitive, verb
 * and table name may be split across lines by `\s+`) and the Kysely query-builder forms, added
 * pre-emptively exactly as the rank-8 guard does for its own MUTATION_RE.
 */
export const MUTATION_RE =
  /\b(?:INSERT\s+INTO\s+meta_records|UPDATE\s+meta_records|DELETE\s+FROM\s+meta_records)\b|(?:updateTable|deleteFrom|insertInto)\(\s*['"`]meta_records['"`]/gi

/**
 * Replace every `//...` and `/* ... *\/` comment with equal-length whitespace (newlines preserved, so
 * line numbers computed on the result exactly match the original source) while leaving string/template
 * literal CONTENTS untouched byte-for-byte — the SQL text the guard needs to see lives inside backtick
 * template literals, so stripping comments must never touch quoted content. A single left-to-right state
 * machine (not two independent regex passes) so a `//` inside a string is never mistaken for a comment
 * start, and a comment-only mention of `UPDATE meta_records` (e.g. in a docstring) can never register as
 * a mutation site.
 */
export function stripComments(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const c2 = i + 1 < n ? src[i + 1] : ''
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' '
        i += 1
      }
      continue
    }
    if (c === '/' && c2 === '*') {
      out += '  '
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i += 1
      }
      if (i < n) {
        out += '  '
        i += 2
      }
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      out += c
      i += 1
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          out += src[i] + src[i + 1]
          i += 2
          continue
        }
        out += src[i]
        i += 1
      }
      if (i < n) {
        out += src[i]
        i += 1
      }
      continue
    }
    out += c
    i += 1
  }
  return out
}

function computeLineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1)
  }
  return starts
}

/** 0-based line index containing character offset `offset`, via binary search over line-start offsets. */
function lineIndexForOffset(lineStarts: number[], offset: number): number {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (lineStarts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * `window` is always a slice of RAW source lines (never comment-stripped), so a marker mid-sentence
 * inside an existing `//` comment block still counts — this deliberately does NOT require `revision-
 * emitted:` to be the first token after `//`. That flexibility is load-bearing in this codebase: several
 * mutation sites already carry an adjacent marker from ANOTHER structural guard (rank-8's `lock-guarded:`
 * / the cross-base write guard's `xbase-write-gated:`) sitting at or near that guard's own window
 * boundary — adding a brand-new physical line here would push THAT marker outside ITS window and
 * regress a different guard (this exact collision, and its fix, is documented at
 * `automation-executor.ts` around the `executeCreateRecord` INSERT: the revision-emitted marker is
 * appended to the end of the existing `xbase-write-gated:` comment's last physical line rather than
 * added as a new line). Requiring the marker to start a comment would forbid that safe co-location.
 */
function classify(window: string): Disposition | null {
  if (/revision-emitted:/.test(window)) return 'EMITTED'
  if (/revision-exempt:/.test(window)) return 'EXEMPT'
  if (/revision-pending:/.test(window)) return 'PENDING'
  return null
}

/**
 * Nearest enclosing anchor for a mutation site, scanning UPWARD from its own line over the
 * comment-stripped text. Not a real parser (no brace-depth tracking) — a heuristic "nearest declaration
 * line above" — but that is enough for the stability property this scanner needs: the anchor only
 * changes when a contributor edits content genuinely between the site and its true enclosing
 * declaration, which is a categorically rarer event than "any edit anywhere above the file" (the failure
 * mode `siteId` exists to survive). Route handlers (`router.post('/path', async (req,res) => {...})`)
 * are anonymous, so they fall back to a `route:<method>:<path>` anchor instead of a function name.
 */
const ANCHOR_PATTERNS: RegExp[] = [
  /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/,
  /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*async\s+function\b/,
  // Arrow-function assignment ONLY — requires a `=>` on the same line, so a plain parenthesized
  // non-function expression (`const targetSheetId = (a ?? b)`) is not mistaken for a function anchor.
  /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*[^=]+)?=>/,
  /router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/,
  // Class/object method `name(args) {` — excludes JS/TS control-flow keywords that share this shape
  // (`if (...) {`, `for (...) {`, `while (...) {`, `switch (...) {`, `catch (...) {`) so a mutation
  // inside a conditional does not get anchored to the meaningless literal name "if"/"for".
  /^\s*(?:private\s+|public\s+|protected\s+|static\s+|async\s+)*(?!if\b|for\b|while\b|switch\b|catch\b|function\b|else\b|return\b|do\b)(\w+)\s*\([^()]*\)\s*(?::\s*[^{]+)?\{\s*$/,
]

export function findEnclosingAnchor(strippedLines: string[], matchLineIdx: number): string {
  for (let i = matchLineIdx; i >= 0; i -= 1) {
    const line = strippedLines[i]
    for (const re of ANCHOR_PATTERNS) {
      re.lastIndex = 0
      const m = re.exec(line)
      if (!m) continue
      if (m.length >= 3 && m[2]) return `route:${m[1]}:${m[2]}`
      if (m[1]) return m[1]
    }
  }
  return '<module-scope>'
}

function normalizeStatement(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/** Stable content hash: (file, anchor, statement fingerprint, occurrence-index) — never a line number. */
export function hashSite(file: string, anchor: string, fingerprint: string, occurrence: number): string {
  return createHash('sha1').update(`${file}::${anchor}::${fingerprint}::${occurrence}`).digest('hex').slice(0, 16)
}

/**
 * Enumerate every `meta_records` mutation site in `src` (whole-file, case-insensitive, multiline-aware —
 * see module docstring). Pure function: takes source text directly, never touches disk. This is what the
 * defeat-then-fix proofs and the stability proofs call directly with synthetic fixtures.
 */
interface Draft {
  file: string
  line: number
  sql: string
  disposition: Disposition | null
  anchor: string
  fingerprint: string
}

export function enumerateSites(file: string, src: string): Site[] {
  const stripped = stripComments(src)
  const rawLines = src.split('\n')
  const strippedLines = stripped.split('\n')
  const lineStarts = computeLineStarts(stripped)

  const drafts: Draft[] = []
  for (const match of stripped.matchAll(MUTATION_RE)) {
    const idx = match.index ?? 0
    const lineIdx = lineIndexForOffset(lineStarts, idx)
    const windowStart = Math.max(0, lineIdx - MARKER_WINDOW)
    const window = rawLines.slice(windowStart, lineIdx + 1).join('\n')
    const anchor = findEnclosingAnchor(strippedLines, lineIdx)
    const fingerprint = normalizeStatement(strippedLines.slice(lineIdx, lineIdx + 6).join(' '))
    drafts.push({
      file,
      line: lineIdx + 1,
      sql: rawLines[lineIdx].trim(),
      disposition: classify(window),
      anchor,
      fingerprint,
    })
  }

  // Assign an occurrence index to disambiguate byte-identical (file, anchor, fingerprint) siblings, in
  // file-appearance order, THEN hash — this is what makes two identical UPDATEs in the same function
  // (e.g. LOCK / UNLOCK twins that happened to normalize the same, which none of ours do, but a future
  // one might) still get distinct, stable ids instead of colliding silently.
  const seen = new Map<string, number>()
  return drafts.map(({ fingerprint, ...rest }): Site => {
    const key = `${rest.file}::${rest.anchor}::${fingerprint}`
    const occurrence = seen.get(key) ?? 0
    seen.set(key, occurrence + 1)
    const siteId = hashSite(rest.file, rest.anchor, fingerprint, occurrence)
    return { ...rest, siteId }
  })
}

/**
 * Recursively list every runtime `.ts` file under `src/`, relative to `src/` with `/` separators.
 * Mirrors `multitable-record-lock-guard.guard.test.ts`'s `listRuntimeTsFiles` exactly (same exclusions:
 * `node_modules`, `dist`, `migrations`, `.d.ts`/`.test.ts`/`.spec.ts`) so the two guards see the same
 * mutation surface and neither can be evaded by hiding a new sink where the other guard already scans.
 */
export function listRuntimeTsFiles(srcRoot: string): string[] {
  const out: string[] = []
  const walk = (absDir: string): void => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const abs = join(absDir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'migrations') continue
        walk(abs)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue
      if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts')) continue
      out.push(relative(srcRoot, abs).split(sep).join('/'))
    }
  }
  walk(srcRoot)
  return out
}

export function readSrcFile(srcRoot: string, relFile: string): string {
  return readFileSync(join(srcRoot, relFile), 'utf8')
}

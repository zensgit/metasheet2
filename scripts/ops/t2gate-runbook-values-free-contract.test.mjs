import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// T2-Gate values-free evidence contract (no DB).
//
// "Values-free" = no raw provider identity / business values / raw SQL error text.
// Provenance is allowed: exact SHA, execution date/actor, internal integration resource IDs.
// SQL outputs remain booleans/counts/statuses only.
//
// The staging runbook claims values-free operator evidence, but PostgreSQL duplicate-key
// text can embed the real external_key / unionId. Operator-facing SQL and the §4 evidence
// block must therefore NEVER project, print, grep, copy, or persist raw error_message /
// err-head output. Closed booleans/classifications only:
//   status + duplicate_key_detected + expected_constraint_detected
//
// Load-bearing invariant for fenced SQL: every top-level SELECT projection that *references*
// error_message must be EXACTLY one of the two closed boolean expression families used by
// the runbook (whitespace/case tolerant), ending in the matching AS alias:
//
//   (error_message IS NOT NULL AND position('duplicate key' in error_message) > 0)
//     AS duplicate_key_detected
//   (error_message IS NOT NULL
//     AND position('idx_directory_accounts_provider_external_key' in error_message) > 0)
//     AS expected_constraint_detected
//
// Alias-only validation is NOT enough: `substring(error_message,1,120) AS duplicate_key_detected`
// and `error_message AS expected_constraint_detected` must fail. Direct projection, other
// aliases (preview/err), and arbitrary string functions under an allowed alias must fail.
//
// The runbook's own values-free definition (§2) has THREE clauses:
//   (1) no raw provider identity (unionId / openId / userId / corpId)
//   (2) no business values (names / mobile / email / …)
//   (3) no raw SQL error text
// Everything above enforces clause (3) only. Clauses (1)+(2) are enforced below by
// `assertNoRawIdentityProjections` (fenced SQL projection lists) and
// `assertNoRawIdentityPasteInstructions` (operator prose), while KEEPING the values-free
// forms the runbook legitimately uses: length(), count()/count(*) FILTER (WHERE …),
// IS [NOT] NULL, and column-to-column equality.
//
// STRICT FENCE CONTRACT (owner ruling 2026-07-21, round 5 of PR #4500): ALL SQL in this runbook
// must live inside a scanned code venue. Outside venues, ANY `SELECT … FROM` shape is a
// violation, full stop — no vocabulary test, no prose exemption, no structural cleverness
// (see `findUnfencedSelectFromShapes`). Inside venues, the closed projection allowlist below
// stays exactly as it is.
//
// Verdict grounding: the §4 verdict field may only hold the placeholder OR one of the three
// ruled values, and a filled verdict must be accompanied by the evidence it depends on.
// (A whole-file /_TBD_/ assert cannot express that: §4 has 11 _TBD_ lines, so ANY survivor
// satisfies it — a fabricated `verdict: DISPROVED` passes while the legitimate completed
// state, with no _TBD_ left anywhere, fails. That inverted guard is replaced below.)
//
// Load-bearing: runs in the gating no-DB job (same T2-Gate CI command as the wiring guard).
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const RUNBOOK = join(
  repoRoot,
  'docs/development/canonical-org-t2-gate-two-corp-staging-runbook-20260717.md',
)

const ALLOWED_ERROR_MESSAGE_ALIASES = new Set([
  'duplicate_key_detected',
  'expected_constraint_detected',
])

/**
 * Exact closed-boolean expression families pinned to the runbook (optional outer parens;
 * whitespace/case tolerant on keywords/idents; string literals fixed).
 * Matched against the projection BODY only (everything before trailing AS <alias>).
 */
const CLOSED_BOOLEAN_BODY_BY_ALIAS = {
  // error_message IS NOT NULL AND position('duplicate key' in error_message) > 0
  duplicate_key_detected:
    /^\(?\s*error_message\s+IS\s+NOT\s+NULL\s+AND\s+position\s*\(\s*'duplicate key'\s+IN\s+error_message\s*\)\s*>\s*0\s*\)?$/i,
  // error_message IS NOT NULL AND position('idx_directory_accounts_provider_external_key' in error_message) > 0
  expected_constraint_detected:
    /^\(?\s*error_message\s+IS\s+NOT\s+NULL\s+AND\s+position\s*\(\s*'idx_directory_accounts_provider_external_key'\s+IN\s+error_message\s*\)\s*>\s*0\s*\)?$/i,
}

/** Regex surface bans that still catch evidence-block / prose regressions. */
const FORBIDDEN_RAW_ERROR_OUTPUT = [
  /\bas\s+err_head\b/i,
  /\bas\s+err\b/i,
  /\berr\s+head\b/i,
  /\berror_message\b[^\n]{0,40}\bnames\b/i,
  /status\s*\/\s*err/i,
]

function loadRunbook() {
  return readFileSync(RUNBOOK, 'utf8')
}

/**
 * Every VENUE a reader sees as a code block — scanned as a closed set, not as a denylist of
 * delimiters.
 *
 * Gate finding (audit follow-up, PR #4500): the projection FORMS were closed into an allowlist,
 * but the venues stayed open-ended — only BACKTICK fences were ever recognised. GitHub renders a
 * `~~~sql` (tilde) fence and an HTML `<pre>` block identically to ```` ```sql ````, so the same
 * identity SELECT passed every guard untouched simply by choosing a different delimiter. A guard's
 * visibility must not depend on which equivalent delimiter an editor happens to use.
 *
 * Recognised venues:
 *   - backtick fences  ```` ```[info] … ``` ````            (CommonMark: close repeats the same
 *   - tilde fences     `~~~[info] … ~~~`                     character at least as many times)
 *   - HTML blocks      `<pre …> … </pre>` / `<code …> … </code>`
 *
 * Owner ruling (round 3 of PR #4500): the COMPLETE info string is part of the fence, not just a
 * bare language word. The first cut required the info string to be a single `[A-Za-z0-9_+-]*`
 * token, so ```` ```sql linenums ```` and `~~~sql title=probe` — both of which GitHub renders as
 * ordinary SQL blocks — did not match the open-fence pattern at all, and their bodies were never
 * scanned by any guard (verified: both returned ok:true). Any language tag plus arbitrary
 * attributes is now accepted, on either delimiter; the language tag is merely the first token of
 * that info string and is used for reporting, never to decide whether the body is scanned.
 *
 * Leading whitespace is allowed on the fence lines: the runbook's own SQL fences are indented
 * three spaces inside a numbered list, and dropping them would make the runbook-level guards
 * silently vacuous.
 *
 * `start`/`end` are offsets into `markdown`, so the same scan can also REMOVE the venues (used by
 * the unfenced-SQL extractor, which must not re-read a tilde-fenced body as "unfenced SQL").
 * @param {string} markdown
 * @returns {{ kind: 'fence' | 'html', info: string, tag: string, body: string, start: number, end: number }[]}
 */
export function scanCodeVenues(markdown) {
  const lines = markdown.split('\n')
  const lineStart = []
  let offset = 0
  for (const line of lines) {
    lineStart.push(offset)
    offset += line.length + 1
  }

  const venues = []
  let i = 0
  while (i < lines.length) {
    // The COMPLETE info string, whatever it holds: `sql`, `sql linenums`, `sql title=probe`,
    // `{.sql #probe}`, … A fence is a fence regardless of what an editor wrote after the marker.
    const open = /^[ \t]*(`{3,}|~{3,})[ \t]*(.*)$/.exec(lines[i])
    if (!open) {
      i += 1
      continue
    }
    const marker = open[1]
    const infoString = open[2].trim()
    // CommonMark: a BACKTICK fence's info string may not contain a backtick (that is what keeps
    // an inline code span at the start of a line from being read as a fence).
    if (marker[0] === '`' && infoString.includes('`')) {
      i += 1
      continue
    }
    // Close fence: same character, at least as long, on its own line (or EOF — an unterminated
    // fence swallows the rest of the document rather than disappearing from the guards).
    const closeRe = new RegExp(`^[ \\t]*[${marker[0]}]{${marker.length},}[ \\t]*$`)
    let j = i + 1
    const body = []
    while (j < lines.length && !closeRe.test(lines[j])) {
      body.push(lines[j])
      j += 1
    }
    venues.push({
      kind: 'fence',
      info: infoString.toLowerCase(),
      tag: fenceLanguageTag(infoString),
      body: body.length > 0 ? `${body.join('\n')}\n` : '',
      start: lineStart[i],
      end: j < lines.length ? lineStart[j] + lines[j].length : markdown.length,
    })
    i = j + 1
  }

  const htmlRe = /<(pre|code)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi
  let m
  while ((m = htmlRe.exec(markdown)) !== null) {
    const start = m.index
    const end = start + m[0].length
    // Skip HTML that merely LIVES inside a fence (e.g. a ```html sample) — already covered.
    if (venues.some((v) => v.kind === 'fence' && start >= v.start && start < v.end)) continue
    venues.push({ kind: 'html', info: '', tag: '', body: m[2], start, end })
  }

  return venues.sort((a, b) => a.start - b.start)
}

/**
 * The language tag of a fence = the FIRST token of its info string, with the attribute syntaxes
 * markdown dialects use (`{.sql}`, `{#id .sql}`, `"sql"`) unwrapped. Reporting only: nothing is
 * skipped because of its tag.
 * @param {string} infoString
 * @returns {string}
 */
export function fenceLanguageTag(infoString) {
  for (const token of infoString.split(/[\s,;]+/)) {
    const cleaned = token.replace(/^[{."'#]+/, '').replace(/[}."']+$/, '')
    if (cleaned) return cleaned.toLowerCase()
  }
  return ''
}

/**
 * A code-block body counts as SQL when it CONTAINS a SELECT — inside a code venue there is no
 * prose to confuse it with, so the tag is irrelevant. (Outside venues nothing is parsed as SQL
 * at all: any `SELECT … FROM` shape there is a violation — see `findUnfencedSelectFromShapes`.)
 * @param {string} text
 * @returns {boolean}
 */
export function blockContainsSql(text) {
  return /\bSELECT\b/i.test(text)
}

/**
 * Code-block bodies that hold SQL, across every recognised venue.
 *
 * The decision is "is this SQL?", never "is the fence tagged sql": an untagged fence, a
 * `postgresql`/`psql` tag, `sql linenums`, `sql title=probe` and an HTML `<pre>` all reach the
 * projection guards through the same path. HTML blocks carry no language tag at all and are
 * therefore always included — an untagged venue must fail closed, never be skipped.
 * @param {string} markdown
 * @returns {string[]}
 */
export function extractFencedSqlBlocks(markdown) {
  return scanCodeVenues(markdown)
    .filter((v) => v.kind === 'html' || blockContainsSql(v.body))
    .map((v) => v.body)
}

/**
 * Split a SELECT list on top-level commas only (depth-aware; ignores commas inside () ).
 * Does not attempt full SQL parsing — sufficient for runbook projection lists.
 * @param {string} selectList
 * @returns {string[]}
 */
export function splitTopLevelProjections(selectList) {
  const parts = []
  let depth = 0
  let current = ''
  for (let i = 0; i < selectList.length; i++) {
    const ch = selectList[i]
    if (ch === '(') {
      depth += 1
      current += ch
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      current += ch
      continue
    }
    if (ch === ',' && depth === 0) {
      const trimmed = current.trim()
      if (trimmed) parts.push(trimmed)
      current = ''
      continue
    }
    current += ch
  }
  const tail = current.trim()
  if (tail) parts.push(tail)
  return parts
}

/**
 * For each SELECT in `sql`, yield the raw projection-list text between SELECT and the
 * matching FROM / WHERE / GROUP / ORDER / LIMIT / ; terminator at depth 0.
 * Handles multi-line runbook SQL.
 *
 * The terminator may only be recognised at a TOKEN BOUNDARY. Scanning character by character and
 * anchoring `\bUNION\b` at the slice start makes every slice look like the start of a string, so
 * the middle of an identifier matched a keyword: the runbook's own alias `has_union` truncated the
 * projection list right there, and everything after it — `…, union_id, open_id, mobile, raw` —
 * became invisible to every projection guard (verified: that list returned ok:true). A keyword is
 * only a terminator when the character before it is not a word character.
 * @param {string} sql
 * @returns {string[]}
 */
export function extractSelectLists(sql) {
  const lists = []
  const isWordChar = (ch) => ch !== undefined && /[A-Za-z0-9_]/.test(ch)
  // Structure is read on the literal/comment-masked copy (same length, so every offset addresses
  // the original): a `;` or a keyword inside `'…'` / `-- …` is text, not a statement terminator.
  const scan = maskSqlLiteralsAndComments(sql)
  let fromIdx = 0
  while (fromIdx < sql.length) {
    const selectMatch = /\bSELECT\b/i.exec(scan.slice(fromIdx))
    if (!selectMatch) break
    const selectAbs = fromIdx + selectMatch.index
    if (isWordChar(scan[selectAbs - 1])) {
      fromIdx = selectAbs + selectMatch[0].length
      continue
    }
    const selectStart = selectAbs + selectMatch[0].length

    let depth = 0
    let i = selectStart
    let end = sql.length
    while (i < sql.length) {
      const ch = scan[i]
      if (ch === '(') {
        depth += 1
        i += 1
        continue
      }
      if (ch === ')') {
        depth = Math.max(0, depth - 1)
        i += 1
        continue
      }
      if (depth === 0 && !isWordChar(scan[i - 1])) {
        const rest = scan.slice(i)
        const term = /^(?:\s|;)*(?:\bFROM\b|\bWHERE\b|\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|\bUNION\b|\bINTERSECT\b|\bEXCEPT\b|;)/i.exec(
          rest,
        )
        if (term && term.index === 0) {
          const kw = /\b(?:FROM|WHERE|GROUP\s+BY|ORDER\s+BY|LIMIT|UNION|INTERSECT|EXCEPT)\b|;/i.exec(rest)
          end = i + (kw ? kw.index : 0)
          break
        }
      }
      i += 1
    }
    const list = sql.slice(selectStart, end).trim()
    if (list) lists.push(list)
    fromIdx = end === sql.length ? sql.length : end + 1
  }
  return lists
}

/**
 * Normalize a projection/body for closed-boolean matching: collapse whitespace only.
 * Keyword/ident case is handled by the family regex `/i` flag; string literals stay exact.
 * @param {string} s
 * @returns {string}
 */
export function normalizeSqlWs(s) {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * If a projection expression references error_message, return its trailing AS alias
 * and the body before that alias (or null alias if bare / direct projection).
 * @param {string} expr
 * @returns {{ referencesErrorMessage: boolean, alias: string | null, body: string }}
 */
export function inspectProjection(expr) {
  const normalized = normalizeSqlWs(expr)
  const referencesErrorMessage = /\berror_message\b/i.test(normalized)
  if (!referencesErrorMessage) {
    return { referencesErrorMessage: false, alias: null, body: normalized }
  }
  // Trailing `AS <ident>` only — require it at the end of the expression.
  const asMatch = /\s+AS\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(normalized)
  if (!asMatch) {
    return { referencesErrorMessage: true, alias: null, body: normalized }
  }
  const alias = asMatch[1].toLowerCase()
  const body = normalized.slice(0, asMatch.index).trim()
  return { referencesErrorMessage: true, alias, body }
}

/**
 * True iff the projection body is the pinned closed-boolean family for the given alias.
 * @param {string} body
 * @param {string} alias
 * @returns {boolean}
 */
export function isClosedBooleanBodyForAlias(body, alias) {
  const pattern = CLOSED_BOOLEAN_BODY_BY_ALIAS[alias]
  if (!pattern) return false
  return pattern.test(normalizeSqlWs(body))
}

/**
 * Validate that every fenced-SQL projection referencing error_message is exactly one of
 * the two closed boolean expression families (body + matching AS alias).
 * @param {string} markdownOrSql  full runbook markdown OR a bare SQL snippet
 * @param {{ bareSql?: boolean }} [opts]
 * @returns {{ ok: true } | { ok: false, violations: string[] }}
 */
export function assertErrorMessageProjectionsAreClosed(markdownOrSql, opts = {}) {
  // Strict fence contract: SQL is parsed inside code venues only. Outside them, any
  // `SELECT … FROM` shape is itself a violation — nothing outside a venue is ever parsed as SQL.
  const sqlBlocks = opts.bareSql ? [markdownOrSql] : extractFencedCodeBlocks(markdownOrSql)
  const violations = opts.bareSql ? [] : unfencedShapeViolations(markdownOrSql)

  for (const block of sqlBlocks) {
    for (const selectList of extractSelectLists(block)) {
      for (const proj of splitTopLevelProjections(selectList)) {
        const { referencesErrorMessage, alias, body } = inspectProjection(proj)
        if (!referencesErrorMessage) continue

        if (!alias || !ALLOWED_ERROR_MESSAGE_ALIASES.has(alias)) {
          violations.push(
            alias === null
              ? `direct/unaliased error_message projection forbidden: ${proj}`
              : `error_message projection alias "${alias}" is not a closed classification (must be duplicate_key_detected|expected_constraint_detected): ${proj}`,
          )
          continue
        }

        // Alias alone is insufficient — body must be the pinned closed boolean family.
        if (!isClosedBooleanBodyForAlias(body, alias)) {
          violations.push(
            `error_message projection AS ${alias} is not the pinned closed boolean family ` +
              `(must be: error_message IS NOT NULL AND position('<needle>' in error_message) > 0): ${proj}`,
          )
        }
      }
    }
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations }
}

// ---------------------------------------------------------------------------
// Clause (1)+(2): no raw provider identity / business values.
//
// Enforced on fenced-SQL projection lists (`assertNoRawIdentityProjections`) and on operator
// prose (`assertNoRawIdentityPasteInstructions`). Both must keep every values-free form the
// runbook already uses.
// ---------------------------------------------------------------------------

/** Raw provider-identity + business-value (PII) column names, as SQL identifiers. */
const RAW_IDENTITY_SQL_COLUMNS = [
  // provider identity
  'union_id',
  'unionid',
  'open_id',
  'openid',
  'user_id',
  'userid',
  'external_user_id',
  'external_key',
  'corp_id',
  'corpid',
  'provider_user_id',
  'access_token',
  'app_secret',
  'credential',
  'password',
  // business values / PII
  'name',
  'full_name',
  'real_name',
  'display_name',
  'nick_name',
  'nickname',
  'user_name',
  'username',
  'department_name',
  'dept_name',
  'job_number',
  'employee_no',
  'employee_number',
  'mobile',
  'mobile_number',
  'phone',
  'phone_number',
  'telephone',
  'email',
  'email_address',
  'avatar',
  'avatar_url',
  'id_card',
  'address',
]

const RAW_IDENTITY_SQL_COLUMN_RE = new RegExp(
  `\\b(?:${RAW_IDENTITY_SQL_COLUMNS.join('|')})\\b`,
  'i',
)

/**
 * Extract every code block (any/no language tag) in every recognised VENUE — a bypass must not be
 * possible by relabelling ```sql as ```postgresql or a bare fence (form), nor by swapping the
 * delimiter for `~~~` or `<pre>` (venue). See `scanCodeVenues`.
 * @param {string} markdown
 * @returns {string[]}
 */
export function extractFencedCodeBlocks(markdown) {
  return scanCodeVenues(markdown).map((v) => v.body)
}

/**
 * Drop a trailing `AS <alias>` from a projection expression (aliases are operator-chosen
 * labels, never values).
 * @param {string} expr
 * @returns {string}
 */
export function stripTrailingAlias(expr) {
  const normalized = normalizeSqlWs(expr)
  const asMatch = /\s+AS\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(normalized)
  return asMatch ? normalized.slice(0, asMatch.index).trim() : normalized
}

/**
 * Replace every `<name>( … )` call (balanced parens) with `replacement`.
 * @param {string} input
 * @param {RegExp} openRe  non-global regex matching `<name>(`
 * @param {string} replacement
 * @returns {string}
 */
function replaceBalancedCalls(input, openRe, replacement) {
  let out = input
  for (let guard = 0; guard < 200; guard++) {
    const m = openRe.exec(out)
    if (!m) break
    const start = m.index
    let i = start + m[0].length
    let depth = 1
    while (i < out.length && depth > 0) {
      if (out[i] === '(') depth += 1
      else if (out[i] === ')') depth -= 1
      i += 1
    }
    out = `${out.slice(0, start)}${replacement}${out.slice(i)}`
  }
  return out
}

/**
 * Reduce a projection expression by erasing the contexts whose RESULT cannot carry a raw
 * value, so that whatever identifier survives is genuinely projected:
 *   - `count(…)` / `count(*) FILTER (WHERE …)`  -> a count
 *   - `length(…)` / `char_length` / `octet_length` / `bit_length` -> an integer
 *   - `<col> IS [NOT] NULL`                     -> a boolean
 *   - `<col> <cmp> <col|literal|number>`        -> a boolean
 * Everything else (bare column, substring/left/right/coalesce/concat/||/cast, …) keeps the
 * identifier and is therefore reported.
 * @param {string} expr
 * @returns {string}
 */
export function reduceValuesFreeContexts(expr) {
  let s = normalizeSqlWs(stripTrailingAlias(expr))
  let previous = null
  for (let guard = 0; previous !== s && guard < 50; guard++) {
    previous = s
    s = replaceBalancedCalls(s, /\bFILTER\s*\(/i, ' ')
    s = replaceBalancedCalls(
      s,
      /\b(?:count|length|char_length|octet_length|bit_length)\s*\(/i,
      ' NUM ',
    )
    s = s.replace(/\b[A-Za-z_][A-Za-z0-9_]*\s+IS\s+(?:NOT\s+)?NULL\b/gi, ' BOOL ')
    s = s.replace(
      /\b[A-Za-z_][A-Za-z0-9_]*\s*(?:<>|!=|>=|<=|=|>|<)\s*(?:'[^']*'|[A-Za-z_][A-Za-z0-9_]*|\d+)/g,
      ' BOOL ',
    )
    s = normalizeSqlWs(s)
  }
  return s
}

/**
 * Owner ruling (review of PR #4500): a DENYLIST of column names / serializer names keeps leaking
 * shapes it was never told about — `SELECT raw FROM directory_accounts` (the column that persists
 * `JSON.stringify(user.source)`, i.e. the provider's raw business record) and
 * `SELECT array_agg(a) FROM directory_accounts a` (whole-row export through an aggregate the
 * serializer list does not name) both passed. The guard is therefore a CLOSED ALLOWLIST of the
 * projection FORMS this runbook is allowed to use; everything else is rejected by default.
 *
 * The allowlist is expressed as a reduction: a projection is legal iff it reduces WHOLE to a
 * scalar kind (`NUM` / `BOOL`) through the forms §2 actually uses, or is one of the named
 * non-identity columns below. Whatever fails to reduce keeps its own text and is rejected — so a
 * form nobody anticipated (`raw`, `array_agg(a)`, `metadata->>'x'`, a subselect, …) REDs without
 * anyone having to have enumerated it.
 */

/** Bare columns this runbook may project as-is (non-identity, closed classification values). */
const ALLOWED_BARE_PROJECTION_COLUMNS = new Set(['status'])

/**
 * Calls whose RESULT is a number and therefore cannot carry a raw value, regardless of argument.
 * These are exactly the reductions §2 uses (`count`, `count(DISTINCT …)`, `length`, and the
 * `position('<needle>' in error_message)` inside the two pinned closed booleans).
 */
const REDUCES_TO_NUMBER_RE =
  /\b(?:count|length|char_length|octet_length|bit_length|position)\s*\(/i

/**
 * Reduce a projection to its values-free KIND (`NUM` / `BOOL`), or leave the irreducible text in
 * place. Only the closed set of forms below reduces:
 *   count(…) / count(*) FILTER (WHERE …) / length(…) / position(… in …)  -> NUM
 *   <operand> IS [NOT] NULL                                              -> BOOL
 *   <operand> <cmp> <operand>                                            -> BOOL
 *   NOT BOOL, BOOL AND BOOL, BOOL OR BOOL                                -> BOOL
 *   ( NUM ) / ( BOOL )                                                   -> NUM / BOOL
 * @param {string} expr
 * @returns {string} `'NUM'` / `'BOOL'` when fully reduced, otherwise the irreducible remainder
 */
export function reduceProjectionToKind(expr) {
  let s = normalizeSqlWs(stripTrailingAlias(expr))
  let previous = null
  for (let guard = 0; previous !== s && guard < 100; guard++) {
    previous = s
    // A FILTER predicate is never projected — its result cannot leave the aggregate.
    s = replaceBalancedCalls(s, /\bFILTER\s*\(/i, ' ')
    s = replaceBalancedCalls(s, REDUCES_TO_NUMBER_RE, ' NUM ')
    s = s.replace(/(?:'[^']*'|\b[A-Za-z_][A-Za-z0-9_]*\b)\s+IS\s+(?:NOT\s+)?NULL\b/gi, ' BOOL ')
    s = s.replace(
      /(?:'[^']*'|\b[A-Za-z_][A-Za-z0-9_]*\b|\b\d+\b)\s*(?:<>|!=|>=|<=|=|>|<)\s*(?:'[^']*'|\b[A-Za-z_][A-Za-z0-9_]*\b|\b\d+\b)/g,
      ' BOOL ',
    )
    s = s.replace(/\bNOT\s+BOOL\b/gi, ' BOOL ')
    s = s.replace(/\bBOOL\s+(?:AND|OR)\s+BOOL\b/gi, ' BOOL ')
    s = s.replace(/\(\s*(NUM|BOOL)\s*\)/g, ' $1 ')
    s = normalizeSqlWs(s)
  }
  return s
}

/**
 * True iff a projection is inside the closed allowlist of forms.
 * @param {string} expr
 * @returns {{ allowed: boolean, reduced: string }}
 */
export function inspectProjectionAgainstAllowlist(expr) {
  const bare = normalizeSqlWs(stripTrailingAlias(expr)).toLowerCase()
  if (ALLOWED_BARE_PROJECTION_COLUMNS.has(bare)) return { allowed: true, reduced: bare }
  const reduced = reduceProjectionToKind(expr)
  return { allowed: reduced === 'NUM' || reduced === 'BOOL', reduced }
}

/**
 * A bare `*` / `<alias>.*` projection selects EVERY column, identity ones included — naming no
 * column, so a column-name allow/deny list can never see it. `count(*)` is unaffected: its
 * projection text is `count(*)`, not `*`.
 */
const WILDCARD_PROJECTION_RE = /^(?:[A-Za-z_][A-Za-z0-9_$]*\s*\.\s*)?\*$/

/**
 * Whole-row serializers render every column of a raw row at once (`to_json(a)`), so they leak
 * exactly what the per-column guard forbids while naming no column. The runbook has no
 * values-free use for them — a reduction is always over a scalar, never a row.
 */
const WHOLE_ROW_SERIALIZER_RE = /\b(?:to_json|to_jsonb|row_to_json|json_agg|jsonb_agg)\s*\(/i

/**
 * Everything OUTSIDE the recognised code venues, with the venue regions removed.
 * @param {string} markdown
 * @returns {string}
 */
function textOutsideCodeVenues(markdown) {
  // Remove EVERY recognised code venue, not just backtick fences: a tilde-fenced or <pre> block
  // whose body happens to be indented must be read as that block (and rejected by the projection
  // guards), never re-reported here as "unfenced SQL".
  let outside = ''
  let cursor = 0
  for (const venue of scanCodeVenues(markdown)) {
    if (venue.start < cursor) continue
    outside += `${markdown.slice(cursor, venue.start)}\n`
    cursor = venue.end
  }
  outside += markdown.slice(cursor)
  return outside
}

/**
 * Blank out the INTERIOR of every SQL string literal / quoted identifier and every SQL comment,
 * preserving the length of the input so offsets computed on the mask address the original text.
 *
 * Gate finding (round 4 of PR #4500): every structural decision below — where a statement ends,
 * where its top-level FROM is, what its projections are — was taken on the raw text, so anything
 * hidden inside `'…'` / `"…"` / `-- …` was read as SQL structure. A single `;` inside a literal
 * ended the candidate before its FROM, and a word inside a literal or a comment decided the
 * "is this SQL?" question. Literals and comments carry no structure and must be neutralised
 * BEFORE the structure is read.
 *
 * The quotes/comment length are kept (interior → spaces, newlines preserved) so the masked text
 * still tokenises identically to the original.
 *
 * Gate finding (round 5 of PR #4500): PostgreSQL dollar-quoting (`$$…$$` / `$tag$…$tag$`) was not
 * masked, so a `;` or a keyword inside a dollar-quoted literal was read as a terminator and the
 * projection list was truncated there — everything after it went unseen by the projection guards
 * (verified: `…, $$a ;b$$ AS label, mobile FROM …` lost `mobile`). A dollar-quoted literal is a
 * literal: its interior is blanked exactly like `'…'`.
 * @param {string} sql
 * @returns {string}
 */
export function maskSqlLiteralsAndComments(sql) {
  const out = sql.split('')
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
  }
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    if (ch === '$') {
      const open = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (open) {
        const tag = open[0]
        const close = sql.indexOf(tag, i + tag.length)
        // An unterminated dollar-quote swallows the rest (same fail-closed rule as fences).
        blank(i + tag.length, close < 0 ? sql.length : close)
        i = close < 0 ? sql.length : close + tag.length
        continue
      }
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === ch && sql[j + 1] === ch) {
          j += 2
          continue
        }
        if (sql[j] === ch) break
        j += 1
      }
      blank(i + 1, Math.min(j, sql.length))
      i = j < sql.length ? j + 1 : sql.length
      continue
    }
    if (ch === '-' && sql[i + 1] === '-') {
      let j = sql.indexOf('\n', i)
      if (j < 0) j = sql.length
      blank(i, j)
      i = j
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2)
      const j = close < 0 ? sql.length : close + 2
      blank(i, j)
      i = j
      continue
    }
    i += 1
  }
  return out.join('')
}

/**
 * STRICT FENCE CONTRACT (owner ruling 2026-07-21, round 5 of PR #4500) — the "smart SQL"
 * vocabulary is RETIRED.
 *
 * Two cuts at "is this unfenced text SQL?" failed the same way from opposite sides. The
 * vocabulary cut (SQL_CONNECTIVE_WORDS + an English stop-word list) let a leaking statement
 * exempt itself with a word. Its structural replacement ("does the projection list resolve as
 * an expression?") began mis-flagging ordinary prose: «Select status from directory_sync_runs
 * after each run and record only the booleans.» has exactly the shape
 * `SELECT status FROM directory_sync_runs …` — one bare operand, a resolvable source — so an
 * English imperative was swallowed whole as a SQL statement (verified at 28cc7c5a4).
 *
 * The controlled document is a single runbook, so the rule is now simple and LOUD instead of
 * clever: ALL SQL must live inside a scanned code venue (backtick/tilde fence with any complete
 * info string, or an HTML <pre>/<code> block — see scanCodeVenues). Outside those venues, ANY
 * `SELECT … FROM` shape is a violation, full stop. Over-flagging is acceptable and intended:
 * the failure is visible, and the author's fix is to fence the SQL or reword the sentence.
 * Nothing outside a venue is ever parsed as SQL — there is no vocabulary, no prose exemption,
 * and no statement-extent machinery to bypass.
 *
 * Inline code spans are NOT an exemption: `` `SELECT union_id …` `` renders inside the
 * paragraph, and a backtick is ordinary punctuation to the shape scan (word boundaries hold
 * straight through it), so the shape is found whether or not it is span-wrapped — a span is
 * prose markup, not a code venue (same rule as before the rewrite).
 * @param {string} markdown
 * @returns {string[]} one normalized snippet per unfenced `SELECT … FROM` shape (SELECT through
 *   the end of the line its FROM sits on), for reporting
 */
export function findUnfencedSelectFromShapes(markdown) {
  const outside = textOutsideCodeVenues(markdown)
  const shapes = []
  const re = /\bSELECT\b[\s\S]*?\bFROM\b[^\n]*/gi
  let m
  while ((m = re.exec(outside)) !== null) {
    shapes.push(normalizeSqlWs(m[0]).slice(0, 160))
  }
  return shapes
}

/**
 * The violation every unfenced `SELECT … FROM` shape produces — shared by BOTH SQL guards, so
 * neither can be satisfied while SQL sits outside a venue.
 * @param {string} markdown
 * @returns {string[]}
 */
function unfencedShapeViolations(markdown) {
  return findUnfencedSelectFromShapes(markdown).map(
    (shape) =>
      `SELECT … FROM outside a code venue — ALL runbook SQL must live in a fenced code block ` +
      `(strict fence contract: fence the SQL or reword the sentence): ${shape}`,
  )
}

/**
 * Validate that no runbook SQL projection emits a raw provider-identity / PII column value.
 *
 * Covers rather than enumerates: besides the column-name list, a projection is rejected when it
 * is a wildcard or a whole-row serializer (both leak every column while naming none). SQL is
 * required to live in a code venue — outside venues, any `SELECT … FROM` shape is itself a
 * violation (strict fence contract), so SQL cannot hide by choosing a delimiter or none at all.
 * @param {string} markdownOrSql
 * @param {{ bareSql?: boolean }} [opts]
 * @returns {{ ok: true } | { ok: false, violations: string[] }}
 */
export function assertNoRawIdentityProjections(markdownOrSql, opts = {}) {
  let violations
  let blocks
  if (opts.bareSql) {
    violations = []
    blocks = [markdownOrSql]
  } else {
    violations = unfencedShapeViolations(markdownOrSql)
    blocks = extractFencedCodeBlocks(markdownOrSql).filter((b) => /\bSELECT\b/i.test(b))
  }

  for (const block of blocks) {
    for (const selectList of extractSelectLists(block)) {
      for (const proj of splitTopLevelProjections(selectList)) {
        const normalizedProj = normalizeSqlWs(proj)
        if (WILDCARD_PROJECTION_RE.test(stripTrailingAlias(normalizedProj))) {
          violations.push(
            `wildcard projection selects every column, identity ones included ` +
              `(values-free requires naming reduced expressions): ${normalizedProj}`,
          )
          continue
        }
        if (WHOLE_ROW_SERIALIZER_RE.test(normalizedProj)) {
          violations.push(
            `whole-row serializer emits every column of a raw row ` +
              `(values-free requires length()/count()/boolean/equality output only): ${normalizedProj}`,
          )
          continue
        }
        if (RAW_IDENTITY_SQL_COLUMN_RE.test(proj)) {
          const reduced = reduceValuesFreeContexts(proj)
          const leaked = RAW_IDENTITY_SQL_COLUMN_RE.exec(reduced)
          if (leaked) {
            violations.push(
              `raw identity/PII column "${leaked[0]}" is projected (values-free requires ` +
                `length()/count()/boolean/equality output only): ${normalizeSqlWs(proj)}`,
            )
            continue
          }
        }

        // Closed allowlist (owner ruling): the denylist above can only ever reject shapes it was
        // told about. Anything that is not one of the runbook's own values-free projection forms
        // is rejected by default — including columns nobody listed (`raw`) and whole-row exports
        // through un-named aggregates (`array_agg(a)`).
        const { allowed, reduced: kind } = inspectProjectionAgainstAllowlist(proj)
        if (!allowed) {
          violations.push(
            `projection is outside the closed values-free allowlist ` +
              `(count()/length()/position() reductions, IS [NOT] NULL, comparisons, AND/OR of ` +
              `those, or the named non-identity columns [${[...ALLOWED_BARE_PROJECTION_COLUMNS].join(', ')}]) ` +
              `— irreducible remainder "${kind}": ${normalizedProj}`,
          )
        }
      }
    }
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations }
}

/** Verbs that put something INTO the evidence pack. */
const EVIDENCE_CAPTURE_VERBS =
  /\b(?:pastes?|copy|copies|records?|writes?|enters?|attaches?|attach|includes?|include|exports?|dumps?|prints?|puts?|put|saves?|logs?|adds?|add|captures?|capture|notes?|note|fills?|fill|transcribes?|transcribe|stores?|store|lists?|list|sends?|send|reports?|report)\b/i

/** Raw provider identity / business values as they read in prose. */
const RAW_IDENTITY_PROSE_TERMS =
  /\b(?:union[_\s-]?ids?|open[_\s-]?ids?|openid|corp[_\s-]?ids?|corpid|external[_\s-]?user[_\s-]?ids?|external[_\s-]?keys?|user[_\s-]?ids?|userid|(?:full|real|display|employee|legal|person)[_\s-]?names?|mobile(?:\s+numbers?)?|phone(?:\s+numbers?)?|e-?mail(?:\s+address(?:es)?)?|avatars?|id\s?cards?)\b/i

/**
 * A negation only exempts a clause when it actually negates the CAPTURE. A bare "no"/"not"
 * anywhere earlier in the sentence used to do it — so "There is no need to redact anything here,
 * paste the unionId …" read as a prohibition. Bare "no"/"not" are gone; what remains either
 * attaches to a verb ("do not paste") or is an explicit prohibition word.
 */
const PROSE_NEGATION =
  /\b(?:do\s+not|does\s+not|don'?t|never|must\s+not|may\s+not|shall\s+not|should\s+not|cannot|can'?t|without|avoid|forbidden|prohibited|not\s+(?:be\s+)?(?:pasted?|copied|recorded|written|entered|attached|included|exported|dumped|printed|saved|logged|added|captured|noted|filled|transcribed|stored|listed|sent|reported))\b/i

/**
 * Strip fenced code blocks — SQL is covered by the projection guards, and the §4 evidence
 * block is covered by the verdict/field guards.
 * @param {string} markdown
 * @returns {string}
 */
export function stripFencedBlocks(markdown) {
  return markdown.replace(/```[\s\S]*?```/g, '\n\n')
}

/**
 * Split prose into clauses: paragraphs (blank-line separated, soft line breaks joined) cut on
 * `;`, `:` and sentence-final `.`. Negation is evaluated per clause so the runbook's own
 * "do **not** paste provider union/open/user IDs" stays legal.
 * @param {string} text
 * @returns {string[]}
 */
export function splitProseClauses(text) {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' '))
    .flatMap((p) => p.split(/[;:]|\.(?=\s|$)/))
    .map((c) => c.trim())
    .filter(Boolean)
}

/**
 * Validate that no operator instruction tells the reader to capture raw provider identity /
 * PII into the evidence pack. A clause is a violation when it pairs a capture verb with a raw
 * identity term and carries no negation before that verb.
 * @param {string} markdown
 * @returns {{ ok: true } | { ok: false, violations: string[] }}
 */
/**
 * Markdown emphasis must not split a phrase the guards match on: the runbook's own legitimate
 * ban reads "do **not** paste …", and a negation regex anchored on `do\s+not` would miss it (the
 * first cut only matched because it accepted a bare `not` anywhere, which is what made the
 * negation bypassable). Strip emphasis markers before matching, keeping offsets meaningful by
 * replacing them with nothing on a per-clause copy.
 */
function stripMarkdownEmphasis(text) {
  return text.replace(/[*_~`]/g, '')
}

export function assertNoRawIdentityPasteInstructions(markdown) {
  const violations = []
  for (const rawClause of splitProseClauses(stripFencedBlocks(markdown))) {
    const clause = stripMarkdownEmphasis(rawClause)
    const verb = EVIDENCE_CAPTURE_VERBS.exec(clause)
    if (!verb) continue
    const term = RAW_IDENTITY_PROSE_TERMS.exec(clause)
    if (!term) continue
    const beforeVerb = clause.slice(0, verb.index)
    if (PROSE_NEGATION.test(beforeVerb)) continue
    violations.push(
      `operator instruction captures raw identity/PII ("${verb[0]}" … "${term[0]}") — ` +
        `evidence must stay values-free: ${clause}`,
    )
  }
  return violations.length === 0 ? { ok: true } : { ok: false, violations }
}

// ---------------------------------------------------------------------------
// §4 evidence-block verdict grounding (replaces the whole-file /_TBD_/ assert).
// ---------------------------------------------------------------------------

/**
 * "Still blank" as an operator would actually write it. The first cut recognised only the exact
 * `_TBD_` token, so a dropped underscore (`TBD`) or an idiomatic blank (`n/a`, `see above`, `-`)
 * read as FILLED evidence and could ground a fabricated verdict — the very invariant this block
 * exists to enforce. Covering the blank vocabulary is what keeps that closed.
 */
const EVIDENCE_PLACEHOLDER =
  /^(?:_{0,2}tbd_{0,2}|n\s*\/?\s*a|none|null|nil|nothing|pending|unknown|unset|todo|see\s+above|\.{2,}|[-—–?]+)$/i

const UUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * COMPLETE, ANCHORED named-field formats for the two composite §4 fields (owner ruling, review of
 * PR #4500). Both §3 rows are decided field by field, so each composite value must parse WHOLE:
 * every named field present, in the template's own order, with a value of the right kind.
 *
 * Positional guesswork ("the second number on the line") and silently skipping an unreadable
 * field are what let two contradictory blocks ground a verdict at the previous head:
 *   - `present_in_a=0 / present_in_b=1 / keys_all_distinct=true` grounded DISPROVED, although §3
 *     requires present_in_a=1 AND present_in_b=1 AND keys_all_distinct=true;
 *   - `corp_a_rows=214 / corp_b_rows=99 / distinct_keys=313` grounded CONFIRMED, although §3
 *     requires corp B row count 0 (a wholesale-failed corp-B sync writes nothing).
 * A missing or malformed field is now REJECTED outright — "cannot tell" must never mean "accept".
 */
const KEY_COMPARISON_FORMAT = {
  re: /^corp_a_rows\s*[=:]\s*(\d+)\s*\/\s*corp_b_rows\s*[=:]\s*(\d+)\s*\/\s*distinct_keys\s*[=:]\s*(\d+)$/i,
  hint: 'corp_a_rows=<n> / corp_b_rows=<n> / distinct_keys=<n>',
}
const PRESENCE_FORMAT = {
  re: /^present_in_a\s*[=:]\s*(\d+)\s*\/\s*present_in_b\s*[=:]\s*(\d+)\s*\/\s*keys_all_distinct\s*[=:]\s*(true|false)$/i,
  hint: 'present_in_a=<n> / present_in_b=<n> / keys_all_distinct=<true|false>',
}

/**
 * The CLOSED `directory_sync_runs.status` vocabulary (migration default `running`; the sync
 * service only ever writes `completed` / `failed` / `running`).
 *
 * Anchored on purpose (owner rule, applied to the §3 status conditions the same way it was
 * applied to the two composite fields): an UNANCHORED `\b(?:completed|failed)\b` accepted prose
 * such as `failed - the sync never completed` or `not completed` as a valid status, and the §3
 * matrix then read the substring `completed` out of it — grounding DISPROVED on a FAILED corp-B
 * run, which skips T2.5 and unlocks T3. Anything outside this set is a malformed field and is
 * REJECTED outright, never silently skipped.
 */
const RUN_STATUS_VALUES = ['completed', 'failed', 'running']
const RUN_STATUS_SHAPE = {
  re: new RegExp(`^(?:${RUN_STATUS_VALUES.join('|')})$`, 'i'),
  hint: `exactly one of ${RUN_STATUS_VALUES.join(' / ')} (the closed directory_sync_runs.status vocabulary)`,
}

/** Shape a filled dependency must have before it can ground a verdict (junk is not evidence). */
const EVIDENCE_VALUE_SHAPES = new Map([
  ['staging sha', { re: /^[0-9a-f]{7,40}$/i, hint: 'a 7-40 character git SHA' }],
  ['corp a integration id', { re: UUID_SHAPE_RE, hint: 'a UUID' }],
  ['corp b integration id', { re: UUID_SHAPE_RE, hint: 'a UUID' }],
  ['corp a run status', RUN_STATUS_SHAPE],
  ['corp b run status', RUN_STATUS_SHAPE],
  [
    'key comparison',
    { re: KEY_COMPARISON_FORMAT.re, hint: `the complete named form "${KEY_COMPARISON_FORMAT.hint}"` },
  ],
  [
    'presence',
    { re: PRESENCE_FORMAT.re, hint: `the complete named form "${PRESENCE_FORMAT.hint}"` },
  ],
  ['corp b duplicate_key_detected', { re: /^(?:true|false)$/i, hint: 'true or false' }],
  ['corp b expected_constraint_detected', { re: /^(?:true|false)$/i, hint: 'true or false' }],
])
const RULED_VERDICTS = new Set(['CONFIRMED', 'DISPROVED', 'INCONCLUSIVE'])
const VERDICT_LABEL = 'verdict'

/** Evidence a verdict of ANY ruled value depends on. */
const VERDICT_EVIDENCE_DEPENDENCIES = [
  'staging sha',
  'corp a integration id',
  'corp b integration id',
  'corp a run status',
  'corp b run status',
  'key comparison',
  'presence',
]

/** §3 keys CONFIRMED on the two closed classifications, so they must be filled too. */
const CONFIRMED_EXTRA_DEPENDENCIES = [
  'corp b duplicate_key_detected',
  'corp b expected_constraint_detected',
]

function normalizeEvidenceLabel(label) {
  return label.replace(/[`*]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Normalize an evidence value for judging: drop markdown emphasis and the trailing "(hint)" the
 * template carries on several rows (`_TBD_ (completed|failed|…)`), so the judgement is about the
 * value the operator wrote, not about the template's own annotation.
 */
function normalizeEvidenceValue(value) {
  return value
    .replace(/[`*]/g, '')
    .replace(/\s*\([^()]*\)\s*$/, '')
    .trim()
}

function isEvidencePlaceholder(value) {
  const v = normalizeEvidenceValue(value)
  return v === '' || EVIDENCE_PLACEHOLDER.test(v)
}

/**
 * The §3 decision matrix, as code — every condition of every row, computed FIELD BY FIELD from a
 * completely parsed evidence block.
 *
 * §3 rows as landed:
 *  - CONFIRMED:    corp-B run failed + duplicate_key_detected=true
 *                  + expected_constraint_detected=true + corp B row count 0
 *  - DISPROVED:    both runs completed + present_in_a=1 AND present_in_b=1
 *                  AND keys_all_distinct=true
 *  - INCONCLUSIVE: everything else
 *
 * `problems` is non-empty when the evidence needed to DECIDE the row cannot be read at all. That
 * is never an acceptance: the caller turns each problem into a violation, so an unparseable block
 * can ground no verdict.
 * @param {Map<string, {value: string}>} byLabel
 * @returns {{ verdict: string | null, because: string, problems: string[] }}
 */
function impliedVerdictFromEvidence(byLabel) {
  const problems = []
  const read = (label) => {
    const f = byLabel.get(label)
    if (!f || isEvidencePlaceholder(f.value)) return null
    return normalizeEvidenceValue(f.value).toLowerCase()
  }
  /** Parse a composite field with its COMPLETE anchored named format, or record a problem. */
  const parseComposite = (label, format) => {
    const raw = read(label)
    if (raw === null) {
      problems.push(
        `§4 evidence field "${label}" is missing/blank, so the §3 row cannot be computed`,
      )
      return null
    }
    const m = format.re.exec(raw)
    if (!m) {
      problems.push(
        `§4 evidence field "${label}" is not the complete named form "${format.hint}" ` +
          `(got "${raw}") — an unreadable field is rejected, never skipped`,
      )
      return null
    }
    return m
  }

  /**
   * Parse a run status against the CLOSED vocabulary, or record a problem. Same rule as the
   * composite fields: "cannot tell" is never "accept", and the matrix below compares with `===`
   * so no substring of a longer sentence can stand in for the status.
   */
  const parseStatus = (label) => {
    const raw = read(label)
    if (raw === null) {
      problems.push(`§4 evidence field "${label}" is missing/blank, so the §3 row cannot be computed`)
      return null
    }
    if (!RUN_STATUS_SHAPE.re.test(raw)) {
      problems.push(
        `§4 evidence field "${label}" is not one of the closed run statuses ` +
          `[${RUN_STATUS_VALUES.join(', ')}] (got "${raw}") — a malformed status is rejected, ` +
          `never read as a substring`,
      )
      return null
    }
    return raw
  }

  const runA = parseStatus('corp a run status')
  const runB = parseStatus('corp b run status')
  const dup = read('corp b duplicate_key_detected')
  const constraintHit = read('corp b expected_constraint_detected')
  const keyComparison = parseComposite('key comparison', KEY_COMPARISON_FORMAT)
  const presence = parseComposite('presence', PRESENCE_FORMAT)
  if (problems.length > 0) return { verdict: null, because: '', problems }

  const isTrue = (v) => v !== null && /^true$/.test(v)
  const corpBRows = Number(keyComparison[2])
  const presentInA = Number(presence[1])
  const presentInB = Number(presence[2])
  const keysAllDistinct = /^true$/i.test(presence[3])

  // §3 row 1 — CONFIRMED. All four conditions, none of them optional.
  const confirmedRow = {
    "corp-B run status='failed'": runB === 'failed',
    'duplicate_key_detected=true': isTrue(dup),
    'expected_constraint_detected=true': isTrue(constraintHit),
    'corp B row count 0': corpBRows === 0,
  }
  if (Object.values(confirmedRow).every(Boolean)) {
    return {
      verdict: 'CONFIRMED',
      because:
        'a failed corp-B run with both closed classifications true and zero corp-B rows written',
      problems: [],
    }
  }

  // §3 row 2 — DISPROVED. All four conditions, none of them optional.
  const disprovedRow = {
    'both runs completed': runA === 'completed' && runB === 'completed',
    'present_in_a=1': presentInA === 1,
    'present_in_b=1': presentInB === 1,
    'keys_all_distinct=true': keysAllDistinct,
  }
  if (Object.values(disprovedRow).every(Boolean)) {
    return {
      verdict: 'DISPROVED',
      because:
        'both runs completed with the overlap person present on BOTH sides and all keys distinct',
      problems: [],
    }
  }

  // §3 row 3 — everything else.
  const unmet = (row) =>
    Object.entries(row)
      .filter(([, met]) => !met)
      .map(([condition]) => condition)
      .join(', ')
  return {
    verdict: 'INCONCLUSIVE',
    because:
      `evidence matching neither closed §3 row (CONFIRMED unmet: ${unmet(confirmedRow)}; ` +
      `DISPROVED unmet: ${unmet(disprovedRow)})`,
    problems: [],
  }
}

/**
 * Extract the §4 evidence block body (first code block after the `## 4.` heading, in any
 * recognised venue — the block must not escape the verdict guards by being tilde-fenced).
 * @param {string} markdown
 * @returns {string | null}
 */
export function extractEvidenceBlock(markdown) {
  const headingIdx = markdown.search(/^##\s*4\./m)
  if (headingIdx < 0) return null
  const [first] = scanCodeVenues(markdown.slice(headingIdx))
  return first ? first.body : null
}

/**
 * Parse `label: value` lines of the evidence block.
 * @param {string} block
 * @returns {{ label: string, value: string, raw: string }[]}
 */
export function parseEvidenceFields(block) {
  const fields = []
  for (const raw of block.split('\n')) {
    const m = /^\s*([^:\n]+?)\s*:\s*(.*)$/.exec(raw)
    if (!m) continue
    fields.push({ label: normalizeEvidenceLabel(m[1]), value: m[2].trim(), raw: raw.trim() })
  }
  return fields
}

/**
 * The §4 verdict field may only hold the placeholder OR exactly one ruled value, and a filled
 * verdict must be accompanied by the evidence fields it depends on. Also bans raw identity /
 * PII fields inside the evidence block itself.
 * @param {string} markdown
 * @returns {{ ok: true } | { ok: false, violations: string[] }}
 */
export function assertEvidenceVerdictIsGrounded(markdown) {
  const violations = []
  const block = extractEvidenceBlock(markdown)
  if (block === null) {
    return { ok: false, violations: ['§4 evidence block (fenced) not found'] }
  }

  const fields = parseEvidenceFields(block)
  // FIRST occurrence wins, and a duplicate is itself a violation: `new Map(fields.map(...))` let
  // the LAST line win, so appending a second `verdict: _TBD_` after a real one made the guard
  // judge the placeholder and skip grounding entirely.
  const byLabel = new Map()
  for (const f of fields) {
    if (byLabel.has(f.label)) {
      violations.push(
        `§4 evidence block declares "${f.label}" more than once — a duplicate label makes which ` +
          `value is judged ambiguous: ${f.raw}`,
      )
      continue
    }
    byLabel.set(f.label, f)
  }

  // A verdict recorded OUTSIDE the §4 block is unguarded by everything below, so it must not
  // exist: the evidence block is the single place a verdict is allowed to live.
  const outsideBlock = markdown.split(block).join('\n')
  const strayVerdict =
    /(^|\n)[^\n]*\bverdict\b\s*[:：]\s*\**\s*(CONFIRMED|DISPROVED|INCONCLUSIVE)\b/i.exec(outsideBlock)
  if (strayVerdict) {
    violations.push(
      `a ruled verdict ("${strayVerdict[2]}") is recorded outside the §4 evidence block, where ` +
        `the grounding checks cannot see it: ${strayVerdict[0].trim().slice(0, 120)}`,
    )
  }

  for (const label of [
    ...VERDICT_EVIDENCE_DEPENDENCIES,
    ...CONFIRMED_EXTRA_DEPENDENCIES,
    VERDICT_LABEL,
  ]) {
    if (!byLabel.has(label)) {
      violations.push(`§4 evidence block is missing required field "${label}"`)
    }
  }

  for (const field of fields) {
    const leaked =
      RAW_IDENTITY_PROSE_TERMS.exec(field.label) || RAW_IDENTITY_PROSE_TERMS.exec(field.value)
    if (leaked) {
      violations.push(
        `§4 evidence field carries raw identity/PII ("${leaked[0]}"): ${field.raw}`,
      )
    }
  }

  const verdict = byLabel.get(VERDICT_LABEL)
  if (verdict && !isEvidencePlaceholder(verdict.value)) {
    const ruled = verdict.value.replace(/[`*]/g, '').trim().toUpperCase()
    if (!RULED_VERDICTS.has(ruled)) {
      violations.push(
        `§4 verdict must be the placeholder (_TBD_) or exactly one of ` +
          `CONFIRMED|DISPROVED|INCONCLUSIVE — got "${verdict.value}"`,
      )
    }
    const required =
      ruled === 'CONFIRMED'
        ? [...VERDICT_EVIDENCE_DEPENDENCIES, ...CONFIRMED_EXTRA_DEPENDENCIES]
        : VERDICT_EVIDENCE_DEPENDENCIES
    const blank = required.filter((label) => {
      const f = byLabel.get(label)
      return !f || isEvidencePlaceholder(f.value)
    })
    if (blank.length > 0) {
      violations.push(
        `§4 verdict "${verdict.value}" is recorded while its evidence is still blank ` +
          `(${blank.join(', ')}) — a verdict may not be fabricated ahead of the evidence it depends on`,
      )
    }
    // Filled is not the same as evidence: a dependency that does not even have the SHAPE of the
    // thing it records (a SHA that is not hex, an integration id that is not a UUID) cannot
    // ground a verdict either.
    for (const label of required) {
      const f = byLabel.get(label)
      if (!f || isEvidencePlaceholder(f.value)) continue
      const shape = EVIDENCE_VALUE_SHAPES.get(label)
      if (!shape) continue
      if (!shape.re.test(normalizeEvidenceValue(f.value))) {
        violations.push(
          `§4 evidence field "${label}" does not have the shape of ${shape.hint} ` +
            `("${f.value}") — a verdict may not rest on it`,
        )
      }
    }

    // Present is not the same as CONSISTENT: the recorded verdict must be the §3 row the
    // evidence actually implies. Without this, "corp B run status: failed" + "verdict:
    // DISPROVED" passes — recording the CONFIRMED row as its exact opposite, which is what
    // unlocks T3 and skips the T2.5 tenant-scoped key migration.
    const implied = impliedVerdictFromEvidence(byLabel)
    // "Cannot tell" must never mean "accept": when the evidence needed to decide the §3 row is
    // missing or unparseable, the verdict is ungrounded and the guard REDs.
    for (const problem of implied.problems) {
      violations.push(
        `§4 verdict "${ruled}" cannot be grounded — ${problem}`,
      )
    }
    if (implied.verdict && implied.verdict !== ruled) {
      violations.push(
        `§4 verdict "${ruled}" contradicts its own evidence — the §3 decision matrix routes ` +
          `${implied.because} to ${implied.verdict}`,
      )
    }
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations }
}

function assertRunbookValuesFree(runbook) {
  const proj = assertErrorMessageProjectionsAreClosed(runbook)
  assert.equal(
    proj.ok,
    true,
    proj.ok
      ? 'ok'
      : `runbook fenced SQL projects raw error_message:\n- ${proj.violations.join('\n- ')}`,
  )

  for (const pattern of FORBIDDEN_RAW_ERROR_OUTPUT) {
    assert.doesNotMatch(
      runbook,
      pattern,
      `runbook must not expose raw error text to operators (matched ${pattern})`,
    )
  }

  assert.match(
    runbook,
    /corp B duplicate_key_detected:/,
    'evidence block must record corp B duplicate_key_detected',
  )
  assert.match(
    runbook,
    /corp B expected_constraint_detected:/,
    'evidence block must record corp B expected_constraint_detected',
  )
}

// ---------------------------------------------------------------------------
// Synthetic guards (in-memory) — prove closed-boolean body pinning, not alias-only.
// These do NOT touch the runbook file.
// ---------------------------------------------------------------------------

const ALLOWED_DUP = `(error_message IS NOT NULL AND position('duplicate key' in error_message) > 0) AS duplicate_key_detected`
const ALLOWED_CONSTRAINT = `(error_message IS NOT NULL AND position('idx_directory_accounts_provider_external_key' in error_message) > 0) AS expected_constraint_detected`

test('synthetic: direct SELECT error_message is rejected', () => {
  const sql = `SELECT status, error_message FROM directory_sync_runs WHERE integration_id = '<B>' ORDER BY started_at DESC LIMIT 1;`
  const result = assertErrorMessageProjectionsAreClosed(sql, { bareSql: true })
  assert.equal(result.ok, false, 'direct error_message projection must fail')
  assert.ok(
    result.violations.some((v) => /direct\/unaliased/i.test(v)),
    `expected direct/unaliased violation, got: ${result.violations?.join(' | ')}`,
  )
})

test('synthetic: substring(error_message,...) AS preview is rejected', () => {
  const sql = `SELECT status, substring(error_message, 1, 120) AS preview FROM directory_sync_runs;`
  const result = assertErrorMessageProjectionsAreClosed(sql, { bareSql: true })
  assert.equal(result.ok, false, 'substring AS preview must fail')
  assert.ok(
    result.violations.some((v) => /alias "preview"/i.test(v)),
    `expected preview-alias violation, got: ${result.violations?.join(' | ')}`,
  )
})

test('synthetic: classic left(coalesce(error_message...)) AS err is rejected', () => {
  const sql = `SELECT status, left(coalesce(error_message, ''), 120) AS err FROM directory_sync_runs;`
  const result = assertErrorMessageProjectionsAreClosed(sql, { bareSql: true })
  assert.equal(result.ok, false, 'left(coalesce...) AS err must fail')
  assert.ok(
    result.violations.some((v) => /alias "err"/i.test(v)),
    `expected err-alias violation, got: ${result.violations?.join(' | ')}`,
  )
})

test('synthetic: substring(...) AS duplicate_key_detected alias-smuggle is rejected', () => {
  const sql = `SELECT substring(error_message,1,120) AS duplicate_key_detected FROM directory_sync_runs;`
  const result = assertErrorMessageProjectionsAreClosed(sql, { bareSql: true })
  assert.equal(result.ok, false, 'substring under allowed alias must fail')
  assert.ok(
    result.violations.some(
      (v) =>
        /AS duplicate_key_detected/i.test(v) &&
        /not the pinned closed boolean family/i.test(v),
    ),
    `expected closed-boolean-family violation for alias-smuggle, got: ${result.violations?.join(' | ')}`,
  )
})

test('synthetic: bare error_message AS expected_constraint_detected alias-smuggle is rejected', () => {
  const sql = `SELECT error_message AS expected_constraint_detected FROM directory_sync_runs;`
  const result = assertErrorMessageProjectionsAreClosed(sql, { bareSql: true })
  assert.equal(result.ok, false, 'bare error_message under allowed alias must fail')
  assert.ok(
    result.violations.some(
      (v) =>
        /AS expected_constraint_detected/i.test(v) &&
        /not the pinned closed boolean family/i.test(v),
    ),
    `expected closed-boolean-family violation for bare alias-smuggle, got: ${result.violations?.join(' | ')}`,
  )
})

test('synthetic: the two closed boolean projections pass', () => {
  const sql = `SELECT status, ${ALLOWED_DUP}, ${ALLOWED_CONSTRAINT}
     FROM directory_sync_runs
    WHERE integration_id = '<B>'
    ORDER BY started_at DESC LIMIT 1;`
  const result = assertErrorMessageProjectionsAreClosed(sql, { bareSql: true })
  assert.equal(
    result.ok,
    true,
    result.ok ? 'ok' : `allowed booleans must pass:\n- ${result.violations.join('\n- ')}`,
  )
})

test('synthetic: whitespace/case variants of the allowed families still pass', () => {
  const sql = `SELECT
      STATUS,
      ( Error_Message  is  not  null  AND  POSITION( 'duplicate key'  IN  Error_Message )  >  0 )  AS  Duplicate_Key_Detected,
      Error_Message IS NOT NULL AND position('idx_directory_accounts_provider_external_key' in error_message)>0 AS expected_constraint_detected
    FROM directory_sync_runs;`
  const result = assertErrorMessageProjectionsAreClosed(sql, { bareSql: true })
  assert.equal(
    result.ok,
    true,
    result.ok ? 'ok' : `ws/case variants must pass:\n- ${result.violations.join('\n- ')}`,
  )
})

test('synthetic: fenced markdown with a bypass fails; allowed fence passes', () => {
  const bad = [
    '```sql',
    'SELECT error_message FROM directory_sync_runs;',
    '```',
  ].join('\n')
  const badResult = assertErrorMessageProjectionsAreClosed(bad)
  assert.equal(badResult.ok, false, 'fenced direct error_message must fail')

  const smuggle = [
    '```sql',
    'SELECT substring(error_message,1,120) AS duplicate_key_detected FROM directory_sync_runs;',
    '```',
  ].join('\n')
  const smuggleResult = assertErrorMessageProjectionsAreClosed(smuggle)
  assert.equal(smuggleResult.ok, false, 'fenced alias-smuggle must fail')

  const good = [
    '```sql',
    `SELECT status, ${ALLOWED_DUP}, ${ALLOWED_CONSTRAINT}`,
    '  FROM directory_sync_runs',
    " WHERE integration_id = '<B>'",
    ' ORDER BY started_at DESC LIMIT 1;',
    '```',
  ].join('\n')
  const goodResult = assertErrorMessageProjectionsAreClosed(good)
  assert.equal(
    goodResult.ok,
    true,
    goodResult.ok ? 'ok' : `allowed fence must pass:\n- ${goodResult.violations.join('\n- ')}`,
  )
})

// ---------------------------------------------------------------------------
// Actual runbook file contracts
// ---------------------------------------------------------------------------

test('T2-Gate runbook requires closed collision classifications (not raw error text)', () => {
  const runbook = loadRunbook()
  assert.match(
    runbook,
    /\bduplicate_key_detected\b/,
    'runbook must require duplicate_key_detected (closed boolean)',
  )
  assert.match(
    runbook,
    /\bexpected_constraint_detected\b/,
    'runbook must require expected_constraint_detected (closed boolean)',
  )
  assert.match(
    runbook,
    /idx_directory_accounts_provider_external_key/,
    'runbook must pin the closed constraint name used for expected_constraint_detected',
  )
  assert.match(
    runbook,
    /duplicate_key_detected\s*=\s*true/i,
    'decision matrix must key CONFIRMED on duplicate_key_detected=true',
  )
  assert.match(
    runbook,
    /expected_constraint_detected\s*=\s*true/i,
    'decision matrix must key CONFIRMED on expected_constraint_detected=true',
  )
})

test('T2-Gate runbook never selects or records raw error_message / err-head operator output', () => {
  assertRunbookValuesFree(loadRunbook())
})

test('T2-Gate runbook keeps T2.5 conditional + staging owner/ops boundary (no fabricated verdict)', () => {
  const runbook = loadRunbook()
  assert.match(runbook, /T2\.5/, 'runbook must name the T2.5 decision branch')
  assert.match(runbook, /CONFIRMED/, 'runbook must include CONFIRMED verdict')
  assert.match(runbook, /DISPROVED/, 'runbook must include DISPROVED verdict')
  assert.match(runbook, /INCONCLUSIVE/, 'runbook must include INCONCLUSIVE verdict')
  assert.match(
    runbook,
    /T3 remains frozen|keeps T3 frozen|T3 frozen/i,
    'inconclusive path must keep T3 frozen',
  )
  // The verdict LINE — not whole-file _TBD_ survival — carries the no-fabrication invariant.
  const verdictResult = assertEvidenceVerdictIsGrounded(runbook)
  assert.equal(
    verdictResult.ok,
    true,
    verdictResult.ok
      ? 'ok'
      : `§4 verdict is not grounded in its evidence:\n- ${verdictResult.violations.join('\n- ')}`,
  )
  assert.match(
    runbook,
    /do not fabricate|leave §4 TBD|leave TBD/i,
    'runbook must forbid fabricating a staging verdict in-repo',
  )
})

test('T2-Gate runbook values-free scope allows provenance (SHA / actor / integration ids), bans provider identity', () => {
  const runbook = loadRunbook()
  // Provenance fields in §4 evidence block + explicit allow-list wording.
  assert.match(runbook, /staging SHA:/, 'evidence block records exact staging SHA')
  assert.match(runbook, /executed by \/ date:/, 'evidence block records execution date/actor')
  assert.match(
    runbook,
    /corp A integration id:/,
    'evidence block records internal integration resource id for corp A',
  )
  assert.match(
    runbook,
    /Provenance is allowed|provenance is allowed/i,
    'runbook must state that SHA/date/actor/integration ids are allowed provenance',
  )
  assert.match(
    runbook,
    /provider identity|raw provider/i,
    'values-free ban must target provider identity, not unbounded "raw IDs"',
  )
  assert.match(
    runbook,
    /booleans\s*\/\s*counts\s*\/\s*statuses|booleans \/ counts \/ statuses/i,
    'SQL outputs remain booleans/counts/statuses only',
  )
})

// ---------------------------------------------------------------------------
// Synthetic guards — §4 verdict grounding (audit A2 blind spot 1)
// ---------------------------------------------------------------------------

/** Build a §4-shaped runbook fragment from label -> value pairs. */
function evidenceDoc(overrides = {}) {
  const base = {
    'staging SHA': '_TBD_',
    'executed by / date': '_TBD_',
    'corp A integration id': '_TBD_',
    'corp B integration id': '_TBD_',
    'corp A run status': '_TBD_ (completed|failed|…)',
    'corp B run status': '_TBD_ (completed|failed|…)',
    'corp B duplicate_key_detected': '_TBD_ (true|false)',
    'corp B expected_constraint_detected': '_TBD_ (true|false)',
    'key comparison': '_TBD_ (corp_a_rows=<n> / corp_b_rows=<n> / distinct_keys=<n>)',
    presence: '_TBD_ (present_in_a=<n> / present_in_b=<n> / keys_all_distinct=<true|false>)',
    verdict: '_TBD_ (CONFIRMED / DISPROVED / INCONCLUSIVE)',
  }
  const merged = { ...base, ...overrides }
  const lines = Object.entries(merged).map(([k, v]) => `${k}: ${v}`)
  return ['## 4. Evidence block', '', '```', ...lines, '```', ''].join('\n')
}

const COMPLETED_EVIDENCE = {
  'staging SHA': '4c1b9e2f0a7d3b58e6f1c204a9d7e3b81f0c5a62',
  'executed by / date': 'ops (staging operator) / 2026-08-04',
  'corp A integration id': '9f2c41d8-6b0e-4a51-9c33-71ad0e6f8b24',
  'corp B integration id': 'c07e5b19-8d42-4f6a-b1e0-53c9a7d2f481',
  'corp A run status': 'completed',
  'corp B run status': 'completed',
  'corp B duplicate_key_detected': 'false',
  'corp B expected_constraint_detected': 'false',
  'key comparison': 'corp_a_rows=214 / corp_b_rows=187 / distinct_keys=401',
  presence: 'present_in_a=1 / present_in_b=1 / keys_all_distinct=true',
  verdict: 'DISPROVED',
}

/**
 * The CONFIRMED counterpart, self-consistent by §3: a wholesale-failed corp-B sync writes NOTHING,
 * so `corp_b_rows` is 0 and the overlap person is absent under corp B.
 */
const CONFIRMED_EVIDENCE = {
  ...COMPLETED_EVIDENCE,
  'corp B run status': 'failed',
  'corp B duplicate_key_detected': 'true',
  'corp B expected_constraint_detected': 'true',
  'key comparison': 'corp_a_rows=214 / corp_b_rows=0 / distinct_keys=214',
  presence: 'present_in_a=1 / present_in_b=0 / keys_all_distinct=true',
  verdict: 'CONFIRMED',
}

test('synthetic: fabricated verdict with the evidence still TBD is rejected', () => {
  const result = assertEvidenceVerdictIsGrounded(evidenceDoc({ verdict: 'DISPROVED' }))
  assert.equal(result.ok, false, 'verdict filled with blank evidence must fail')
  assert.ok(
    result.violations.some(
      (v) => /evidence is still blank/i.test(v) && /staging sha/i.test(v) && /presence/i.test(v),
    ),
    `expected blank-evidence violation naming the dependencies, got: ${result.violations?.join(' | ')}`,
  )
})

test('synthetic: fabricated CONFIRMED without the closed classifications is rejected', () => {
  const partial = {
    ...COMPLETED_EVIDENCE,
    'corp B run status': 'failed',
    'corp B duplicate_key_detected': '_TBD_ (true|false)',
    'corp B expected_constraint_detected': '_TBD_ (true|false)',
    verdict: 'CONFIRMED',
  }
  const result = assertEvidenceVerdictIsGrounded(evidenceDoc(partial))
  assert.equal(result.ok, false, 'CONFIRMED without both closed classifications must fail')
  assert.ok(
    result.violations.some((v) => /duplicate_key_detected/.test(v) && /still blank/i.test(v)),
    `expected classification-dependency violation, got: ${result.violations?.join(' | ')}`,
  )
})

test('synthetic: an unruled verdict value is rejected', () => {
  for (const bogus of ['probably DISPROVED', 'PASS', 'DISPROVED (per ops judgement)']) {
    const result = assertEvidenceVerdictIsGrounded(
      evidenceDoc({ ...COMPLETED_EVIDENCE, verdict: bogus }),
    )
    assert.equal(result.ok, false, `verdict "${bogus}" must fail`)
    assert.ok(
      result.violations.some((v) => /exactly one of/i.test(v)),
      `expected ruled-value violation for "${bogus}", got: ${result.violations?.join(' | ')}`,
    )
  }
})

test('synthetic: a legitimately COMPLETED evidence block passes (no _TBD_ left anywhere)', () => {
  const doc = evidenceDoc(COMPLETED_EVIDENCE)
  assert.doesNotMatch(doc, /_TBD_/, 'completed block must contain no placeholder at all')
  const result = assertEvidenceVerdictIsGrounded(doc)
  assert.equal(
    result.ok,
    true,
    result.ok ? 'ok' : `completed evidence must pass:\n- ${result.violations.join('\n- ')}`,
  )

  // The CONFIRMED positive control must itself be a block §3 admits: a wholesale-failed corp-B
  // sync writes NOTHING, so corp_b_rows is 0 and the overlap person is absent under B. (The
  // previous fixture recorded corp_b_rows=187 alongside a failed run — self-contradictory
  // evidence that the pre-fix matrix accepted because it never read `key comparison`.)
  const confirmed = assertEvidenceVerdictIsGrounded(evidenceDoc(CONFIRMED_EVIDENCE))
  assert.equal(
    confirmed.ok,
    true,
    confirmed.ok ? 'ok' : `completed CONFIRMED evidence must pass:\n- ${confirmed.violations.join('\n- ')}`,
  )
})

test('synthetic: the in-repo TBD evidence block passes, and dropping a required field fails', () => {
  const untouched = assertEvidenceVerdictIsGrounded(evidenceDoc())
  assert.equal(
    untouched.ok,
    true,
    untouched.ok ? 'ok' : `all-TBD block must pass:\n- ${untouched.violations.join('\n- ')}`,
  )

  const withoutPresence = evidenceDoc(COMPLETED_EVIDENCE)
    .split('\n')
    .filter((l) => !/^presence:/.test(l))
    .join('\n')
  const dropped = assertEvidenceVerdictIsGrounded(withoutPresence)
  assert.equal(dropped.ok, false, 'deleting a dependency field must not be an escape hatch')
  assert.ok(
    dropped.violations.some((v) => /missing required field "presence"/.test(v)),
    `expected missing-field violation, got: ${dropped.violations?.join(' | ')}`,
  )
})

test('synthetic: raw identity/PII inside the evidence block is rejected', () => {
  const result = assertEvidenceVerdictIsGrounded(
    evidenceDoc({ ...COMPLETED_EVIDENCE, 'overlap unionId': 'aBcD1234efGH' }),
  )
  assert.equal(result.ok, false, 'a raw unionId field in §4 must fail')
  assert.ok(
    result.violations.some((v) => /raw identity\/PII/i.test(v)),
    `expected evidence-field identity violation, got: ${result.violations?.join(' | ')}`,
  )
})

// ---------------------------------------------------------------------------
// Owner reproductions (review of PR #4500) — a contradictory evidence block must not be able to
// fabricate a T2-Gate verdict. Both of these returned ok:true before the fix.
// ---------------------------------------------------------------------------

test('owner repro (i): present_in_a=0 cannot ground DISPROVED', () => {
  const result = assertEvidenceVerdictIsGrounded(
    evidenceDoc({
      ...COMPLETED_EVIDENCE,
      presence: 'present_in_a=0 / present_in_b=1 / keys_all_distinct=true',
      verdict: 'DISPROVED',
    }),
  )
  assert.equal(result.ok, false, 'DISPROVED without present_in_a=1 must fail')
  assert.ok(
    result.violations.some(
      (v) => /contradicts its own evidence/i.test(v) && /present_in_a=1/.test(v) && /INCONCLUSIVE/.test(v),
    ),
    `expected a present_in_a contradiction routed to INCONCLUSIVE, got: ${result.violations?.join(' | ')}`,
  )
})

test('owner repro (ii): a CONFIRMED whose key comparison shows corp-B rows written is rejected', () => {
  const result = assertEvidenceVerdictIsGrounded(
    evidenceDoc({
      ...CONFIRMED_EVIDENCE,
      'key comparison': 'corp_a_rows=214 / corp_b_rows=99 / distinct_keys=313',
    }),
  )
  assert.equal(result.ok, false, 'CONFIRMED with corp_b_rows>0 must fail')
  assert.ok(
    result.violations.some(
      (v) => /contradicts its own evidence/i.test(v) && /corp B row count 0/.test(v),
    ),
    `expected a corp-B-row-count contradiction, got: ${result.violations?.join(' | ')}`,
  )
})

test('synthetic: every §3 CONFIRMED condition is load-bearing', () => {
  const flips = [
    ['corp-B run failed', { 'corp B run status': 'completed' }],
    ['duplicate_key_detected=true', { 'corp B duplicate_key_detected': 'false' }],
    ['expected_constraint_detected=true', { 'corp B expected_constraint_detected': 'false' }],
    ['corp B row count 0', { 'key comparison': 'corp_a_rows=214 / corp_b_rows=1 / distinct_keys=215' }],
  ]
  for (const [condition, override] of flips) {
    const result = assertEvidenceVerdictIsGrounded(
      evidenceDoc({ ...CONFIRMED_EVIDENCE, ...override }),
    )
    assert.equal(result.ok, false, `CONFIRMED must fail when "${condition}" does not hold`)
    assert.ok(
      result.violations.some((v) => /contradicts its own evidence/i.test(v)),
      `expected a §3 contradiction for "${condition}", got: ${result.violations?.join(' | ')}`,
    )
  }
})

test('synthetic: every §3 DISPROVED condition is load-bearing', () => {
  const flips = [
    ['corp A completed', { 'corp A run status': 'failed' }],
    ['corp B completed', { 'corp B run status': 'failed' }],
    ['present_in_a=1', { presence: 'present_in_a=0 / present_in_b=1 / keys_all_distinct=true' }],
    ['present_in_b=1', { presence: 'present_in_a=1 / present_in_b=0 / keys_all_distinct=true' }],
    ['keys_all_distinct=true', { presence: 'present_in_a=1 / present_in_b=1 / keys_all_distinct=false' }],
  ]
  for (const [condition, override] of flips) {
    const result = assertEvidenceVerdictIsGrounded(
      evidenceDoc({ ...COMPLETED_EVIDENCE, ...override }),
    )
    assert.equal(result.ok, false, `DISPROVED must fail when "${condition}" does not hold`)
    assert.ok(
      result.violations.some((v) => /contradicts its own evidence/i.test(v)),
      `expected a §3 contradiction for "${condition}", got: ${result.violations?.join(' | ')}`,
    )
  }
})

test('synthetic: an unparseable composite field grounds NOTHING (cannot tell ≠ accept)', () => {
  const malformed = [
    // positional guesswork is exactly what the previous cut relied on
    { 'key comparison': '214 / 187 / 401' },
    { 'key comparison': 'corp_a_rows=214 / corp_b_rows=187' },
    { 'key comparison': 'corp_a_rows=214 / distinct_keys=401 / corp_b_rows=187' },
    { 'key comparison': 'as recorded in the ops ticket' },
    { presence: '1 / 1 / true' },
    { presence: 'present_in_a=1 / keys_all_distinct=true' },
    { presence: 'present_in_a=1 / present_in_b=1 / keys_all_distinct=yes' },
    { presence: 'present_in_a=1 / present_in_b=1 / keys_all_distinct=true / notes=looks fine' },
  ]
  for (const override of malformed) {
    const [label] = Object.keys(override)
    const result = assertEvidenceVerdictIsGrounded(
      evidenceDoc({ ...COMPLETED_EVIDENCE, ...override }),
    )
    assert.equal(result.ok, false, `malformed "${label}" (${override[label]}) must fail`)
    // Both rejection paths are load-bearing and proven separately: the field-shape check, and
    // the §3 matrix refusing to ground a verdict on evidence it cannot read.
    assert.ok(
      result.violations.some(
        (v) => /does not have the shape of/i.test(v) && /complete named form/i.test(v) && v.includes(label),
      ),
      `expected a field-shape rejection for "${label}", got: ${result.violations?.join(' | ')}`,
    )
    assert.ok(
      result.violations.some(
        (v) => /cannot be grounded/i.test(v) && v.includes(label),
      ),
      `expected an ungrounded-verdict rejection for "${label}", got: ${result.violations?.join(' | ')}`,
    )
    assert.ok(
      !result.violations.some((v) => /contradicts its own evidence/i.test(v)),
      `an unparseable block must not be routed to a §3 row at all, got: ${result.violations?.join(' | ')}`,
    )
  }
})

test('positive control: honest CONFIRMED / DISPROVED / INCONCLUSIVE blocks all pass', () => {
  const honest = [
    ['DISPROVED', COMPLETED_EVIDENCE],
    ['CONFIRMED', CONFIRMED_EVIDENCE],
    // §3 row 3: both completed but the overlap person is absent under corp B.
    [
      'INCONCLUSIVE (present_in_b=0)',
      {
        ...COMPLETED_EVIDENCE,
        presence: 'present_in_a=1 / present_in_b=0 / keys_all_distinct=true',
        verdict: 'INCONCLUSIVE',
      },
    ],
    // §3 row 3: failed corp B WITHOUT both closed classifications true.
    [
      'INCONCLUSIVE (failed without both flags)',
      { ...CONFIRMED_EVIDENCE, 'corp B expected_constraint_detected': 'false', verdict: 'INCONCLUSIVE' },
    ],
  ]
  for (const [name, evidence] of honest) {
    const doc = evidenceDoc(evidence)
    assert.doesNotMatch(doc, /_TBD_/, `${name} block must contain no placeholder at all`)
    const result = assertEvidenceVerdictIsGrounded(doc)
    assert.equal(
      result.ok,
      true,
      result.ok ? 'ok' : `honest ${name} evidence must pass:\n- ${result.violations.join('\n- ')}`,
    )
  }
})

// ---------------------------------------------------------------------------
// F1 — the two §3 run-status conditions are decided on the CLOSED status vocabulary.
// The unanchored `\b(?:completed|failed)\b` read the substring `completed` out of a sentence,
// so a FAILED corp-B run could ground DISPROVED (skips T2.5, unlocks T3).
// ---------------------------------------------------------------------------

test('verifier repro (F1): a run status outside the closed vocabulary is rejected, never substring-matched', () => {
  const prose = [
    // The two committed mutation proofs: both read as `completed` under the old unanchored regex.
    'failed - the sync never completed',
    'not completed',
    'completed with errors',
    'the corp B run failed',
  ]
  for (const status of prose) {
    const result = assertEvidenceVerdictIsGrounded(
      evidenceDoc({ ...COMPLETED_EVIDENCE, 'corp B run status': status }),
    )
    assert.equal(result.ok, false, `run status "${status}" must be rejected outright`)
    // Half 1 — the anchored SHAPE (kills an unanchored EVIDENCE_VALUE_SHAPES entry).
    assert.ok(
      result.violations.some((v) => /"corp b run status" does not have the shape of/i.test(v)),
      `expected an anchored-shape violation for "${status}", got: ${result.violations.join(' | ')}`,
    )
    // Half 2 — the §3 matrix REJECTS rather than skips (kills a substring test in the matrix).
    assert.ok(
      result.violations.some((v) => /is not one of the closed run statuses/i.test(v)),
      `expected a closed-vocabulary rejection for "${status}", got: ${result.violations.join(' | ')}`,
    )
    // And it must never have been routed to a §3 row at all.
    assert.ok(
      !result.violations.some((v) => /contradicts its own evidence/i.test(v)),
      `"${status}" must be rejected before the §3 row is computed: ${result.violations.join(' | ')}`,
    )
  }
})

test('positive control (F1): the closed vocabulary is accepted and routed by the §3 matrix', () => {
  // `running` is a real directory_sync_runs status: valid vocabulary, but it satisfies neither
  // closed §3 row — so it routes to INCONCLUSIVE rather than being rejected as malformed.
  const runningInconclusive = assertEvidenceVerdictIsGrounded(
    evidenceDoc({ ...COMPLETED_EVIDENCE, 'corp B run status': 'running', verdict: 'INCONCLUSIVE' }),
  )
  assert.equal(
    runningInconclusive.ok,
    true,
    runningInconclusive.ok
      ? 'ok'
      : `"running" is closed vocabulary and must be accepted:\n- ${runningInconclusive.violations.join('\n- ')}`,
  )
  // …and a DISPROVED recorded over it is a CONTRADICTION (routed), not a malformed field.
  const runningDisproved = assertEvidenceVerdictIsGrounded(
    evidenceDoc({ ...COMPLETED_EVIDENCE, 'corp B run status': 'running' }),
  )
  assert.equal(runningDisproved.ok, false, '"running" + DISPROVED must fail')
  assert.ok(
    runningDisproved.violations.some((v) => /contradicts its own evidence/i.test(v)),
    `expected a §3 contradiction, got: ${runningDisproved.violations.join(' | ')}`,
  )
  // Case-insensitivity of the closed set is preserved (operators write it either way).
  assert.equal(
    assertEvidenceVerdictIsGrounded(
      evidenceDoc({ ...CONFIRMED_EVIDENCE, 'corp B run status': 'FAILED' }),
    ).ok,
    true,
    'uppercase closed-vocabulary status must still be accepted',
  )
})

// ---------------------------------------------------------------------------
// F3 — guards that no committed test pinned (each neuter below used to leave the suite green).
// ---------------------------------------------------------------------------

test('verifier repro (F3.2): a duplicate §4 label is rejected (last-wins must not restore a placeholder)', () => {
  // A real, contradictory verdict followed by a SECOND `verdict:` line inside the same fence.
  // Under `new Map(fields.map(…))` / last-wins the placeholder would win and grounding would be
  // skipped entirely, so the whole block would pass.
  const lines = evidenceDoc({ ...CONFIRMED_EVIDENCE, verdict: 'DISPROVED' }).split('\n')
  const closingFence = lines.lastIndexOf('```')
  assert.ok(closingFence > 0, 'fixture must have a closing fence')
  lines.splice(closingFence, 0, 'verdict: _TBD_')
  const result = assertEvidenceVerdictIsGrounded(lines.join('\n'))
  assert.equal(result.ok, false, 'a duplicated §4 label must be rejected')
  assert.ok(
    result.violations.some((v) => /declares "verdict" more than once/i.test(v)),
    `expected a duplicate-label violation, got: ${result.violations.join(' | ')}`,
  )
  // FIRST occurrence must still be the one judged — the contradiction is reported, not skipped.
  assert.ok(
    result.violations.some((v) => /contradicts its own evidence/i.test(v)),
    `first-occurrence-wins must still judge the real verdict, got: ${result.violations.join(' | ')}`,
  )
})

test('verifier repro (F3.3): a ruled verdict recorded outside the §4 block is rejected', () => {
  // Everything inside §4 is still an honest placeholder, so ONLY the stray line can red this.
  const md = `${evidenceDoc()}\nRollout note: verdict: CONFIRMED — T2.5 scheduled.\n`
  assert.equal(
    assertEvidenceVerdictIsGrounded(evidenceDoc()).ok,
    true,
    'control: the all-placeholder block alone must pass',
  )
  const result = assertEvidenceVerdictIsGrounded(md)
  assert.equal(result.ok, false, 'a verdict outside the §4 block must be rejected')
  assert.ok(
    result.violations.some((v) => /recorded outside the §4 evidence block/i.test(v)),
    `expected a stray-verdict violation, got: ${result.violations.join(' | ')}`,
  )
})

// ---------------------------------------------------------------------------
// Synthetic guards — clauses (1)+(2): identity/PII projections + paste instructions
// ---------------------------------------------------------------------------

test('synthetic: the runbook values-free projections pass the identity guard', () => {
  const allowed = [
    `SELECT length(external_key) AS key_len,
            (union_id IS NOT NULL) AS has_union,
            (external_key = union_id) AS key_is_bare_union
       FROM directory_accounts
      WHERE integration_id = '<A>' AND external_user_id = '<overlap userId in A>';`,
    `SELECT count(*) FILTER (WHERE integration_id = '<A>') AS corp_a_rows,
            count(*) FILTER (WHERE integration_id = '<B>') AS corp_b_rows,
            count(DISTINCT external_key) AS distinct_keys
       FROM directory_accounts
      WHERE integration_id IN ('<A>', '<B>');`,
    `SELECT (count(*) FILTER (WHERE integration_id = '<A>' AND external_user_id = '<overlap userId in A>')) AS present_in_a,
            (count(*) FILTER (WHERE integration_id = '<B>' AND external_user_id = '<overlap userId in B>')) AS present_in_b,
            (count(DISTINCT external_key) = count(*)) AS keys_all_distinct
       FROM directory_accounts
      WHERE (integration_id = '<A>' AND external_user_id = '<overlap userId in A>')
         OR (integration_id = '<B>' AND external_user_id = '<overlap userId in B>');`,
  ]
  for (const sql of allowed) {
    const result = assertNoRawIdentityProjections(sql, { bareSql: true })
    assert.equal(
      result.ok,
      true,
      result.ok ? 'ok' : `legitimate values-free SQL must pass:\n- ${result.violations.join('\n- ')}`,
    )
  }
})

test('synthetic: raw identity/PII projections are rejected', () => {
  const rejected = [
    [`SELECT union_id, open_id, corp_id FROM directory_accounts;`, /union_id/],
    [`SELECT name, mobile, email FROM directory_accounts;`, /name|mobile|email/],
    [`SELECT substring(union_id, 1, 8) AS key_len FROM directory_accounts;`, /union_id/],
    [`SELECT coalesce(external_key, '') AS has_union FROM directory_accounts;`, /external_key/],
    [`SELECT union_id || open_id AS keys_all_distinct FROM directory_accounts;`, /union_id/],
    [`SELECT avatar_url AS present_in_a FROM directory_accounts;`, /avatar_url/],
    [`SELECT external_user_id FROM directory_accounts;`, /external_user_id/],
  ]
  for (const [sql, needle] of rejected) {
    const result = assertNoRawIdentityProjections(sql, { bareSql: true })
    assert.equal(result.ok, false, `must reject: ${sql}`)
    assert.ok(
      result.violations.some((v) => /raw identity\/PII column/i.test(v) && needle.test(v)),
      `expected identity-projection violation for ${sql}, got: ${result.violations?.join(' | ')}`,
    )
  }
})

// ---------------------------------------------------------------------------
// Owner reproduction (review of PR #4500) — the values-free guard must be a CLOSED ALLOWLIST of
// projection forms, not a denylist of shapes someone happened to think of. Both of these
// returned ok:true before the fix.
// ---------------------------------------------------------------------------

/** Every SQL projection §2 of the runbook actually uses — all must be inside the allowlist. */
const RUNBOOK_PROJECTIONS = [
  'length(external_key) AS key_len',
  '(union_id IS NOT NULL) AS has_union',
  '(external_key = union_id) AS key_is_bare_union',
  'status',
  ALLOWED_DUP,
  ALLOWED_CONSTRAINT,
  `count(*) FILTER (WHERE integration_id = '<A>') AS corp_a_rows`,
  `count(*) FILTER (WHERE integration_id = '<B>') AS corp_b_rows`,
  'count(DISTINCT external_key) AS distinct_keys',
  `(count(*) FILTER (WHERE integration_id = '<A>' AND external_user_id = '<overlap userId in A>')) AS present_in_a`,
  `(count(*) FILTER (WHERE integration_id = '<B>' AND external_user_id = '<overlap userId in B>')) AS present_in_b`,
  '(count(DISTINCT external_key) = count(*)) AS keys_all_distinct',
]

test('owner repro: whole-row / un-named exports outside the allowlist are rejected', () => {
  const rejected = [
    // `raw` persists JSON.stringify(user.source) — the provider's raw business record. No
    // column-name denylist ever named it.
    `SELECT raw FROM directory_accounts;`,
    `SELECT a.raw FROM directory_accounts a;`,
    // whole-row export through an aggregate the serializer list does not name
    `SELECT array_agg(a) FROM directory_accounts a;`,
    `SELECT jsonb_build_object('row', a) FROM directory_accounts a;`,
    `SELECT string_agg(status, ',') FROM directory_sync_runs;`,
    `SELECT metadata->>'source' FROM directory_accounts;`,
    `SELECT source FROM directory_accounts;`,
  ]
  for (const sql of rejected) {
    const result = assertNoRawIdentityProjections(sql, { bareSql: true })
    assert.equal(result.ok, false, `must reject: ${sql}`)
    assert.ok(
      result.violations.some((v) => /outside the closed values-free allowlist/i.test(v)),
      `expected an allowlist violation for ${sql}, got: ${result.violations?.join(' | ')}`,
    )
  }
})

test('synthetic: a keyword inside an identifier does not truncate the projection list', () => {
  // The runbook's own alias `has_union` used to end extraction (mid-identifier `\bUNION\b`), so
  // every projection AFTER it was invisible to all three projection guards.
  const sql = [
    'SELECT length(external_key) AS key_len,',
    '       (union_id IS NOT NULL) AS has_union,',
    '       union_id, open_id, mobile, raw',
    '  FROM directory_accounts;',
  ].join('\n')
  const lists = extractSelectLists(sql)
  assert.equal(lists.length, 1, 'one SELECT list expected')
  assert.match(lists[0], /raw$/, `projection list was truncated: ${JSON.stringify(lists[0])}`)

  const result = assertNoRawIdentityProjections(sql, { bareSql: true })
  assert.equal(result.ok, false, 'identity columns after has_union must be seen and rejected')
  for (const needle of [/union_id/, /open_id/, /mobile/]) {
    assert.ok(
      result.violations.some((v) => /raw identity\/PII column/i.test(v) && needle.test(v)),
      `expected ${needle} to be reported, got: ${result.violations?.join(' | ')}`,
    )
  }
  assert.ok(
    result.violations.some((v) => /outside the closed values-free allowlist/i.test(v) && /raw/.test(v)),
    `expected the trailing "raw" column to be reported, got: ${result.violations?.join(' | ')}`,
  )
})

test('positive control: every projection the runbook uses is expressible in the allowlist', () => {
  for (const proj of RUNBOOK_PROJECTIONS) {
    const { allowed, reduced } = inspectProjectionAgainstAllowlist(proj)
    assert.equal(
      allowed,
      true,
      `runbook projection must be inside the allowlist (reduced to "${reduced}"): ${proj}`,
    )
  }

  // Anti-vacuity: the guard must actually be SEEING the runbook's projections, not passing on an
  // empty list because extraction silently found nothing.
  const seen = extractFencedSqlBlocks(loadRunbook())
    .flatMap((b) => extractSelectLists(b))
    .flatMap((l) => splitTopLevelProjections(l))
  assert.ok(
    seen.length >= RUNBOOK_PROJECTIONS.length,
    `expected >=${RUNBOOK_PROJECTIONS.length} extracted runbook projections, got ${seen.length}`,
  )
  for (const proj of seen) {
    const { allowed, reduced } = inspectProjectionAgainstAllowlist(proj)
    assert.equal(
      allowed,
      true,
      `extracted runbook projection is outside the allowlist (reduced to "${reduced}"): ${proj}`,
    )
  }
})

test('synthetic: an identity projection cannot hide behind a relabelled fence', () => {
  for (const tag of ['sql', 'postgresql', 'psql', '']) {
    const md = ['```' + tag, 'SELECT union_id, name FROM directory_accounts;', '```'].join('\n')
    const result = assertNoRawIdentityProjections(md)
    assert.equal(result.ok, false, `fence tag "${tag}" must not bypass the identity guard`)
  }
})

// ---------------------------------------------------------------------------
// F2 — the VENUES are a closed set too, not a denylist of delimiters.
// GitHub renders `~~~sql` and `<pre>` exactly like a backtick fence; a guard that only knows
// backticks is bypassed by pressing a different key.
// ---------------------------------------------------------------------------

const IDENTITY_SELECT = 'SELECT union_id, open_id, mobile, raw FROM directory_accounts;'
const RAW_ERROR_SELECT = 'SELECT status, error_message FROM directory_sync_runs;'

/** Every venue a reader sees as a code block, as an editor would actually write it. */
const CODE_VENUES = [
  ['backtick fence (control)', (sql) => ['```sql', sql, '```'].join('\n')],
  ['tilde fence', (sql) => ['~~~sql', sql, '~~~'].join('\n')],
  ['long tilde fence', (sql) => ['~~~~~sql', sql, '~~~~~'].join('\n')],
  ['indented tilde fence', (sql) => ['   ~~~sql', `   ${sql}`, '   ~~~'].join('\n')],
  // Body indented 4+ spaces: if the stripper does not remove the TILDE venue, this body is
  // re-read as "indented SQL" instead of as the code block it is. That is what pins the
  // stripper to the same closed venue set as the extractors.
  ['tilde fence with a 4-space-indented body', (sql) => ['~~~sql', `    ${sql}`, '~~~'].join('\n')],
  ['html <pre>', (sql) => ['<pre>', sql, '</pre>'].join('\n')],
  ['html <pre> with attributes', (sql) => ['<pre class="highlight">', sql, '</pre>'].join('\n')],
  ['html <code>', (sql) => ['<code>', sql, '</code>'].join('\n')],
]

test('verifier repro (F2): raw identity projections are rejected in EVERY code venue, not just backticks', () => {
  for (const [name, wrap] of CODE_VENUES) {
    const result = assertNoRawIdentityProjections(wrap(IDENTITY_SELECT))
    assert.equal(result.ok, false, `venue "${name}" must not bypass the identity guard`)
    assert.ok(
      result.violations.some((v) => /raw identity\/PII column "union_id" is projected/i.test(v)),
      `venue "${name}" must report the projection itself, got: ${result.violations.join(' | ')}`,
    )
    // The venue must be read AS a code block: an indented body inside a non-backtick fence must
    // not be re-reported as "indented SQL" (that would mean the stripper missed the venue).
    assert.ok(
      !result.violations.some((v) => /must live in a fenced code block/i.test(v)),
      `venue "${name}" was not stripped before the indented-SQL scan: ${result.violations.join(' | ')}`,
    )
  }
})

test('verifier repro (F2): raw error_message projections stay closed in EVERY code venue', () => {
  for (const [name, wrap] of CODE_VENUES) {
    if (name === 'html <code>') continue // covered by <pre>; identical extraction path
    const result = assertErrorMessageProjectionsAreClosed(wrap(RAW_ERROR_SELECT))
    assert.equal(result.ok, false, `venue "${name}" must not bypass the error_message guard`)
    assert.ok(
      result.violations.some((v) => /direct\/unaliased error_message projection forbidden/i.test(v)),
      `venue "${name}" expected a direct/unaliased violation, got: ${result.violations.join(' | ')}`,
    )
  }
  // Alias-smuggling is equally closed in a non-backtick venue.
  const smuggle = assertErrorMessageProjectionsAreClosed(
    ['~~~sql', 'SELECT substring(error_message,1,120) AS duplicate_key_detected FROM directory_sync_runs;', '~~~'].join('\n'),
  )
  assert.equal(smuggle.ok, false, 'tilde-fenced alias-smuggle must fail')
})

test('positive control (F2): the allowed closed booleans still pass in a non-backtick venue', () => {
  const body = [
    `SELECT status, ${ALLOWED_DUP}, ${ALLOWED_CONSTRAINT}`,
    '  FROM directory_sync_runs',
    " WHERE integration_id = '<B>'",
    ' ORDER BY started_at DESC LIMIT 1;',
  ].join('\n')
  for (const wrap of [
    (sql) => ['~~~sql', sql, '~~~'].join('\n'),
    (sql) => ['<pre>', sql, '</pre>'].join('\n'),
  ]) {
    const result = assertErrorMessageProjectionsAreClosed(wrap(body))
    assert.equal(
      result.ok,
      true,
      result.ok ? 'ok' : `allowed booleans must still pass:\n- ${result.violations.join('\n- ')}`,
    )
  }
})

test('anti-vacuity (F2): the venue scanner still sees the runbook’s own indented backtick fences', () => {
  // The runbook writes `   ```sql` (three-space indent, inside a numbered list). If the scanner
  // required a column-0 fence, every runbook-level guard below would pass on an EMPTY block list.
  const runbook = loadRunbook()
  const sqlBlocks = extractFencedSqlBlocks(runbook)
  assert.ok(sqlBlocks.length >= 4, `expected >=4 runbook SQL venues, got ${sqlBlocks.length}`)
  assert.ok(
    sqlBlocks.some((b) => /position\('duplicate key' in error_message\)/i.test(b)),
    'the closed-classification SQL block must still be extracted',
  )
  assert.equal(
    findUnfencedSelectFromShapes(runbook).length,
    0,
    'the runbook’s fenced SQL must not be misread as an unfenced SELECT … FROM shape',
  )
})

test('verifier repro (F3.1): an indented (unfenced) identity SELECT is rejected, not invisible', () => {
  const md = [
    'Run this on staging and record the result:',
    '',
    "    SELECT union_id, mobile FROM directory_accounts WHERE integration_id = '<A>';",
    '',
  ].join('\n')
  const result = assertNoRawIdentityProjections(md)
  assert.equal(result.ok, false, 'indented SQL must not be invisible to the projection guards')
  assert.ok(
    result.violations.some((v) => /must live in a fenced code block/i.test(v)),
    `expected an unfenced-SQL violation, got: ${result.violations.join(' | ')}`,
  )
  // Strict fence contract: the SHAPE alone is the violation — nothing outside a venue is parsed
  // as SQL, so no projection-level report is expected (or needed) here.
})

// ---------------------------------------------------------------------------
// Owner reproductions (round 3 of PR #4500) — the guard was still VENUE-BLIND. All three samples
// below returned ok:true at head 2a481b974:
//   (a) a fence whose info string carries extra words (```sql linenums) was not scanned;
//   (b) `~~~sql title=probe` (tilde fence + attribute) was not scanned;
//   (c) a plain SELECT in ordinary body text — not indented, not fenced — was not scanned at all.
// Round-5 owner ruling (strict fence contract): (a)/(b) are real venues and go through the
// projection guards; every (c) sample is a `SELECT … FROM` shape outside a venue and is a
// violation BY THAT FACT alone — it is never parsed as SQL.
// ---------------------------------------------------------------------------

/** The owner's three samples, plus the near neighbours of each. */
const OWNER_VENUE_SAMPLES = [
  // (a) — info string carrying extra words after the language tag
  ['(a) ```sql linenums', (sql) => ['```sql linenums', sql, '```'].join('\n')],
  ['(a) ```sql linenums title="probe"', (sql) => ['```sql linenums title="probe"', sql, '```'].join('\n')],
  ['(a) ```postgresql linenums', (sql) => ['```postgresql linenums', sql, '```'].join('\n')],
  ['(a) ```{.sql #probe}', (sql) => ['```{.sql #probe}', sql, '```'].join('\n')],
  ['(a) indented ```sql linenums', (sql) => ['   ```sql linenums', `   ${sql}`, '   ```'].join('\n')],
  // (b) — tilde fence with a title attribute
  ['(b) ~~~sql title=probe', (sql) => ['~~~sql title=probe', sql, '~~~'].join('\n')],
  ['(b) ~~~~sql title=probe {.highlight}', (sql) => ['~~~~sql title=probe {.highlight}', sql, '~~~~'].join('\n')],
  // (c) — ordinary body text: no fence, no four-space indent
  [
    '(c) plain body text',
    (sql) => `Run this on staging and record the outcome:\n\n${sql}\n\nThen continue with step 4.\n`,
  ],
  ['(c) inline code span in a sentence', (sql) => `Run \`${sql}\` on staging, then continue.\n`],
  ['(c) markdown list item', (sql) => `Steps:\n\n- ${sql}\n- record the outcome\n`],
  ['(c) blockquote', (sql) => `> ${sql}\n`],
  ['(c) table cell', (sql) => `| step | query |\n|---|---|\n| 2 | ${sql} |\n`],
]

test('owner repro (round 3): identity SQL is rejected in EVERY venue — full info strings scanned, no venue at all is a violation by itself', () => {
  for (const [name, wrap] of OWNER_VENUE_SAMPLES) {
    const md = wrap(IDENTITY_SELECT)
    const result = assertNoRawIdentityProjections(md)
    assert.equal(result.ok, false, `venue "${name}" must not bypass the identity guard`)
    if (name.startsWith('(c)')) {
      // Strict fence contract: outside a code venue the SELECT … FROM shape IS the violation.
      assert.ok(
        result.violations.some((v) => /must live in a fenced code block/i.test(v)),
        `venue "${name}" must red as unfenced SQL, got: ${result.violations.join(' | ')}`,
      )
    } else {
      assert.ok(
        result.violations.some((v) => /raw identity\/PII column "union_id" is projected/i.test(v)),
        `venue "${name}" must report the projection itself, got: ${result.violations.join(' | ')}`,
      )
      assert.ok(
        result.violations.some((v) => /outside the closed values-free allowlist/i.test(v) && /raw/.test(v)),
        `venue "${name}" must also report the un-named "raw" column, got: ${result.violations.join(' | ')}`,
      )
      // A real venue must be READ AS a code block, never mis-reported as loose text: an info
      // string the scanner cannot parse would turn a real fence into "unfenced SQL".
      assert.ok(
        !result.violations.some((v) => /must live in a fenced code block/i.test(v)),
        `venue "${name}" was classified wrongly (fenced vs unfenced): ${result.violations.join(' | ')}`,
      )
    }
    assert.equal(
      scanCodeVenues(md).length,
      name.startsWith('(c)') ? 0 : 1,
      `venue "${name}" must resolve to exactly the code venues it has`,
    )
  }
})

test('owner repro (round 3): error_message projections stay closed in EVERY venue', () => {
  for (const [name, wrap] of OWNER_VENUE_SAMPLES) {
    const result = assertErrorMessageProjectionsAreClosed(wrap(RAW_ERROR_SELECT))
    assert.equal(result.ok, false, `venue "${name}" must not bypass the error_message guard`)
    if (name.startsWith('(c)')) {
      assert.ok(
        result.violations.some((v) => /must live in a fenced code block/i.test(v)),
        `venue "${name}" must red as unfenced SQL, got: ${result.violations.join(' | ')}`,
      )
    } else {
      assert.ok(
        result.violations.some((v) => /direct\/unaliased error_message projection forbidden/i.test(v)),
        `venue "${name}" expected a direct/unaliased violation, got: ${result.violations.join(' | ')}`,
      )
    }
  }
  // …and alias-smuggling is equally closed in the same venues.
  for (const [name, wrap] of OWNER_VENUE_SAMPLES) {
    const smuggle = assertErrorMessageProjectionsAreClosed(
      wrap('SELECT substring(error_message,1,120) AS duplicate_key_detected FROM directory_sync_runs;'),
    )
    assert.equal(smuggle.ok, false, `venue "${name}" must not bypass the alias-smuggle guard`)
  }
})

test('owner repro (round 3, c) under the strict fence contract: unfenced SQL is a violation by SHAPE alone', () => {
  const md = `Run this on staging and record the outcome:\n\n${IDENTITY_SELECT}\n\nThen continue.\n`
  // Anti-vacuity: the scanner must actually return the shape, not silently match nothing.
  const shapes = findUnfencedSelectFromShapes(md)
  assert.equal(shapes.length, 1, `expected exactly one unfenced shape, got ${shapes.length}`)
  assert.match(
    shapes[0],
    /^SELECT union_id, open_id, mobile, raw FROM directory_accounts;/,
    `the reported shape must be the statement itself: ${shapes[0]}`,
  )

  const result = assertNoRawIdentityProjections(md)
  assert.equal(result.ok, false, 'unfenced SQL must red')
  assert.ok(
    result.violations.some((v) => /must live in a fenced code block/i.test(v)),
    `expected an unfenced-SQL violation, got: ${result.violations.join(' | ')}`,
  )
  // …and the error_message guard enforces the SAME venue rule — neither guard can be satisfied
  // while SQL sits outside a venue.
  const errResult = assertErrorMessageProjectionsAreClosed(md)
  assert.equal(errResult.ok, false, 'the error_message guard must apply the same venue rule')
  assert.ok(
    errResult.violations.some((v) => /must live in a fenced code block/i.test(v)),
    `expected an unfenced-SQL violation from the error_message guard, got: ${errResult.violations.join(' | ')}`,
  )

  // A statement broken across inline code spans is still an unfenced shape: the backticks are
  // prose markup, not a code venue. Without stripping them the FROM target reads as
  // `` `directory_…` `` and the shape disappears from the scanner.
  const splitSpan = 'Run `SELECT union_id, open_id, mobile, raw` from `directory_accounts` on staging.'
  assert.equal(
    findUnfencedSelectFromShapes(splitSpan).length,
    1,
    `a shape split across inline code spans must still be found: ${splitSpan}`,
  )
  assert.equal(
    assertNoRawIdentityProjections(splitSpan).ok,
    false,
    'the split-span shape must red as unfenced SQL',
  )
})

test('positive control (round 3): a prose MENTION of a column is not a SQL projection', () => {
  // The runbook's own values-free ban lines and operator prose — every one of them names banned
  // columns IN WORDS, and none of them has a `SELECT … FROM` shape. If the guards ever degrade
  // into a bare column-name matcher, or the shape scan starts swallowing shape-free prose, these
  // red. (A sentence that DOES carry the shape — «select the corp A rows from directory_accounts
  // by hand» — is now flagged BY RULE: see the strict-fence-contract tests below.)
  const prose = [
    'PostgreSQL duplicate-key text can embed the real `external_key` / `unionId`; **never** ' +
      'project, print, grep, copy, or persist `error_message` / err-head into the evidence pack.',
    '**Values-free** here means: no raw **provider identity** (unionId / openId / userId / corpId), ' +
      'no **business values**, and no **raw SQL error text**.',
    'Record the overlap person’s key shape under A (values-free — length/equality booleans only; ' +
      'do **not** paste provider union/open/user IDs into the evidence pack).',
    'The sync derives `external_key` as the bare `unionId || openId || userId` — no corp scoping.',
    '**No** names, raw provider union/open/user IDs, DingTalk corp IDs, credentials, URLs, SQL ' +
      'error strings, or business values in operator evidence.',
    // FROM without SELECT is not the shape.
    'Every row in the table above should be read from directory_sync_runs.',
  ]
  for (const line of prose) {
    assert.equal(
      findUnfencedSelectFromShapes(line).length,
      0,
      `shape-free prose must not be flagged: ${line}`,
    )
    const identity = assertNoRawIdentityProjections(line)
    assert.equal(
      identity.ok,
      true,
      identity.ok ? 'ok' : `prose must stay legal:\n- ${identity.violations.join('\n- ')}`,
    )
    const errMessage = assertErrorMessageProjectionsAreClosed(line)
    assert.equal(
      errMessage.ok,
      true,
      errMessage.ok ? 'ok' : `prose must stay legal:\n- ${errMessage.violations.join('\n- ')}`,
    )
  }

  // The whole runbook is the real positive control: it discusses every banned column in words and
  // must keep passing untouched.
  const runbook = loadRunbook()
  assert.equal(assertNoRawIdentityProjections(runbook).ok, true, 'the live runbook must keep passing')
  assert.equal(
    assertErrorMessageProjectionsAreClosed(runbook).ok,
    true,
    'the live runbook must keep passing',
  )
})

test('positive control (round 3): a full info string does not stop a LEGITIMATE block from passing', () => {
  const body = [
    `SELECT status, ${ALLOWED_DUP}, ${ALLOWED_CONSTRAINT}`,
    '  FROM directory_sync_runs',
    " WHERE integration_id = '<B>'",
    ' ORDER BY started_at DESC LIMIT 1;',
  ].join('\n')
  for (const [name, wrap] of OWNER_VENUE_SAMPLES) {
    if (name.startsWith('(c)')) continue // unfenced SQL is a venue violation by construction
    const md = wrap(body)
    const errMessage = assertErrorMessageProjectionsAreClosed(md)
    assert.equal(
      errMessage.ok,
      true,
      errMessage.ok ? 'ok' : `venue "${name}" must still pass:\n- ${errMessage.violations.join('\n- ')}`,
    )
    const identity = assertNoRawIdentityProjections(md)
    assert.equal(
      identity.ok,
      true,
      identity.ok ? 'ok' : `venue "${name}" must still pass:\n- ${identity.violations.join('\n- ')}`,
    )
  }
})

test('anti-vacuity (round 3): the full info string is parsed, and the runbook’s own venues still resolve', () => {
  const venues = scanCodeVenues(
    ['```sql linenums title="probe"', 'SELECT 1 FROM t;', '```', '', '~~~sql title=probe', 'SELECT 2 FROM t;', '~~~'].join('\n'),
  )
  assert.equal(venues.length, 2, `expected 2 venues, got ${venues.length}`)
  assert.deepEqual(
    venues.map((v) => v.info),
    ['sql linenums title="probe"', 'sql title=probe'],
    'the COMPLETE info string must be preserved',
  )
  assert.deepEqual(venues.map((v) => v.tag), ['sql', 'sql'], 'the language tag is the first token')
  assert.deepEqual(
    venues.map((v) => v.body.trim()),
    ['SELECT 1 FROM t;', 'SELECT 2 FROM t;'],
    'the bodies must be captured, not swallowed by an unrecognised fence',
  )

  // The runbook itself: 4 SQL venues + the §4 evidence block, all still resolved by the relaxed
  // scanner (a scanner that stopped matching would make every runbook-level guard vacuous).
  const runbook = loadRunbook()
  assert.equal(scanCodeVenues(runbook).length, 5, 'the runbook has 5 code venues')
  assert.equal(extractFencedSqlBlocks(runbook).length, 4, 'the runbook has 4 SQL venues')
})

// ---------------------------------------------------------------------------
// STRICT FENCE CONTRACT (round 5 of PR #4500) — the "is this unfenced text SQL?" question is
// RETIRED, because both answers to it failed:
//   - round ≤3: a VOCABULARY (~30 English function words) — a leaking statement exempted itself
//     with a word (all samples below returned ok:true at head 2b6590e46);
//   - round 4: a STRUCTURAL test ("does the projection list resolve as an expression?") — which
//     began mis-flagging ordinary prose: «Select status from directory_sync_runs after each run
//     and record only the booleans.» was swallowed whole as a SQL statement (verified at
//     28cc7c5a4), because `status` is one bare operand and `directory_sync_runs` resolves as a
//     source.
// Owner ruling: outside a scanned code venue, ANY `SELECT … FROM` shape is a violation, full
// stop. Over-flagging is intended — the failure is loud, and the author's fix is to fence the
// SQL or reword the sentence. Inside venues, the closed projection allowlist is unchanged.
// ---------------------------------------------------------------------------

/** Leaking statements, in ordinary body text, that once exempted themselves through the vocabulary. */
const ROUND4_VOCABULARY_BYPASSES = [
  // Words that are ALSO SQL and were therefore in the prose list: every() is a Postgres aggregate,
  // BOTH is trim()'s modifier, ANY() is a quantified comparison.
  ['every() aggregate', "SELECT union_id, every(sync_enabled) AS all_enabled FROM directory_accounts;"],
  ['trim(BOTH …)', "SELECT union_id, trim(both ' ' from mobile) AS m FROM directory_accounts;"],
  ['= ANY(…)', "SELECT union_id, mobile = any(array['x']) AS hit FROM directory_accounts;"],
  // A stopword the statement never USES — it only has to be present, so a literal or a quoted
  // alias carries it (P3: literals/comments were not neutralised before the test).
  ['stopword inside a string literal', "SELECT union_id, 'the key' AS label FROM directory_accounts;"],
  ['stopword inside a quoted alias', 'SELECT union_id, mobile AS "the contact" FROM directory_accounts;'],
  ['stopword inside a -- comment', 'SELECT union_id, -- the key\n  mobile FROM directory_accounts;'],
]

test('strict fence contract: a leaking statement cannot exempt itself with a WORD — there is no vocabulary left to consult', () => {
  for (const [name, sql] of ROUND4_VOCABULARY_BYPASSES) {
    const md = `Run this on staging and record the outcome:\n\n${sql}\n\nThen continue with step 4.\n`
    assert.ok(
      findUnfencedSelectFromShapes(md).length >= 1,
      `"${name}" must be flagged as an unfenced SELECT … FROM shape, not skipped as prose`,
    )
    const result = assertNoRawIdentityProjections(md)
    assert.equal(result.ok, false, `"${name}" must not bypass the identity guard`)
    assert.ok(
      result.violations.some((v) => /must live in a fenced code block/i.test(v)),
      `"${name}" must be reported as unfenced SQL, got: ${result.violations.join(' | ')}`,
    )
    // …and the SAME statement inside a fence is decided by the projection allowlist, which
    // rejects its identity projection — no word grants an exemption in either venue.
    const fenced = assertNoRawIdentityProjections(['```sql', sql, '```'].join('\n'))
    assert.equal(fenced.ok, false, `"${name}" fenced must still red on its projections`)
    assert.ok(
      fenced.violations.some((v) => /raw identity\/PII column "union_id" is projected/i.test(v)),
      `"${name}" fenced must report the projection itself, got: ${fenced.violations.join(' | ')}`,
    )
  }
})

test('strict fence contract: no literal can hide a statement from the shape scan, and no `;`/blank line rescues it', () => {
  // These two used to need statement-extent cleverness; the shape rule flags both trivially.
  const cases = [
    ['semicolon inside a string literal', `Run this:\n\nSELECT union_id, 'a;b' AS label FROM directory_accounts;\n\nThen continue.\n`],
    ['statement spanning a blank line', `Run this:\n\nSELECT union_id, open_id,\n\n  mobile\nFROM directory_accounts;\n\nThen continue.\n`],
  ]
  for (const [name, md] of cases) {
    assert.ok(
      findUnfencedSelectFromShapes(md).length >= 1,
      `"${name}" must be flagged as an unfenced SELECT … FROM shape`,
    )
    const result = assertNoRawIdentityProjections(md)
    assert.equal(result.ok, false, `"${name}" must red`)
    assert.ok(
      result.violations.some((v) => /must live in a fenced code block/i.test(v)),
      `"${name}" must red as unfenced SQL, got: ${result.violations.join(' | ')}`,
    )
  }
})

test('fenced SQL parsing: a `;`/keyword inside a literal, a comment, or a DOLLAR-QUOTE is text, not a terminator', () => {
  // A `;` in a literal is text, so the projection list must not end there and every projection
  // after it stays visible to the guards.
  const lists = extractSelectLists("SELECT length(external_key) AS k, 'a ;b' AS label, mobile FROM directory_accounts;")
  assert.equal(lists.length, 1, 'one SELECT list expected')
  assert.match(lists[0], /mobile$/, `projection list was truncated at a quoted ";": ${JSON.stringify(lists[0])}`)
  // …and a keyword inside a comment is text too, not a terminator.
  const commented = extractSelectLists('SELECT union_id, -- FROM directory_sync_runs\n  mobile FROM directory_accounts;')
  assert.equal(commented.length, 1, 'one SELECT list expected')
  assert.match(
    normalizeSqlWs(commented[0]),
    /mobile$/,
    `projection list was truncated at a commented-out keyword: ${JSON.stringify(commented[0])}`,
  )

  // Gate finding (round 5): PostgreSQL dollar-quoting was NOT masked, so a `;` or a FROM inside
  // `$$…$$` / `$tag$…$tag$` truncated the projection list there — `mobile` after the dollar-quote
  // was invisible to every projection guard (verified at 28cc7c5a4: the extracted list ended at
  // `$$a`). The literal's interior must carry no structure, like any other literal.
  for (const sql of [
    'SELECT length(external_key) AS k, $$a ;b$$ AS label, mobile FROM directory_accounts;',
    'SELECT length(external_key) AS k, $$note FROM x$$ AS label, mobile FROM directory_accounts;',
    'SELECT length(external_key) AS k, $tag$a ;b$tag$ AS label, mobile FROM directory_accounts;',
  ]) {
    const dollarLists = extractSelectLists(sql)
    assert.equal(dollarLists.length, 1, `one SELECT list expected: ${sql}`)
    assert.match(
      normalizeSqlWs(dollarLists[0]),
      /mobile$/,
      `projection list was truncated inside a dollar-quote: ${JSON.stringify(dollarLists[0])}`,
    )
    const result = assertNoRawIdentityProjections(sql, { bareSql: true })
    assert.equal(result.ok, false, `dollar-quoted sample must still red on its projections: ${sql}`)
    assert.ok(
      result.violations.some((v) => /raw identity\/PII column "mobile" is projected/i.test(v)),
      `the projection AFTER the dollar-quote must be seen and rejected, got: ${result.violations.join(' | ')}`,
    )
  }

  // The masking itself: length-preserving, structure removed.
  const masked = maskSqlLiteralsAndComments("SELECT a, 'x;FROM y' AS b -- FROM z\n  FROM t;")
  assert.equal(masked.length, "SELECT a, 'x;FROM y' AS b -- FROM z\n  FROM t;".length, 'masking must preserve length')
  assert.equal(masked.includes(';FROM'), false, 'a literal must carry no structure')
  const dollarSql = 'SELECT a, $$x;FROM y$$ AS b FROM t;'
  const dollarMasked = maskSqlLiteralsAndComments(dollarSql)
  assert.equal(dollarMasked.length, dollarSql.length, 'dollar-quote masking must preserve length')
  assert.equal(dollarMasked.includes(';FROM'), false, 'a dollar-quoted literal must carry no structure')
  assert.match(dollarMasked, /\$\$ {8}\$\$/, 'the $$ delimiters stay; only the interior is blanked')
})

test('strict fence contract: prose WITH a SELECT … FROM shape is flagged LOUDLY — over-strictness is intended', () => {
  // The round-5 gate sample plus the two sentences the earlier cuts fought to keep legal. Under
  // the strict contract they are violations BY RULE: the failure is visible, and the author's
  // fix is to fence the SQL or reword the sentence.
  const flagged = [
    'Select status from directory_sync_runs after each run and record only the booleans.',
    'If the admin API is unavailable, select the corp A rows from directory_accounts by hand and ' +
      'record only the counts.',
    'Record only the counts; do not select the union ids or the mobile numbers from either corp.',
  ]
  for (const line of flagged) {
    assert.equal(findUnfencedSelectFromShapes(line).length, 1, `the strict contract must flag: ${line}`)
    const identity = assertNoRawIdentityProjections(line)
    assert.equal(identity.ok, false, `the strict contract must red: ${line}`)
    assert.ok(
      identity.violations.some((v) => /must live in a fenced code block/i.test(v)),
      `expected the strict-fence violation, got: ${identity.violations.join(' | ')}`,
    )
    const errMessage = assertErrorMessageProjectionsAreClosed(line)
    assert.equal(errMessage.ok, false, `both guards enforce the venue rule: ${line}`)
  }

  // The documented fix works: fenced, the venue rule stops firing and the projection allowlist
  // takes over — `SELECT status FROM directory_sync_runs` projects only the allowed bare column.
  const fenced = ['```sql', 'SELECT status FROM directory_sync_runs;', '```'].join('\n')
  assert.equal(findUnfencedSelectFromShapes(fenced).length, 0, 'fenced SQL is not an unfenced shape')
  assert.equal(assertNoRawIdentityProjections(fenced).ok, true, 'the fenced fix must pass')
  assert.equal(assertErrorMessageProjectionsAreClosed(fenced).ok, true, 'the fenced fix must pass')
})

test('positive control (strict fence contract): shape-free prose passes — no vocabulary is consulted in either direction', () => {
  // The guard must not degrade into "reject everything": prose that names banned columns in
  // words, uses FROM without SELECT, or uses SELECT without FROM, all stays legal.
  const prose = [
    'The sync derives `external_key` as the bare `unionId || openId || userId` — no corp scoping.',
    'Every row in the table above should be read from directory_sync_runs.',
    'The operator may select either corp to create first.',
    'Read the outcome — closed classifications only.',
    'the corp A rows / only the counts / each of two integration ids',
  ]
  for (const line of prose) {
    assert.equal(findUnfencedSelectFromShapes(line).length, 0, `shape-free prose must not be flagged: ${line}`)
    const identity = assertNoRawIdentityProjections(line)
    assert.equal(identity.ok, true, identity.ok ? 'ok' : `prose must stay legal:\n- ${identity.violations.join('\n- ')}`)
  }

  // A values-free statement outside a venue is reported ONLY for its venue, never for its
  // projections (nothing outside a venue is parsed as SQL)…
  const legit = `Run this on staging:\n\nSELECT status, ${ALLOWED_DUP}, ${ALLOWED_CONSTRAINT} FROM directory_sync_runs;\n`
  const result = assertNoRawIdentityProjections(legit)
  assert.equal(result.ok, false, 'unfenced SQL is a venue violation by construction')
  assert.deepEqual(
    result.violations.filter((v) => !/must live in a fenced code block/i.test(v)),
    [],
    `a values-free statement must raise no projection violation: ${result.violations.join(' | ')}`,
  )
  // …and the SAME statement inside a fence passes both guards untouched.
  const fenced = ['```sql', `SELECT status, ${ALLOWED_DUP}, ${ALLOWED_CONSTRAINT} FROM directory_sync_runs;`, '```'].join('\n')
  const fencedIdentity = assertNoRawIdentityProjections(fenced)
  assert.equal(
    fencedIdentity.ok,
    true,
    fencedIdentity.ok ? 'ok' : `the fenced closed booleans must pass:\n- ${fencedIdentity.violations.join('\n- ')}`,
  )
  const fencedErr = assertErrorMessageProjectionsAreClosed(fenced)
  assert.equal(
    fencedErr.ok,
    true,
    fencedErr.ok ? 'ok' : `the fenced closed booleans must pass:\n- ${fencedErr.violations.join('\n- ')}`,
  )
})

test('gate NIT (round 4): a code venue is SQL by its CONTENT, never by its language tag', () => {
  const md = [
    '```postgresql',
    'SELECT union_id FROM directory_accounts;',
    '```',
    '',
    '```',
    'SELECT open_id FROM directory_accounts;',
    '```',
    '',
    '```text',
    'SELECT mobile FROM directory_accounts;',
    '```',
    '',
    '```sh',
    'psql -c "\\dt"',
    '```',
  ].join('\n')
  const blocks = extractFencedSqlBlocks(md)
  assert.equal(blocks.length, 3, `expected the 3 SQL venues regardless of tag, got ${blocks.length}`)
  for (const needle of [/union_id/, /open_id/, /mobile/]) {
    assert.ok(blocks.some((b) => needle.test(b)), `a relabelled SQL venue was dropped: ${needle}`)
  }
  // Anti-vacuity in the other direction: a venue with no SQL in it is not a SQL block.
  assert.equal(blocks.some((b) => /psql -c/.test(b)), false, 'a non-SQL venue must not be a SQL block')
})

test('gate NIT (round 4): the §4 template shows the named-field form the guard actually accepts', () => {
  const lines = loadRunbook().split('\n')
  for (const [label, format] of [
    ['key comparison', KEY_COMPARISON_FORMAT],
    ['presence', PRESENCE_FORMAT],
  ]) {
    const line = lines.find((l) => normalizeEvidenceLabel(l.split(':')[0]) === label)
    assert.ok(line, `§4 must carry a "${label}" row`)
    assert.ok(
      line.includes(format.hint),
      `§4 "${label}" must show the accepted form "${format.hint}" (an operator who follows a hint ` +
        `the guard rejects is told his real evidence is malformed), got: ${line.trim()}`,
    )
    // Anti-vacuity: the hint the template shows is a value this guard accepts.
    assert.match(format.hint.replace(/<n>/g, '1').replace(/<true\|false>/g, 'true'), format.re)
  }
})

test('synthetic: paste-raw-identity instructions are rejected, negated bans are kept', () => {
  const bad = [
    'Paste the overlap person’s unionId and full name into the §4 evidence block.',
    'Record the corpId and mobile number in the evidence pack.',
    'Copy the openId of the overlap person into §4.',
    // A bare "no"/"not" ANYWHERE earlier in the clause must not read as a prohibition — the
    // negation has to attach to the capture itself. This is the case the negation fix closed;
    // without a committed fixture, broadening PROSE_NEGATION back to /\b(?:no|not|…)/ was a
    // silent, fully-green neuter (found while re-running the older mutation proofs).
    'There is no need to redact anything here, paste the unionId into the evidence pack.',
    'It is not a secret, so record the overlap person’s mobile number in §4.',
  ]
  for (const line of bad) {
    const result = assertNoRawIdentityPasteInstructions(line)
    assert.equal(result.ok, false, `must reject instruction: ${line}`)
    assert.ok(
      result.violations.some((v) => /captures raw identity\/PII/i.test(v)),
      `expected paste-instruction violation, got: ${result.violations?.join(' | ')}`,
    )
  }

  const good = [
    'do **not** paste provider union/open/user IDs into the evidence pack',
    '**never** project, print, grep, copy, or persist unionId into the evidence pack',
    'Do **not** paste the raw `error_message`.',
    '**No** names, raw provider union/open/user IDs, DingTalk corp IDs, or business values in operator evidence.',
    'Record the overlap person’s key shape under A (values-free — length/equality booleans only).',
  ]
  for (const line of good) {
    const result = assertNoRawIdentityPasteInstructions(line)
    assert.equal(
      result.ok,
      true,
      result.ok ? 'ok' : `legitimate ban must stay legal (${line}):\n- ${result.violations.join('\n- ')}`,
    )
  }
})

// ---------------------------------------------------------------------------
// Actual runbook file — clauses (1)+(2)
// ---------------------------------------------------------------------------

test('T2-Gate runbook never projects raw provider identity / business values in fenced SQL', () => {
  const result = assertNoRawIdentityProjections(loadRunbook())
  assert.equal(
    result.ok,
    true,
    result.ok
      ? 'ok'
      : `runbook fenced SQL projects raw identity/PII:\n- ${result.violations.join('\n- ')}`,
  )
})

test('T2-Gate runbook never instructs operators to capture raw identity / PII into evidence', () => {
  const result = assertNoRawIdentityPasteInstructions(loadRunbook())
  assert.equal(
    result.ok,
    true,
    result.ok
      ? 'ok'
      : `runbook instructs raw identity/PII capture:\n- ${result.violations.join('\n- ')}`,
  )
})

test('T2-Gate runbook states all three values-free clauses (identity, business values, error text)', () => {
  const runbook = loadRunbook()
  assert.match(
    runbook,
    /no raw \*\*provider identity\*\*[^\n]*unionId[^\n]*corpId/i,
    'values-free definition must name the provider-identity clause',
  )
  assert.match(
    runbook,
    /no \*\*business values\*\*/i,
    'values-free definition must name the business-values clause',
  )
  assert.match(
    runbook,
    /no \*\*raw SQL error text\*\*/i,
    'values-free definition must name the raw-error-text clause',
  )
})

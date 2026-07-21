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
 * Extract fenced ```sql ... ``` bodies from markdown (case-insensitive fence tag).
 * @param {string} markdown
 * @returns {string[]}
 */
export function extractFencedSqlBlocks(markdown) {
  const blocks = []
  const re = /```sql\s*\n([\s\S]*?)```/gi
  let m
  while ((m = re.exec(markdown)) !== null) {
    blocks.push(m[1])
  }
  return blocks
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
  let fromIdx = 0
  while (fromIdx < sql.length) {
    const selectMatch = /\bSELECT\b/i.exec(sql.slice(fromIdx))
    if (!selectMatch) break
    const selectAbs = fromIdx + selectMatch.index
    if (isWordChar(sql[selectAbs - 1])) {
      fromIdx = selectAbs + selectMatch[0].length
      continue
    }
    const selectStart = selectAbs + selectMatch[0].length

    let depth = 0
    let i = selectStart
    let end = sql.length
    while (i < sql.length) {
      const ch = sql[i]
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
      if (depth === 0 && !isWordChar(sql[i - 1])) {
        const rest = sql.slice(i)
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
  const sqlBlocks = opts.bareSql
    ? [markdownOrSql]
    : extractFencedSqlBlocks(markdownOrSql)
  const violations = []

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
 * Extract every fenced code block (any/no language tag) — a bypass must not be possible by
 * relabelling ```sql as ```postgresql or a bare fence.
 * @param {string} markdown
 * @returns {string[]}
 */
export function extractFencedCodeBlocks(markdown) {
  const blocks = []
  const re = /```[A-Za-z0-9_+-]*[ \t]*\n([\s\S]*?)```/g
  let m
  while ((m = re.exec(markdown)) !== null) {
    blocks.push(m[1])
  }
  return blocks
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
 * Extract indented (4-space / tab) code blocks that read as SQL, OUTSIDE fenced blocks.
 *
 * Gate finding (audit follow-up): the projection guards only ever saw fenced blocks, so the same
 * identity SELECT indented by four spaces passed untouched. Markdown renders both identically —
 * the guard's visibility must not depend on which one an editor happens to use.
 * @param {string} markdown
 * @returns {string[]}
 */
export function extractIndentedSqlBlocks(markdown) {
  const withoutFences = markdown.replace(/```[A-Za-z0-9_+-]*[ \t]*\n[\s\S]*?```/g, '\n')
  const blocks = []
  let current = []
  for (const line of withoutFences.split('\n')) {
    if (/^(?: {4,}|\t)\S/.test(line)) {
      current.push(line.replace(/^(?: {4}|\t)/, ''))
      continue
    }
    if (line.trim() === '' && current.length > 0) {
      current.push('')
      continue
    }
    if (current.length > 0) {
      blocks.push(current.join('\n'))
      current = []
    }
  }
  if (current.length > 0) blocks.push(current.join('\n'))
  return blocks.filter((b) => /\bSELECT\b[\s\S]*\bFROM\b/i.test(b))
}

/**
 * Validate that no runbook SQL projection emits a raw provider-identity / PII column value.
 *
 * Covers rather than enumerates: besides the column-name list, a projection is rejected when it
 * is a wildcard or a whole-row serializer (both leak every column while naming none), and SQL is
 * required to live in a fenced block so it cannot hide from these checks by being indented.
 * @param {string} markdownOrSql
 * @param {{ bareSql?: boolean }} [opts]
 * @returns {{ ok: true } | { ok: false, violations: string[] }}
 */
export function assertNoRawIdentityProjections(markdownOrSql, opts = {}) {
  const violations = []
  let blocks
  if (opts.bareSql) {
    blocks = [markdownOrSql]
  } else {
    const indented = extractIndentedSqlBlocks(markdownOrSql)
    for (const block of indented) {
      violations.push(
        `runbook SQL must live in a fenced code block so the values-free guards can read it — ` +
          `found an indented SQL block: ${normalizeSqlWs(block).slice(0, 120)}`,
      )
    }
    blocks = [...extractFencedCodeBlocks(markdownOrSql), ...indented].filter((b) =>
      /\bSELECT\b/i.test(b),
    )
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

/** Shape a filled dependency must have before it can ground a verdict (junk is not evidence). */
const EVIDENCE_VALUE_SHAPES = new Map([
  ['staging sha', { re: /^[0-9a-f]{7,40}$/i, hint: 'a 7-40 character git SHA' }],
  ['corp a integration id', { re: UUID_SHAPE_RE, hint: 'a UUID' }],
  ['corp b integration id', { re: UUID_SHAPE_RE, hint: 'a UUID' }],
  ['corp a run status', { re: /\b(?:completed|failed)\b/i, hint: 'completed or failed' }],
  ['corp b run status', { re: /\b(?:completed|failed)\b/i, hint: 'completed or failed' }],
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

  const runA = read('corp a run status')
  const runB = read('corp b run status')
  if (!runA || !runB) {
    problems.push('§4 corp A / corp B run status is missing/blank, so the §3 row cannot be computed')
  }
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
    "corp-B run status='failed'": /\bfailed\b/.test(runB),
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
    'both runs completed': /\bcompleted\b/.test(runA) && /\bcompleted\b/.test(runB),
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
 * Extract the §4 evidence block body (first fenced block after the `## 4.` heading).
 * @param {string} markdown
 * @returns {string | null}
 */
export function extractEvidenceBlock(markdown) {
  const headingIdx = markdown.search(/^##\s*4\./m)
  if (headingIdx < 0) return null
  const m = /```[A-Za-z0-9_+-]*[ \t]*\n([\s\S]*?)```/.exec(markdown.slice(headingIdx))
  return m ? m[1] : null
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
    'key comparison': '_TBD_ (corp_a_rows / corp_b_rows / distinct_keys)',
    presence: '_TBD_ (present_in_a / present_in_b / keys_all_distinct)',
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

test('synthetic: paste-raw-identity instructions are rejected, negated bans are kept', () => {
  const bad = [
    'Paste the overlap person’s unionId and full name into the §4 evidence block.',
    'Record the corpId and mobile number in the evidence pack.',
    'Copy the openId of the overlap person into §4.',
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

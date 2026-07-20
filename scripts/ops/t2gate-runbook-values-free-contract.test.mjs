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
 * @param {string} sql
 * @returns {string[]}
 */
export function extractSelectLists(sql) {
  const lists = []
  let fromIdx = 0
  while (fromIdx < sql.length) {
    const selectMatch = /\bSELECT\b/i.exec(sql.slice(fromIdx))
    if (!selectMatch) break
    const selectStart = fromIdx + selectMatch.index + selectMatch[0].length

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
      if (depth === 0) {
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
 * Validate that no fenced-SQL projection emits a raw provider-identity / PII column value.
 * @param {string} markdownOrSql
 * @param {{ bareSql?: boolean }} [opts]
 * @returns {{ ok: true } | { ok: false, violations: string[] }}
 */
export function assertNoRawIdentityProjections(markdownOrSql, opts = {}) {
  const blocks = opts.bareSql
    ? [markdownOrSql]
    : extractFencedCodeBlocks(markdownOrSql).filter((b) => /\bSELECT\b/i.test(b))
  const violations = []

  for (const block of blocks) {
    for (const selectList of extractSelectLists(block)) {
      for (const proj of splitTopLevelProjections(selectList)) {
        if (!RAW_IDENTITY_SQL_COLUMN_RE.test(proj)) continue
        const reduced = reduceValuesFreeContexts(proj)
        const leaked = RAW_IDENTITY_SQL_COLUMN_RE.exec(reduced)
        if (leaked) {
          violations.push(
            `raw identity/PII column "${leaked[0]}" is projected (values-free requires ` +
              `length()/count()/boolean/equality output only): ${normalizeSqlWs(proj)}`,
          )
        }
      }
    }
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations }
}

/** Verbs that put something INTO the evidence pack. */
const EVIDENCE_CAPTURE_VERBS =
  /\b(?:pastes?|copy|copies|records?|writes?|enters?|attaches?|attach|includes?|include|exports?|dumps?|prints?|puts?|put|saves?|logs?)\b/i

/** Raw provider identity / business values as they read in prose. */
const RAW_IDENTITY_PROSE_TERMS =
  /\b(?:union[_\s-]?ids?|open[_\s-]?ids?|openid|corp[_\s-]?ids?|corpid|external[_\s-]?user[_\s-]?ids?|external[_\s-]?keys?|user[_\s-]?ids?|userid|(?:full|real|display|employee|legal|person)[_\s-]?names?|mobile(?:\s+numbers?)?|phone(?:\s+numbers?)?|e-?mail(?:\s+address(?:es)?)?|avatars?|id\s?cards?)\b/i

const PROSE_NEGATION =
  /\b(?:do\s+not|does\s+not|don'?t|never|must\s+not|may\s+not|cannot|can'?t|without|avoid|forbidden|prohibited|no|not)\b/i

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
export function assertNoRawIdentityPasteInstructions(markdown) {
  const violations = []
  for (const clause of splitProseClauses(stripFencedBlocks(markdown))) {
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

const EVIDENCE_PLACEHOLDER = /^_TBD_\b/
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

function isEvidencePlaceholder(value) {
  const v = value.trim()
  return v === '' || EVIDENCE_PLACEHOLDER.test(v)
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
  const byLabel = new Map(fields.map((f) => [f.label, f]))

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

  const confirmed = assertEvidenceVerdictIsGrounded(
    evidenceDoc({
      ...COMPLETED_EVIDENCE,
      'corp B run status': 'failed',
      'corp B duplicate_key_detected': 'true',
      'corp B expected_constraint_detected': 'true',
      'presence': 'present_in_a=1 / present_in_b=0 / keys_all_distinct=false',
      verdict: 'CONFIRMED',
    }),
  )
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

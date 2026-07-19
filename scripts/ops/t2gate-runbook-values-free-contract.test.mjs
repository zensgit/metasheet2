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
  assert.match(
    runbook,
    /_TBD_/,
    'evidence block must stay TBD until real two-corp staging (no fabricated verdict)',
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

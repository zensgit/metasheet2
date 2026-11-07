'use strict'

// Pull batch BI-6a (design-final §14 row BI-6a, owner item O-BI-9) — the static contract of the read-only,
// values-free site probe pack scripts/ops/stock-prep-pull-batch-site-probe-20261107/.
//
//   SP-01 execution contract: the shared preamble (ON_ERROR_STOP, read-only, timeouts), one REPEATABLE READ READ ONLY
//         snapshot, no write statement, no psql file / shell / exec meta-command, no persisted object; the file is
//         ASCII.
//   SP-02 what it reads: the closed relation list; every (table, column) of the required-columns block exists in the
//         migration that creates it (on main, and the pack refuses on a schema without them).
//   SP-03 pinned vocabularies: the plm_system column list = the installed R-line build's (onprem-r82), every one of
//         them still a plm_system column on main; the view logical ids, the 'add'
//         decision, the lock property, the active-column labels, `frozenLeftColumnIds` and `fieldOrder` are the
//         product's own; ids derive exactly as provisioning.ts stableMetaId; the JS trim() whitespace set.
//   SP-04 values-free: outside the private section, an output line only ever concatenates literal tokens, closed
//         columns and integers, never a function-call operand (a transformed value); handles are selected only inside
//         the section gated by `-v emit_private_map=1`.
//   SP-05 the plan-time cell is cast only when it is a strict ISO-8601 instant whose day exists.
//   SP-06 the host half (02-site-env.ps1) prints yes/no and counts only, and resolves keys the way
//         ecosystem.config.cjs reads app.env.
//   SP-07 the runbook and README pass the connection string to psql only through an environment variable (Windows
//         PowerShell 5.1 echoes the whole native command line into the `*>` log when psql writes to stderr).
//   SP-08 the birth-source split and the plugin-row count (R-65 C9 / C4): closed buckets over the shared raw
//         `manual:` predicate, the birth revision read with its 'create' filter.
// The pack's SQL is run on real PostgreSQL by BI-PROBE-RD-01 / -02 (core-backend tests/integration/
// stock-preparation-pull-batch-site-probe-realdb.cases.ts).
//
// VALUES-FREE: no fixture values here; the pack is read as text.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const REPO_ROOT = path.join(__dirname, '..', '..', '..')
const PACK_DIR = path.join(REPO_ROOT, 'scripts', 'ops', 'stock-prep-pull-batch-site-probe-20261107')

const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  STOCK_PREPARATION_DEFAULT_VIEW_LOGICAL_ID,
  STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID,
} = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const { STOCK_PREPARATION_TODO_VIEW_LOGICAL_ID } = require(path.join(LIB, 'stock-preparation-target-provisioning.cjs'))
const { DECISIONS } = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))
const {
  PROJECT_SHEET_PLM_SYSTEM_FIELD_IDS,
  HUMAN_WRITE_LOCK_PROPERTY_KEY,
  HUMAN_WRITE_LOCK_PLM_SYSTEM,
} = require(path.join(LIB, 'stock-preparation-project-targets.cjs'))
const { STOCK_PREPARATION_PROJECT_SHEET_OBJECT_ID_PATTERN } = require(path.join(LIB, 'stock-preparation-own-base.cjs'))

const tests = []
const test = (name, fn) => tests.push([name, fn])

// A CRLF checkout (autocrlf on Windows) must not turn the line-anchored checks red.
const readLf = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
const PREAMBLE = readLf(path.join(PACK_DIR, '_preamble.sql'))
const PACK = readLf(path.join(PACK_DIR, '01-site-probe.sql'))
const ENV_SCRIPT = readLf(path.join(PACK_DIR, '02-site-env.ps1'))
// Quote-aware: a `--` inside a string literal (the PRIVATE warning) is not a comment.
function stripSqlComments(sql) {
  let out = ''
  let inLiteral = false
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i]
    if (!inLiteral && char === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1
      if (i < sql.length) out += '\n'
      continue
    }
    if (char === "'") inLiteral = !inLiteral
    out += char
  }
  return out
}
const stripSqlLiterals = (sql) => sql.replace(/'(?:[^']|'')*'/g, "''")
const PACK_CODE = stripSqlComments(PACK)

function between(text, begin, end) {
  const start = text.indexOf(begin)
  const stop = text.indexOf(end, start + begin.length)
  assert.ok(start >= 0 && stop > start, `markers ${begin} .. ${end}`)
  return text.slice(start + begin.length, stop)
}

function cteBody(code, name, nextName) {
  return between(code, `\n${name} AS (\n`, `\n${nextName} AS (`)
}

// ── SP-01 ─────────────────────────────────────────────────────────────────────────────────────────────────────
test('SP-01 the pack includes the shared preamble (ON_ERROR_STOP, read-only, timeouts) and reads in one read-only snapshot', () => {
  assert.match(PACK, /^\\ir _preamble\.sql$/m)
  assert.match(PREAMBLE, /^\\set ON_ERROR_STOP on$/m)
  assert.match(PREAMBLE, /^SET default_transaction_read_only = on;$/m)
  assert.match(PREAMBLE, /^SET statement_timeout = '120s';$/m)
  assert.match(PREAMBLE, /^SET lock_timeout = '5s';$/m)
  assert.match(PREAMBLE, /^SET idle_in_transaction_session_timeout = '30s';$/m)
  const begins = PACK_CODE.match(/^BEGIN\b.*$/gm) || []
  assert.deepEqual(begins, ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;'])
  assert.match(PACK_CODE, /^COMMIT;\s*$/m)
  // Exactly one probe query inside the snapshot, and it is the last statement before COMMIT.
  const afterBegin = PACK_CODE.slice(PACK_CODE.indexOf('BEGIN ISOLATION LEVEL'))
  assert.equal((afterBegin.match(/;\s*$/gm) || []).length, 3, 'BEGIN; the probe; COMMIT')
})

test('SP-01 no write statement, no persisted object, no psql file / shell / exec meta-command; the SQL files are ASCII', () => {
  for (const code of [stripSqlLiterals(PACK_CODE), stripSqlLiterals(stripSqlComments(PREAMBLE))]) {
    for (const word of ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'CREATE', 'ALTER', 'DROP', 'GRANT', 'REVOKE', 'COPY', 'CALL', 'DO', 'VACUUM', 'REINDEX', 'CLUSTER', 'LOCK', 'NOTIFY', 'LISTEN', 'PREPARE', 'EXECUTE', 'DECLARE', 'TEMP', 'TEMPORARY', 'INTO']) {
      assert.equal(new RegExp(`\\b${word}\\b`, 'i').test(code), false, `no ${word}`)
    }
    assert.equal(/\\(?:copy|o|w|g\s|gexec|!|lo_|setenv|cd)/.test(code), false, 'no psql file/shell/exec meta-command')
    assert.equal(/\bset_config\s*\(|\bpg_(?:read|write|ls|sleep|terminate|cancel)/i.test(code), false, 'no server-side file / session-control function')
  }
  assert.equal(/[^\x00-\x7f]/.test(PACK), false, '01-site-probe.sql is ASCII (customer hosts save SQL as ASCII)')
  assert.equal(/[^\x00-\x7f]/.test(ENV_SCRIPT), false, '02-site-env.ps1 is ASCII (PowerShell 5.1)')
})

// ── SP-02 ─────────────────────────────────────────────────────────────────────────────────────────────────────
const RELATIONS = [
  'automation_rules', 'information_schema.columns', 'integration_external_systems', 'integration_pipelines',
  'integration_stock_prep_project_target', 'meta_fields', 'meta_record_revisions', 'meta_records', 'meta_records_trash', 'meta_sheets',
  'meta_view_personal_configs', 'meta_views', 'multitable_webhooks', 'pg_timezone_names',
]

test('SP-02 the pack reads only the closed relation list', () => {
  const ctes = new Set([...PACK_CODE.matchAll(/^(?:WITH (?:RECURSIVE\s*\n)?)?([a-z_]+)(?:\([a-z, ]+\))? AS \(\s*$/gm)].map((match) => match[1]))
  for (const expected of ['need', 'params', 'ws', 'logical', 'reg', 'tsheet', 'checked', 'sheet_facts', 'units', 'cells', 'copy_tree', 'lines']) assert.ok(ctes.has(expected), `CTE ${expected} recognised`)
  const relations = new Set()
  // `extract(x FROM …)` and `IS DISTINCT FROM` are not relation reads.
  const fromCode = PACK_CODE.replace(/\bextract\(\s*[a-z]+\s+FROM\b/gi, 'extract(').replace(/\bIS DISTINCT FROM\b/g, 'IS DISTINCT')
  for (const match of fromCode.matchAll(/\b(?:FROM|JOIN)\s+(?!LATERAL\b)([A-Za-z_][A-Za-z_.]*)/g)) {
    if (!ctes.has(match[1]) && !['unnest', 'jsonb_array_elements', 'jsonb_each'].includes(match[1])) relations.add(match[1])
  }
  assert.deepEqual([...relations].sort(), RELATIONS)
})

function migrationText(files) {
  return files.map((file) => readLf(path.join(REPO_ROOT, 'packages', 'core-backend', file))).join('\n')
}

// The migration(s) that create / extend each table (present on onprem-r74 .. onprem-r82 and main).
const TABLE_MIGRATIONS = {
  integration_stock_prep_project_target: ['migrations/087_create_integration_stock_prep_project_target.sql'],
  meta_sheets: ['src/db/migrations/zzz20251231_create_meta_schema.ts', 'src/db/migrations/zzzz20260404153000_repair_meta_core_schema.ts', 'src/db/migrations/zzzz20260927120500_add_meta_sheets_copy_provenance.ts'],
  meta_fields: ['src/db/migrations/zzz20251231_create_meta_schema.ts', 'src/db/migrations/zzzz20260404153000_repair_meta_core_schema.ts'],
  meta_views: ['src/db/migrations/zzz20251231_create_meta_schema.ts', 'src/db/migrations/zzzz20260321124000_add_meta_view_config.ts'],
  meta_view_personal_configs: ['src/db/migrations/zzzz20260705150000_create_meta_view_personal_configs.ts'],
  meta_records: ['src/db/migrations/zzz20251231_create_meta_schema.ts', 'src/db/migrations/zzzz20260404153000_repair_meta_core_schema.ts', 'src/db/migrations/zzzz20260406093000_add_meta_record_created_by.ts', 'src/db/migrations/zzzz20260612140000_add_meta_record_locked.ts'],
  meta_records_trash: ['src/db/migrations/zzzz20260617120000_create_meta_records_trash.ts'],
  meta_record_revisions: ['src/db/migrations/zzzz20260430172000_create_meta_record_revisions.ts'],
  automation_rules: ['src/db/migrations/zzzz20260413120000_create_automation_rules.ts', 'src/db/migrations/zzzz20260414100000_extend_automation_rules.ts'],
  multitable_webhooks: ['src/db/migrations/zzzz20260414100002_create_multitable_api_tokens_and_webhooks.ts', 'src/db/migrations/zzzz20261019100000_multitable_webhook_sheet_scope.ts'],
  integration_external_systems: ['migrations/057_create_integration_core_tables.sql'],
  integration_pipelines: ['migrations/057_create_integration_core_tables.sql'],
}

test('SP-02 every required (table, column) is declared by the migration that creates or extends the table; the refusal names identifiers only', () => {
  const block = between(PACK, 'probe-required-columns:begin', 'probe-required-columns:end')
  const pairs = [...block.matchAll(/\('([a-z_]+)', '([a-z_]+)'\)/g)].map((match) => [match[1], match[2]])
  assert.ok(pairs.length >= 30)
  const tables = new Set(pairs.map(([table]) => table))
  assert.deepEqual([...tables].sort(), Object.keys(TABLE_MIGRATIONS).sort())
  for (const [table, column] of pairs) {
    const text = migrationText(TABLE_MIGRATIONS[table])
    assert.ok(text.includes(table), `${table} is in its migration`)
    assert.match(text, new RegExp(`(?:\\b${column}\\b\\s+(?:TEXT|TIMESTAMPTZ|JSONB|text|jsonb|timestamptz|boolean|uuid|integer)|'${column}'|ADD COLUMN IF NOT EXISTS ${column}\\b)`, 'i'), `${table}.${column} is declared`)
  }
  // Every relation read (outside information_schema / pg_catalog) is in the required list, so a missing one refuses.
  for (const relation of RELATIONS.filter((name) => !name.includes('.') && !name.startsWith('pg_'))) assert.ok(tables.has(relation), `${relation} is probed`)
  assert.match(PACK_CODE, /reason=schema_missing missing=' \|\| :'probe_missing'/)
  assert.match(PACK_CODE, /string_agg\(n\.t \|\| '\.' \|\| n\.c, ','/)
})

// ── SP-03 ─────────────────────────────────────────────────────────────────────────────────────────────────────
// The template of the INSTALLED R-line build (onprem-r82, a7f23ec17: `git show onprem-r82:plugins/plugin-integration-core/
// lib/stock-preparation-templates.cjs`, fields with ownership 'plm_system', template order). The pack reads the site's
// installed sheets, so it follows this list, not main: a column main adds later (open Draft #6778) is not on the site
// until a new R-line package installs it. Main must still carry every one of these, in this order.
const R82_PLM_SYSTEM_FIELD_IDS = Object.freeze(['projectNo', 'idempotencyKey', 'componentSourceId', 'parentSourceId', 'parentComponentCode',
  'parentComponentName', 'path', 'depth', 'componentCode', 'componentName', 'componentSpec', 'material', 'sourceVersion', 'rawQuantity',
  'totalQuantity', 'active', 'lastPlmRefreshRunId', 'lastPlmRefreshAt', 'lastPlmRefreshDecision', 'lastPlmConflictSummary'])

function isOrderedSubset(subset, list) {
  let at = 0
  for (const id of list) if (at < subset.length && id === subset[at]) at += 1
  return at === subset.length
}

test('SP-03 the plm_system column list is the installed R-line build\'s (onprem-r82); main still carries every one of them, in order', () => {
  const block = between(PACK, 'probe-plm-system-field-ids:begin', 'probe-plm-system-field-ids:end')
  const ids = [...block.matchAll(/'([A-Za-z]+)'/g)].map((match) => match[1])
  assert.deepEqual(ids, R82_PLM_SYSTEM_FIELD_IDS.slice())
  const mainPlm = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.filter((field) => field.ownership === 'plm_system').map((field) => field.id)
  assert.ok(isOrderedSubset(ids, mainPlm), 'every R82 plm_system column is still a plm_system column on main, in the same order')
  assert.ok(isOrderedSubset(ids, PROJECT_SHEET_PLM_SYSTEM_FIELD_IDS.slice()), 'and in the project-sheet lock list')
  for (const id of ['projectNo', 'idempotencyKey', 'active', 'lastPlmRefreshAt', 'lastPlmRefreshDecision']) assert.ok(ids.includes(id))
})

test('SP-03 view ids, the add decision, the lock property, labels, frozen and personal-order keys are the product\'s own', () => {
  const views = [...between(PACK, 'probe-view-logical-ids:begin', 'probe-view-logical-ids:end').matchAll(/'([a-z-]+)'/g)].map((match) => match[1])
  assert.deepEqual(views, [STOCK_PREPARATION_DEFAULT_VIEW_LOGICAL_ID, STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID, STOCK_PREPARATION_TODO_VIEW_LOGICAL_ID])
  const provisioning = readLf(path.join(REPO_ROOT, 'packages', 'core-backend', 'src', 'multitable', 'provisioning.ts'))
  assert.match(provisioning, new RegExp(`DEFAULT_OBJECT_VIEW_LOGICAL_ID = '${STOCK_PREPARATION_DEFAULT_VIEW_LOGICAL_ID}'`))
  assert.match(provisioning, /return stableMetaId\('view', projectId, objectId, viewId\)/)
  assert.match(PACK_CODE, new RegExp(`'${DECISIONS.ADD}'::text AS add_decision`))
  assert.equal(HUMAN_WRITE_LOCK_PROPERTY_KEY, 'humanWriteLock')
  assert.equal(HUMAN_WRITE_LOCK_PLM_SYSTEM, 'plm_system')
  assert.equal((PACK_CODE.match(/property ->> 'humanWriteLock' = 'plm_system'/g) || []).length, 2)
  const active = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.find((field) => field.id === 'active')
  const zh = [...active.labelZh].map((char) => `chr(${char.codePointAt(0)})`).join(' || ')
  assert.match(PACK_CODE, new RegExp(`${zh.replace(/[()|]/g, '\\$&')} AS active_label_zh`))
  assert.match(PACK_CODE, new RegExp(`'${active.label}'::text AS active_label_en`))
  const frozen = readLf(path.join(REPO_ROOT, 'apps', 'web', 'src', 'multitable', 'utils', 'frozen-columns.ts'))
  assert.match(frozen, /config\?\.frozenLeftColumnIds/)
  assert.match(PACK_CODE, /v\.config -> 'frozenLeftColumnIds'/)
  const personal = readLf(path.join(REPO_ROOT, 'packages', 'core-backend', 'src', 'multitable', 'personal-view-config.ts'))
  assert.match(personal, /OVERLAY_KEYS = \[[^\]]*'fieldOrder'/)
  assert.match(PACK_CODE, /pc\.config -> 'fieldOrder'/)
  // object_shape=derived is the project-sheet objectId pattern.
  assert.equal(STOCK_PREPARATION_PROJECT_SHEET_OBJECT_ID_PATTERN.source, '^plm_stock_preparation_sandbox_p_[0-9a-f]{24}$')
  assert.match(PACK_CODE, /reg\.object_id ~ '\^plm_stock_preparation_sandbox_p_\[0-9a-f\]\{24\}\$' THEN 'derived' ELSE 'adopted'/)
  // The generic configured writer's target shape (adapters/metasheet-multitable-target-adapter.cjs normalizeObjects).
  const adapter = readLf(path.join(LIB, 'adapters', 'metasheet-multitable-target-adapter.cjs'))
  assert.match(adapter, /const MULTITABLE_WRITE_TARGET_KIND = 'metasheet:multitable'/)
  assert.match(adapter, /sheetId: requiredString\(objectConfig\.sheetId, `config\.objects\.\$\{objectId\}\.sheetId`\)/)
  assert.equal((PACK_CODE.match(/o\.v ->> 'sheetId' = c\.sheet_id/g) || []).length, 3)
})

test('SP-03 ids derive exactly as provisioning.ts stableMetaId; the JS trim() whitespace set element by element', () => {
  assert.match(PACK_CODE, /r\.tenant_id \|\| ':integration-core' AS staging_project/)
  for (const [prefix, tail] of [['sheet_', ''], ['fld_', " || ':' || l\\.id"], ['view_', " || ':' || l\\.id"]]) {
    assert.match(PACK_CODE, new RegExp(`'${prefix}' \\|\\| left\\(encode\\(digest\\(convert_to\\(t\\.staging_project \\|\\| ':' \\|\\| t\\.object_id${tail.replace(/\|/g, '\\|')}, 'UTF8'\\), 'sha1'\\), 'hex'\\), 24\\)`), prefix)
  }
  const provisioning = readLf(path.join(REPO_ROOT, 'packages', 'core-backend', 'src', 'multitable', 'provisioning.ts'))
  assert.match(provisioning, /createHash\('sha1'\)\s*\n\s*\.update\(parts\.join\(':'\)\)\s*\n\s*\.digest\('hex'\)\s*\n\s*\.slice\(0, 24\)/)
  const ws = [...cteBody(PACK_CODE, 'ws', 'logical').matchAll(/chr\((\d+)\)/g)].map((match) => Number(match[1]))
  const jsWhitespace = []
  for (let code = 0; code <= 0xffff; code += 1) if (String.fromCharCode(code).trim() === '') jsWhitespace.push(code)
  assert.deepEqual(ws, jsWhitespace)
  // The manual-row prefix is the ADR's `manual:v1:` (no LIKE wildcard inside it); the shared raw predicate is `manual:`.
  assert.match(PACK_CODE, /x\.row_key LIKE 'manual:v1:%'/)
  assert.match(PACK_CODE, /COALESCE\(x\.row_key LIKE 'manual:%', false\) AS is_manual_prefix/)
})

// ── SP-04 ─────────────────────────────────────────────────────────────────────────────────────────────────────
test('SP-04 values-free output: line expressions concatenate literal tokens, closed columns and integers only; handles only in the private section', () => {
  const privateStart = PACK.indexOf('-- probe-private:begin')
  const privateEnd = PACK.indexOf('-- probe-private:end')
  assert.ok(privateStart > 0 && privateEnd > privateStart)
  const privateSection = stripSqlComments(PACK.slice(privateStart, privateEnd))
  assert.match(privateSection, /WHERE p\.private = '1'/)
  const outsidePrivate = stripSqlComments(PACK.slice(0, privateStart) + PACK.slice(privateEnd))
  assert.equal(outsidePrivate.includes('PROBE_PRIVATE'), false, 'no private line outside the private section')
  // probe_private becomes 1 only inside the emit_private_map block, next to the PRIVATE warning.
  const setOne = [...PACK_CODE.matchAll(/^\\set probe_private (\d)$/gm)].map((match) => match[1])
  assert.deepEqual(setOne, ['0', '1'])
  const gate = between(PACK_CODE, '\\if :emit_private_map', '\\endif')
  assert.match(gate, /\\echo '-- PRIVATE: /)
  assert.match(gate, /\\set probe_private 1/)
  assert.equal((PACK_CODE.match(/\\echo/g) || []).length, 1, 'the only \\echo is the PRIVATE warning')
  // Every output-building CTE (outside the private section).
  const bodies = [
    cteBody(outsidePrivate, 'unit_lines', 'sheet_lines'),
    cteBody(outsidePrivate, 'sheet_lines', 'copy_tree'),
    cteBody(outsidePrivate, 'copy_lines', 'site'),
    outsidePrivate.slice(outsidePrivate.indexOf('\nlines AS ('), outsidePrivate.indexOf('SELECT line FROM lines')),
  ]
  const closed = new Set(['ordinal', 'status', 'object_shape', 'reason', 'facts', 'counts', 'root_kind', 'root_ordinal', 'depth', 'line',
    'plm_cols_locked', 'labels', 'view_count', 'first_view', 'views_at_first', 'plugin_views', 'views_with_frozen', 'personal_order_overrides',
    'automation_rules', 'automation_rules_enabled', 'automation_rules_elsewhere', 'webhooks_active', 'writer_systems', 'writer_pipelines',
    'writer_pipelines_active', 'sheet_rows_all_projects', 'row_count', 'active_row_count', 'machine_rows', 'person_rows', 'person_rows_with_key',
    'manual_rows', 'locked_rows', 'trashed_rows', 'created_span_days', 'created_days', 'created_at_gap_clusters', 'stamped_rows', 'add_stamp_rows',
    'add_stamp_iso_rows', 'add_stamp_clusters', 'add_stamps_after_create', 'null_creator_rows', 'null_creator_rows_by_birth_source_plugin',
    'null_creator_rows_by_birth_source_automation', 'null_creator_rows_by_birth_source_public_form', 'null_creator_rows_by_birth_source_other',
    'null_creator_rows_by_birth_source_none', 'null_creator_rows_not_plugin'])
  for (const body of bodies) {
    assert.ok(body.length > 0)
    for (const match of body.matchAll(/\|\|\s*(?:COALESCE\()?([a-z]+)\.([a-z_]+)/g)) {
      assert.ok(closed.has(match[2]), `line column ${match[1]}.${match[2]} is a closed one`)
    }
    assert.equal(/\|\|\s*:'/.test(body), false, 'no psql variable is concatenated into a line')
    assert.equal(/\|\|\s*(?!COALESCE\(|count\()[A-Za-z_][A-Za-z_0-9]*\s*\(/.test(body), false, 'no function-call operand (a transformed value) is concatenated into a line')
    for (const forbidden of ['project_no', 'object_id', 'tenant_id', 'staging_project', 'env_project', 'env_object', 'env_sheet', 'expected_tz', 'created_by', 'row_key', 'stamp', 'name', 'url']) {
      assert.equal(new RegExp(`\\|\\|\\s*(?:COALESCE\\()?(?:[a-z]+\\.)?${forbidden}\\b`).test(body), false, `a line never concatenates ${forbidden}`)
    }
  }
  // The registry status is the 087 CHECK vocabulary (a closed token), not free text.
  const m087 = readLf(path.join(REPO_ROOT, 'packages', 'core-backend', 'migrations', '087_create_integration_stock_prep_project_target.sql'))
  assert.match(m087, /CHECK \(status IN \('active', 'archived'\)\)/)
  // Time zone facts are yes / no / unknown against the expected zone, never the setting itself.
  const siteLine = between(outsidePrivate, "'PROBE_SITE", 'FROM site st')
  assert.equal(/current_setting/.test(siteLine), false)
  assert.match(cteBody(outsidePrivate, 'site', 'lines'), /current_setting\('TimeZone'\) = p\.expected_tz AS tz_same_name/)
})

// ── SP-05 ─────────────────────────────────────────────────────────────────────────────────────────────────────
test('SP-05 the plan-time cell is cast only behind the strict ISO shape AND an existing day; JS toISOString() matches the shape', () => {
  const shape = PACK_CODE.match(/x\.stamp ~ '([^']+)'/)[1]
  const re = new RegExp(shape)
  for (const sample of [new Date(0).toISOString(), new Date('2026-10-05T03:00:00.123Z').toISOString(), '2026-10-05T03:00:00+08:00', '2026-10-05T03:00:00.123456Z']) assert.ok(re.test(sample), sample)
  for (const sample of ['', '2026-10-05', '2026-13-01T00:00:00Z', '0000-01-01T00:00:00Z', '2026-10-05T24:00:00Z', '2026-10-05T03:00:60Z', '2026-10-05 03:00:00Z', '2026-10-05T03:00:00+16:00', ' 2026-10-05T03:00:00Z']) assert.equal(re.test(sample), false, sample)
  // The cast sits only inside CASE WHEN p.stamp_ok, and stamp_ok checks the day inside CASE WHEN s.stamp_shape.
  const casts = [...PACK_CODE.matchAll(/([^\n]*)::timestamptz/g)].map((match) => match[1])
  assert.deepEqual(casts, ['         CASE WHEN p.stamp_ok THEN p.stamp'])
  assert.match(PACK_CODE, /CASE WHEN s\.stamp_shape\s+THEN substr\(s\.stamp, 9, 2\)::int <= extract\(day FROM \(make_date\(substr\(s\.stamp, 1, 4\)::int, substr\(s\.stamp, 6, 2\)::int, 1\) \+ interval '1 month' - interval '1 day'\)\)\s+ELSE false END AS stamp_ok/)
  assert.match(PACK_CODE, /k\.plan_at > k\.created_at \+ interval '5 seconds'/)
  assert.match(PACK_CODE, /g\.gap > interval '30 minutes'/)
})

// ── SP-06 ─────────────────────────────────────────────────────────────────────────────────────────────────────
test('SP-06 the host half prints counts and yes/no only, and resolves app.env keys as ecosystem.config.cjs does', () => {
  const code = ENV_SCRIPT.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')
  const outputs = code.split('\n').filter((line) => /^'SITE_ENV/.test(line))
  assert.equal(outputs.length, 7)
  for (const line of outputs) {
    const args = (line.match(/' -f (.*)$/) || [null, ''])[1]
    for (const arg of args.split(/,\s*/).filter(Boolean)) {
      assert.match(arg, /^(?:\$f\.Count|\(YesNo .*\))$/, `output argument ${arg} is a count or a yes/no`)
    }
  }
  assert.equal(/Write-Host|Set-Content|Out-File|Add-Content|Remove-Item|New-Item|Invoke-WebRequest|Invoke-RestMethod|Start-Process/.test(code), false, 'reads only')
  assert.match(code, /\$f\.Effective -ceq 'true'/, 'the switch is the exact literal')
  const ecosystem = readLf(path.join(REPO_ROOT, 'ecosystem.config.cjs'))
  assert.match(ecosystem, /if \(!line \|\| line\.startsWith\('#'\)\) continue/)
  assert.match(ecosystem, /if \(!\(key in process\.env\)\) \{/)
  assert.match(code, /if \(\$count -eq 1\)/, 'first occurrence wins')
  assert.match(code, /if \(\$null -ne \$processLevel\) \{ \$effective = \$processLevel \}/, 'a process-level variable is not overridden')
  for (const key of ['MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED', 'MULTITABLE_STOCK_PREP_TABLE_LABEL_LOCALE', 'MULTITABLE_BUSINESS_TIMEZONE']) {
    const manifest = readLf(path.join(REPO_ROOT, 'scripts', 'ops', 'global-history-flag-manifest.mjs'))
    assert.ok(manifest.includes(`key: '${key}'`) || key === 'MULTITABLE_STOCK_PREP_TABLE_LABEL_LOCALE', `${key} is a registered flag`)
    assert.ok(code.includes(`'${key}'`))
  }
  // The locale rule is normalizeTemplateLabelLocale's.
  const templates = readLf(path.join(LIB, 'stock-preparation-templates.cjs'))
  assert.match(templates, /if \(raw === 'zh' \|\| raw === 'zh-cn' \|\| raw === 'zh-hans' \|\| raw === 'zh-hans-cn'\) return 'zh-CN'/)
  assert.match(code, /@\('zh', 'zh-cn', 'zh-hans', 'zh-hans-cn'\) -contains \$locale/)
})

// ── SP-07 ─────────────────────────────────────────────────────────────────────────────────────────────────────
const RUNBOOK = readLf(path.join(REPO_ROOT, 'docs', 'development', 'takeover-beiliao-20260821', 'runbook-stock-prep-pull-batch-site-probe-20261107.md'))
const README = readLf(path.join(PACK_DIR, 'README.md'))

function fencedLines(markdown, language) {
  const out = []
  for (const match of markdown.matchAll(new RegExp('^[ \\t]*```' + language + '\\n([\\s\\S]*?)^[ \\t]*```', 'gm'))) out.push(...match[1].split('\n').map((line) => line.trim()).filter(Boolean))
  return out
}

test('SP-07 every psql command line in the runbook and README takes the connection string from an environment variable, never as a literal', () => {
  // Windows PowerShell 5.1 turns any psql stderr line into a NativeCommandError record that repeats the whole command
  // line into the `*>` log, so a literal (or placeholder-for-a-literal) connection string there lands in probe.log.
  const blocks = [
    ['runbook powershell', fencedLines(RUNBOOK, 'powershell')], ['README powershell', fencedLines(README, 'powershell')],
    ['README bash', fencedLines(README, 'bash').filter((line) => !line.startsWith('DATABASE_URL=') && !line.includes('vitest'))],
  ]
  let psqlLines = 0
  for (const [label, lines] of blocks) {
    for (const line of lines.filter((text) => /(?:^|[&\s'])(?:psql\b|'<psql)/.test(text))) {
      psqlLines += 1
      assert.match(line, /(?:\$env:READONLY_DATABASE_URL|"\$READONLY_DATABASE_URL")/, `${label}: psql reads the connection string from the environment: ${line}`)
      assert.equal(/postgres(?:ql)?:\/\/|<[^>]*连接串[^>]*>|'<只读/.test(line), false, `${label}: no literal connection string on the psql command line: ${line}`)
    }
  }
  assert.ok(psqlLines >= 3, 'the runbook and README psql invocations were found')
  // The runbook sets the variable from a private file and removes it afterwards; the reason is written next to it.
  const runbookPs = fencedLines(RUNBOOK, 'powershell')
  assert.ok(runbookPs.includes("$env:READONLY_DATABASE_URL = (Get-Content -Raw -LiteralPath '<私有连接串文件>').Trim()"))
  assert.ok(runbookPs.includes('Remove-Item Env:\\READONLY_DATABASE_URL'))
  assert.ok(runbookPs.indexOf('Remove-Item Env:\\READONLY_DATABASE_URL') > runbookPs.findIndex((line) => line.includes('01-site-probe.sql')))
  assert.ok(RUNBOOK.includes('连接串只经环境变量传入；PowerShell 5.1 在 psql 往 stderr 写任何一行时会把整条命令行原文写进 `*>` 的日志。'))
})

// ── SP-08 ─────────────────────────────────────────────────────────────────────────────────────────────────────
test('SP-08 the birth-source split reads the create revision into closed buckets over creator-absent, non-manual: rows; the plugin-row test is C4\'s', () => {
  const cells = cteBody(PACK_CODE, 'cells', 'stamped')
  // Every revisions column the split reads is in the required-columns block, so an R line without it refuses.
  const required = between(PACK, 'probe-required-columns:begin', 'probe-required-columns:end')
  for (const column of ['sheet_id', 'record_id', 'version', 'action', 'source', 'created_at']) assert.ok(required.includes("('meta_record_revisions', '" + column + "')"), 'meta_record_revisions.' + column + ' is required')
  assert.ok(required.includes("('meta_records', 'id')"))
  assert.match(cells, /LEFT JOIN LATERAL \(SELECT r\.source FROM meta_record_revisions r\s+WHERE r\.sheet_id = m\.sheet_id AND r\.record_id = m\.id\s+AND r\.action = 'create'\s+ORDER BY r\.version, r\.created_at\s+LIMIT 1\) birth ON true/)
  const buckets = [...cells.matchAll(/WHEN birth\.source = '([a-z-]+)' THEN '([a-z-]+)'/g)].map((match) => [match[1], match[2]])
  assert.deepEqual(buckets, [['plugin', 'plugin'], ['automation', 'automation'], ['public-form', 'public-form']])
  assert.match(cells, /CASE WHEN birth\.source IS NULL THEN 'none'/)
  assert.match(cells, /ELSE 'other' END AS birth_source/)
  // The product's own revision sources: the plugin create, the automation create_record, the anonymous form create.
  const src = (...parts) => readLf(path.join(REPO_ROOT, 'packages', 'core-backend', 'src', ...parts))
  assert.match(src('multitable', 'records.ts'), /action: 'create',\s+source: 'plugin',/)
  assert.match(src('multitable', 'automation-executor.ts'), /action: 'create',\s+source: 'automation',/)
  assert.match(src('routes', 'univer-meta.ts'), /recordRecordRevision\(action:'create', source:'public-form'\)/)
  assert.match(cteBody(PACK_CODE, 'classified', 'gaps'), /NOT p\.has_creator AND NOT p\.is_manual_prefix AS is_null_creator_non_manual/)
  const counts = cteBody(PACK_CODE, 'row_counts', 'unit_lines')
  const split = [...counts.matchAll(/FILTER \(WHERE k\.is_null_creator_non_manual AND k\.birth_source = '([a-z-]+)'\) AS null_creator_rows_by_birth_source_([a-z_]+)/g)].map((match) => [match[1], match[2]])
  assert.deepEqual(split, [['plugin', 'plugin'], ['automation', 'automation'], ['public-form', 'public_form'], ['other', 'other'], ['none', 'none']])
  assert.match(counts, /FILTER \(WHERE k\.is_null_creator_non_manual\) AS null_creator_rows,/)
  // C4: evidence needs a JSON key (the apply writer's PLM key starts with '{') AND a RUN decision stamp.
  assert.match(counts, /FILTER \(WHERE k\.is_null_creator_non_manual\s+AND NOT COALESCE\(k\.row_key LIKE '\{%' AND k\.has_decision, false\)\) AS null_creator_rows_not_plugin/)
  assert.match(readLf(path.join(LIB, 'stock-preparation-apply-writer.cjs')), /a PLM key starts with `\{`/)
  assert.match(readLf(path.join(LIB, 'stock-preparation-manual-rows.cjs')), /MANUAL_ROW_KEY_PREFIX = 'manual:'/)
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-pull-batch-site-probe.test.cjs', tests)

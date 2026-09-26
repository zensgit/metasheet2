/**
 * Structural pins for zzzz20260920150000 — the one-shot backfill of `connection_id` on residual
 * LEGACY `data-source:sql-readonly` bindings (#5896 follow-up).
 *
 * A fake Kysely cannot prove which rows a DML migration touches, so this test pins the SHAPE of
 * the statement instead: every predicate the design requires must be present in `up()`, the
 * UPDATE must re-check the binding-side predicates on the row it writes and the ledger must be fed
 * by the UPDATE's RETURNING (F1), non-readonly kinds must not be named,
 * and `down()` must restore only ledger-recorded rows. Deleting any single predicate from the
 * migration source turns exactly the matching assertion red (the verification note records the
 * six mutations). The concurrency behaviour is proven with two real connections in
 * tests/integration/legacy-binding-connection-id-backfill-race.db.test.ts. The real-PostgreSQL
 * evidence (six planted rows, census classes, up / replay /
 * down round trip, no 23503) lives in
 * docs/development/legacy-binding-connection-id-backfill-verification-20260920.md.
 *
 * Predicates 7 (source active) and 8 (source type in the SQL read-only set) are pinned here too, and
 * the type set is RE-DERIVED from the two runtime modules it comes from (the host adapter registry
 * and the plugin's connection resolver), so a drift on either side reds this file.
 */
import { promises as fs } from 'fs'
import { createRequire } from 'module'
import * as path from 'path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn(async () => {}) }))

import { DEFAULT_ADAPTER_REGISTRY } from '../../src/data-adapters/DataSourceManager'
import * as migration from '../../src/db/migrations/zzzz20260920150000_backfill_sql_readonly_legacy_connection_id'

const MIGRATION_PATH = path.join(
  __dirname,
  '../../src/db/migrations/zzzz20260920150000_backfill_sql_readonly_legacy_connection_id.ts',
)
const CENSUS_PATH = path.join(
  __dirname,
  '../../../../scripts/ops/readonly-inventory-20260916/05-legacy-binding-census.sql',
)
const LEDGER_TABLE = 'integration_external_system_connection_backfills'

const require_ = createRequire(__filename)
// The plugin's SQL read-only resolver — required directly so the accepted-type half of predicate 8
// is a VALUE pin against the module the canonical path actually runs, not a by-convention copy.
const RESOLVER = require_('../../../../plugins/plugin-integration-core/lib/connection-resolver.cjs') as {
  DEFAULT_SQL_CONNECTION_TYPES: Set<string>
}

/** Runtime truth: loadable (registry keys, lowercased as registerAdapterType does) ∩ accepted (lowercased as the resolver does). */
function derivedSqlReadonlyConnectionTypes(): string[] {
  const loadable = new Set(Object.keys(DEFAULT_ADAPTER_REGISTRY).map((type) => type.toLowerCase()))
  const accepted = new Set(Array.from(RESOLVER.DEFAULT_SQL_CONNECTION_TYPES, (type) => String(type).toLowerCase()))
  return [...loadable].filter((type) => accepted.has(type)).sort()
}

/** The literal list the migration declares (`const SQL_READONLY_CONNECTION_TYPES = [...]`). */
function declaredTypes(content: string): string[] {
  const m = content.match(/const SQL_READONLY_CONNECTION_TYPES = \[([^\]]*)\]/)
  expect(m).not.toBeNull()
  return Array.from(m![1].matchAll(/'([^']*)'/g), (x) => x[1]).sort()
}

function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*--.*$/gm, '')
}

function section(content: string, fn: 'up' | 'down'): string {
  const start = content.indexOf(`export async function ${fn}(`)
  expect(start).toBeGreaterThanOrEqual(0)
  const next = content.indexOf('export async function ', start + 1)
  return content.slice(start, next < 0 ? undefined : next)
}

/** The single backfill statement: from `WITH hit AS` to the end of its `.execute(db)`. */
function backfillStatement(up: string): string {
  const start = up.indexOf('WITH hit AS')
  expect(start).toBeGreaterThanOrEqual(0)
  const end = up.indexOf('.execute(db)', start)
  expect(end).toBeGreaterThan(start)
  return up.slice(start, end)
}

/** The candidate CTE only: from `WITH hit AS` up to the UPDATE CTE. */
function hitCte(stmt: string): string {
  const end = stmt.indexOf('upd AS (')
  expect(end).toBeGreaterThan(0)
  return stmt.slice(0, end)
}

async function source(): Promise<string> {
  return stripComments(await fs.readFile(MIGRATION_PATH, 'utf-8'))
}

describe('zzzz20260920150000_backfill_sql_readonly_legacy_connection_id migration', () => {
  it('exports reversible up/down functions taking a single db argument', () => {
    expect(typeof migration.up).toBe('function')
    expect(typeof migration.down).toBe('function')
    expect(migration.up.length).toBe(1)
    expect(migration.down.length).toBe(1)
  })

  it('up(): predicate 1 — only data-source:sql-readonly rows (never write-gated or any other kind)', async () => {
    const up = section(await source(), 'up')
    const stmt = backfillStatement(up)
    expect(stmt).toMatch(/WHERE b\.kind = \$\{SQL_READONLY_KIND\}/)
    expect(stmt).not.toContain('sql-write-gated')
    expect(stmt).not.toMatch(/kind\s+IN\s*\(/i)
    expect(stmt).not.toMatch(/kind\s+LIKE/i)
  })

  it('up(): predicate 2 — only rows still in the legacy shape (connection_id IS NULL)', async () => {
    // scoped to the candidate CTE: the UPDATE repeats this predicate (F1), so a whole-statement
    // match would stay green if the CTE copy were deleted
    const stmt = hitCte(backfillStatement(section(await source(), 'up')))
    expect(stmt).toMatch(/AND b\.connection_id IS NULL/)
  })

  it('up(): predicate 3 — the legacy pointer must resolve to the joined source id', async () => {
    const stmt = backfillStatement(section(await source(), 'up'))
    expect(stmt).toMatch(/ON b\.config->>'dataSourceId' = ds\.id/)
  })

  it('up(): predicate 4 — the server-stamped owner must equal that source\'s owner (delete-guard predicate)', async () => {
    const stmt = backfillStatement(section(await source(), 'up'))
    expect(stmt).toMatch(/AND b\.config->>'dataSourceOwnerId' = ds\.owner_id/)
  })

  it('up(): predicate 5 — the source must be live (deleted_at IS NULL), or the NOT VALID live_id FK raises 23503', async () => {
    const stmt = backfillStatement(section(await source(), 'up'))
    expect(stmt).toMatch(/AND ds\.deleted_at IS NULL/)
  })

  it('up(): predicate 6 — the source must belong to the binding\'s tenant', async () => {
    const stmt = backfillStatement(section(await source(), 'up'))
    expect(stmt).toMatch(/AND ds\.tenant_id = b\.tenant_id/)
  })

  it('up(): predicate 7 — the source must be active (the host loads only is_active = true rows)', async () => {
    // scoped to the candidate CTE: that is where FOR SHARE OF ds re-checks it under the lock
    const stmt = hitCte(backfillStatement(section(await source(), 'up')))
    expect(stmt).toMatch(/AND ds\.is_active = TRUE/)
  })

  it('up(): predicate 8 — the source type must be loadable AND accepted by the SQL read-only resolver (lowercased like both)', async () => {
    const stmt = hitCte(backfillStatement(section(await source(), 'up')))
    expect(stmt).toMatch(/AND lower\(ds\.type\) IN \(\$\{sql\.join\(SQL_READONLY_CONNECTION_TYPES\)\}\)/)
  })

  it('predicate 8 — the declared type set equals DEFAULT_ADAPTER_REGISTRY keys ∩ DEFAULT_SQL_CONNECTION_TYPES (re-derived from the runtime modules)', async () => {
    const derived = derivedSqlReadonlyConnectionTypes()
    // sanity: the derivation itself is non-trivial (both halves contribute a type the other lacks)
    expect(Object.keys(DEFAULT_ADAPTER_REGISTRY).some((t) => !derived.includes(t.toLowerCase()))).toBe(true)
    expect(derived.length).toBeGreaterThan(0)
    expect(declaredTypes(await source())).toEqual(derived)
  })

  it('census 05: counts source-inactive / source-type-unsupported separately, with the SAME type list, right before backfillable', async () => {
    const census = await fs.readFile(CENSUS_PATH, 'utf-8')
    const list = `(${derivedSqlReadonlyConnectionTypes().map((t) => `'${t}'`).join(', ')})`
    // both hit CTEs (Q2 counts, Q3 ids) classify with the migration's list and lower() comparison
    const escaped = list.replace(/[()]/g, '\\$&')
    expect(census.match(new RegExp(`WHEN ds\\.is_active IS NOT TRUE\\s+THEN 'source-inactive'`, 'g'))?.length).toBe(2)
    expect(census.match(new RegExp(`WHEN \\(lower\\(ds\\.type\\) IN ${escaped}\\) IS NOT TRUE\\s+THEN 'source-type-unsupported'`, 'g'))?.length).toBe(2)
    // no other type list anywhere in the census (a second, diverging list would be a silent drift)
    expect(census.match(/lower\(ds\.type\) IN \(([^)]*)\)/g)?.every((m) => m.endsWith(list))).toBe(true)
    // ordered after every other class, so the counts mean "not backfilled BECAUSE of 7 / 8"
    for (const q of census.split('WITH hit AS').slice(1, 3)) {
      const order = ['tenant-mismatch', 'source-inactive', 'source-type-unsupported', 'backfillable'].map((c) => q.indexOf(`'${c}'`))
      expect(order.every((i) => i > 0)).toBe(true)
      expect([...order].sort((a, b) => a - b)).toEqual(order)
    }
    expect(census).toMatch(/count\(\*\) FILTER \(WHERE class = 'source-inactive'\)::int\s+AS source_inactive/)
    expect(census).toMatch(/count\(\*\) FILTER \(WHERE class = 'source-type-unsupported'\)::int\s+AS source_type_unsupported/)
    expect(census).toContain("THEN 'complete classes=10'")
  })

  it('up(): the cutover\'s rollback shape (marker TRUE + connection_id NULL) is left alone', async () => {
    const stmt = backfillStatement(section(await source(), 'up'))
    expect(hitCte(stmt)).toMatch(/AND b\.legacy_connection_fallback_eligible IS NOT TRUE/)
    // and the marker is never rewritten by this migration
    expect(stmt).not.toMatch(/legacy_connection_fallback_eligible\s*=/)
  })

  it('up(): writes the insert-path shape — connection_id from the join, pointer removed, owner stamp kept, updated_at not SET by the statement', async () => {
    const stmt = backfillStatement(section(await source(), 'up'))
    expect(stmt).toMatch(/SET connection_id = hit\.connection_id,\s*config = b\.config - 'dataSourceId'/)
    expect(stmt).not.toContain("- 'dataSourceOwnerId'")
    // the statement never sets it; the table's 057 BEFORE UPDATE trigger still stamps NOW() on the
    // rows it writes (migration header, NOT TOUCHED)
    expect(stmt).not.toMatch(/updated_at\s*=/)
  })

  it('up(): one statement — the UPDATE writes from the hit CTE and the ledger is fed ONLY by the UPDATE\'s RETURNING (recorded == changed)', async () => {
    const stmt = backfillStatement(section(await source(), 'up'))
    expect(stmt).toMatch(/^WITH hit AS \(/)
    expect(stmt).toMatch(/upd AS \(\s*UPDATE integration_external_systems AS b[\s\S]*FROM hit\s+WHERE b\.id = hit\.binding_id\s[\s\S]*RETURNING b\.id\s+AS binding_id/)
    expect(stmt).toMatch(/INSERT INTO \$\{sql\.raw\(LEDGER_TABLE\)\}/)
    // F1: the ledger rows come from the rows the UPDATE actually changed, never from the candidates
    expect(stmt).toMatch(/SELECT upd\.binding_id, upd\.tenant_id, upd\.connection_id,\s+upd\.legacy_data_source_id, upd\.legacy_data_source_owner_id, \$\{MIGRATION_NAME\}\s+FROM upd\s+ON CONFLICT/)
    expect(stmt).not.toMatch(/SELECT hit\./)
    // exactly one FROM/JOIN of the two tables — no second, differently-filtered scan
    expect(stmt.match(/FROM integration_external_systems AS b/g)?.length).toBe(1)
    expect(stmt.match(/JOIN data_sources AS ds/g)?.length).toBe(1)
  })

  it('up(): F1 — the UPDATE re-checks the binding-side predicates on the row it writes, and the source rows are locked', async () => {
    // Structural companion of tests/integration/legacy-binding-connection-id-backfill-race.db.test.ts,
    // which proves the behaviour with two real connections (the source-regex pins alone are not
    // evidence; they only make a silent deletion visible in the no-DB job).
    const stmt = backfillStatement(section(await source(), 'up'))
    const upd = stmt.slice(stmt.indexOf('upd AS ('), stmt.indexOf('RETURNING'))
    expect(upd).toMatch(/AND b\.kind = \$\{SQL_READONLY_KIND\}/)
    expect(upd).toMatch(/AND b\.connection_id IS NULL/)
    expect(upd).toMatch(/AND b\.legacy_connection_fallback_eligible IS NOT TRUE/)
    expect(upd).toMatch(/AND b\.tenant_id = hit\.tenant_id/)
    expect(upd).toMatch(/AND b\.config->>'dataSourceId' = hit\.legacy_data_source_id/)
    expect(upd).toMatch(/AND b\.config->>'dataSourceOwnerId' = hit\.legacy_data_source_owner_id/)
    const hit = stmt.slice(0, stmt.indexOf('upd AS ('))
    expect(hit).toMatch(/FOR SHARE OF ds\s*\)/)
    // source-side predicates (3-8) are re-checked ONLY under that lock: a data_sources read inside
    // the UPDATE would see the statement snapshot, not the committed new version (see migration)
    expect(upd).not.toMatch(/data_sources/)
  })

  it('up(): guarded by table/column existence (pre-cutover schema is a no-op, not an error)', async () => {
    const content = await source()
    expect(content).toMatch(/import \{ checkColumnExists, checkTableExists \} from '\.\/_patterns'/)
    const up = section(content, 'up')
    expect(up).toContain("checkTableExists(db, 'integration_external_systems')")
    expect(up).toContain("checkTableExists(db, 'data_sources')")
    expect(up).toContain("checkColumnExists(db, 'integration_external_systems', 'connection_id')")
    expect(up).toContain("checkColumnExists(db, 'integration_external_systems', 'legacy_connection_fallback_eligible')")
    expect(up).toContain("checkColumnExists(db, 'data_sources', 'tenant_id')")
    expect(up).toMatch(/CREATE TABLE IF NOT EXISTS \$\{sql\.raw\(LEDGER_TABLE\)\}/)
  })

  it('the ledger name and the migration tag are pinned constants', async () => {
    const content = await source()
    expect(content).toContain(`const LEDGER_TABLE = '${LEDGER_TABLE}'`)
    expect(content).toContain("const MIGRATION_NAME = 'zzzz20260920150000_backfill_sql_readonly_legacy_connection_id'")
    expect(content).toContain("const SQL_READONLY_KIND = 'data-source:sql-readonly'")
  })

  it('down(): restores ONLY ledger-recorded rows that still carry the recorded connection id and no pointer, then deletes those ledger rows', async () => {
    const down = section(await source(), 'down')
    expect(down).toContain(`checkTableExists(db, LEDGER_TABLE)`)
    expect(down).toMatch(/SET connection_id = NULL,\s*config = b\.config \|\| jsonb_build_object\('dataSourceId', l\.legacy_data_source_id\)/)
    expect(down).toMatch(/FROM \$\{sql\.raw\(LEDGER_TABLE\)\} AS l\s+WHERE b\.id = l\.binding_id/)
    expect(down).toMatch(/AND b\.kind = \$\{SQL_READONLY_KIND\}/)
    expect(down).toMatch(/AND b\.connection_id = l\.connection_id/)
    // mirrors up()'s re-checks: same tenant and same owner stamp as recorded (Sf4 / Sf5)
    expect(down).toMatch(/AND b\.tenant_id = l\.tenant_id/)
    expect(down).toMatch(/AND b\.config->>'dataSourceOwnerId' = l\.legacy_data_source_owner_id/)
    expect(down).toMatch(/AND NOT \(b\.config \? 'dataSourceId'\)/)
    expect(down).toMatch(/AND l\.migration_name = \$\{MIGRATION_NAME\}/)
    expect(down).toMatch(/DELETE FROM \$\{sql\.raw\(LEDGER_TABLE\)\} AS l\s+WHERE l\.binding_id IN \(SELECT binding_id FROM restored\)/)
    // never a blanket revert of every NULL-pointer canonical row
    expect(down).not.toMatch(/WHERE b\.connection_id IS NOT NULL/)
  })

  it('down(): drops the ledger only when it is empty (unrestored rows keep their evidence)', async () => {
    const down = section(await source(), 'down')
    expect(down).toMatch(/IF NOT EXISTS \(SELECT 1 FROM \$\{sql\.raw\(LEDGER_TABLE\)\}\) THEN\s+DROP TABLE \$\{sql\.raw\(LEDGER_TABLE\)\};/)
    expect(down).not.toMatch(/DROP TABLE IF EXISTS/)
  })
})

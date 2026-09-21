/**
 * Structural pins for zzzz20260920150000 — the one-shot backfill of `connection_id` on residual
 * LEGACY `data-source:sql-readonly` bindings (#5896 follow-up).
 *
 * A fake Kysely cannot prove which rows a DML migration touches, so this test pins the SHAPE of
 * the statement instead: every predicate the design requires must be present in `up()`, the
 * UPDATE and the ledger INSERT must share one `hit` CTE, non-readonly kinds must not be named,
 * and `down()` must restore only ledger-recorded rows. Deleting any single predicate from the
 * migration source turns exactly the matching assertion red (the verification note records the
 * six mutations). The real-PostgreSQL evidence (six planted rows, census classes, up / replay /
 * down round trip, no 23503) lives in
 * docs/development/legacy-binding-connection-id-backfill-verification-20260920.md.
 */
import { promises as fs } from 'fs'
import * as path from 'path'
import { describe, expect, it } from 'vitest'
import * as migration from '../../src/db/migrations/zzzz20260920150000_backfill_sql_readonly_legacy_connection_id'

const MIGRATION_PATH = path.join(
  __dirname,
  '../../src/db/migrations/zzzz20260920150000_backfill_sql_readonly_legacy_connection_id.ts',
)
const LEDGER_TABLE = 'integration_external_system_connection_backfills'

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
    const stmt = backfillStatement(section(await source(), 'up'))
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

  it('up(): the cutover\'s rollback shape (marker TRUE + connection_id NULL) is left alone', async () => {
    const stmt = backfillStatement(section(await source(), 'up'))
    expect(stmt).toMatch(/AND b\.legacy_connection_fallback_eligible IS NOT TRUE/)
    // and the marker is never rewritten by this migration
    expect(stmt).not.toMatch(/legacy_connection_fallback_eligible\s*=/)
  })

  it('up(): writes the insert-path shape — connection_id from the join, pointer removed, owner stamp kept, updated_at untouched', async () => {
    const stmt = backfillStatement(section(await source(), 'up'))
    expect(stmt).toMatch(/SET connection_id = hit\.connection_id,\s*config = b\.config - 'dataSourceId'/)
    expect(stmt).not.toContain("- 'dataSourceOwnerId'")
    expect(stmt).not.toMatch(/updated_at\s*=/)
  })

  it('up(): the UPDATE and the ledger INSERT share one hit CTE (counted == changed)', async () => {
    const stmt = backfillStatement(section(await source(), 'up'))
    expect(stmt).toMatch(/^WITH hit AS \(/)
    expect(stmt).toMatch(/upd AS \(\s*UPDATE integration_external_systems AS b[\s\S]*FROM hit\s+WHERE b\.id = hit\.binding_id\s+RETURNING b\.id AS binding_id/)
    expect(stmt).toMatch(/INSERT INTO \$\{sql\.raw\(LEDGER_TABLE\)\}/)
    expect(stmt).toMatch(/FROM hit\s+WHERE hit\.binding_id IN \(SELECT binding_id FROM upd\)/)
    // exactly one FROM/JOIN of the two tables — no second, differently-filtered scan
    expect(stmt.match(/FROM integration_external_systems AS b/g)?.length).toBe(1)
    expect(stmt.match(/JOIN data_sources AS ds/g)?.length).toBe(1)
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

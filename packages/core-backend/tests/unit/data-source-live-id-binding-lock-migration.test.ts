/**
 * W7-B PR-B (#5784 owner reservation ②, second cut; owner ruling 2026-09-20 ①: force retired).
 *
 * Structural pins for the two halves of this cut that cannot be exercised by a fake Kysely:
 *
 *   1. The migration zzzz20260920120000 — `data_sources.live_id` (STORED generated, NULL once
 *      soft-deleted), its UNIQUE index (an FK target needs one), the binding FK re-pointed at
 *      it with ON DELETE RESTRICT and NOT VALID (existing dangling rows must not block deploy;
 *      every new write is checked), the legacy FK dropped; and a down() that restores the
 *      id-targeted FK and removes index + column.
 *   2. The force retirement — neither the manager nor the route may grow a force bypass back:
 *      no `options?.force` guard around the count, no `req.query.force` read, no
 *      DATA_SOURCE_FORCE_DELETE_ADMIN_ONLY, no `forcedReferenceBreak` audit field.
 *
 * The real-PostgreSQL evidence (timings A/B, NOT VALID with a pre-seeded dangling row, down()
 * round trip, and the three mutations) lives in
 * docs/development/data-source-live-id-fk-binding-lock-verification-20260920.md.
 */
import { promises as fs } from 'fs'
import * as path from 'path'
import { describe, expect, it } from 'vitest'
import * as migration from '../../src/db/migrations/zzzz20260920120000_data_source_live_id_binding_lock'

const MIGRATION_PATH = path.join(
  __dirname,
  '../../src/db/migrations/zzzz20260920120000_data_source_live_id_binding_lock.ts',
)
const MANAGER_PATH = path.join(__dirname, '../../src/data-adapters/DataSourceManager.ts')
const ROUTE_PATH = path.join(__dirname, '../../src/routes/data-sources.ts')

const LIVE_FK = 'fk_integration_external_systems_live_connection_id'
const LEGACY_FK = 'fk_integration_external_systems_connection_id'

function section(content: string, fn: 'up' | 'down'): string {
  const start = content.indexOf(`export async function ${fn}(`)
  expect(start).toBeGreaterThanOrEqual(0)
  const next = content.indexOf('export async function ', start + 1)
  return content.slice(start, next < 0 ? undefined : next)
}

describe('zzzz20260920120000_data_source_live_id_binding_lock migration', () => {
  it('exports reversible up/down functions taking a single db argument', () => {
    expect(typeof migration.up).toBe('function')
    expect(typeof migration.down).toBe('function')
    expect(migration.up.length).toBe(1)
    expect(migration.down.length).toBe(1)
  })

  it('up(): live_id is a STORED generated column that is the id while live and NULL once soft-deleted', async () => {
    const up = section(await fs.readFile(MIGRATION_PATH, 'utf-8'), 'up')
    expect(up).toMatch(/ADD COLUMN IF NOT EXISTS live_id TEXT\s+GENERATED ALWAYS AS \(CASE WHEN deleted_at IS NULL THEN id END\) STORED/)
  })

  it('up(): a UNIQUE index on live_id (the FK target), created idempotently', async () => {
    const up = section(await fs.readFile(MIGRATION_PATH, 'utf-8'), 'up')
    expect(up).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_data_sources_live_id\s+ON data_sources \(live_id\)/)
  })

  it('up(): the binding FK is re-pointed at data_sources(live_id), RESTRICT, NOT VALID, guarded by pg_constraint; the legacy FK is dropped', async () => {
    const up = section(await fs.readFile(MIGRATION_PATH, 'utf-8'), 'up')
    expect(up).toMatch(/FOREIGN KEY \(connection_id\) REFERENCES data_sources\(live_id\)\s+ON DELETE RESTRICT\s+NOT VALID/)
    expect(up).not.toMatch(/REFERENCES data_sources\(id\)/)
    expect(up).toContain('FROM pg_constraint')
    expect(up).toContain(`conname = \${sql.lit(LIVE_FK)}`)
    expect(up).toContain('DROP CONSTRAINT IF EXISTS ${sql.raw(LEGACY_FK)}')
    // ON UPDATE CASCADE / SET NULL would let a soft delete silently rewrite binding rows —
    // the option the design explicitly rejects.
    expect(up).not.toMatch(/ON UPDATE (CASCADE|SET NULL)/)
  })

  it('the constraint names are the ones the manager and the plugin key their 23503 mapping on', async () => {
    const content = await fs.readFile(MIGRATION_PATH, 'utf-8')
    expect(content).toContain(`const LIVE_FK = '${LIVE_FK}'`)
    expect(content).toContain(`const LEGACY_FK = '${LEGACY_FK}'`)
    const manager = await fs.readFile(MANAGER_PATH, 'utf-8')
    expect(manager).toContain(`DATA_SOURCE_LIVE_CONNECTION_FK = '${LIVE_FK}'`)
  })

  it('down(): drops the live FK, restores connection_id -> data_sources(id) (NOT VALID, guarded), then drops index and column', async () => {
    const down = section(await fs.readFile(MIGRATION_PATH, 'utf-8'), 'down')
    expect(down).toContain('DROP CONSTRAINT IF EXISTS ${sql.raw(LIVE_FK)}')
    expect(down).toMatch(/FOREIGN KEY \(connection_id\) REFERENCES data_sources\(id\)\s+ON DELETE RESTRICT\s+NOT VALID/)
    expect(down).toContain(`conname = \${sql.lit(LEGACY_FK)}`)
    expect(down).toContain('DROP INDEX IF EXISTS uq_data_sources_live_id')
    expect(down).toContain('ALTER TABLE data_sources DROP COLUMN IF EXISTS live_id')
    // order: the FK that references the column goes before the column
    expect(down.indexOf('DROP CONSTRAINT IF EXISTS ${sql.raw(LIVE_FK)}')).toBeLessThan(down.indexOf('DROP COLUMN IF EXISTS live_id'))
  })
})

describe('force is retired (owner ruling 2026-09-20 ①) — source-level tripwire', () => {
  it('DataSourceManager.removeDataSource has no force option and no force guard around the count', async () => {
    const manager = await fs.readFile(MANAGER_PATH, 'utf-8')
    expect(manager).not.toMatch(/options\?\.force/)
    expect(manager).not.toMatch(/force\?: boolean/)
    expect(manager).not.toContain('DATA_SOURCE_FORCE_DELETE_ADMIN_ONLY')
    // the count is unconditional inside the transaction and on the memory-only path
    expect(manager).toMatch(/const referenceCount = await this\.countExternalSystemReferences\(id, trx\)\s*\n\s*if \(referenceCount > 0\) throw referencedRefusal\(referenceCount\)/)
  })

  it('DataSourceManager maps the live-connection FK refusal (23503) to the referential 409 by SQLSTATE, never by prose', async () => {
    const manager = await fs.readFile(MANAGER_PATH, 'utf-8')
    expect(manager).toContain("if (code !== '23503') return false")
    expect(manager).toMatch(/if \(isLiveConnectionFkViolation\(err\)\) \{\s*\n\s*throw referencedRefusal\(null\)/)
    expect(manager).not.toMatch(/violates foreign key/i)
  })

  it('the DELETE route reads no force flag, emits no 403 force code and audits no forcedReferenceBreak', async () => {
    const route = await fs.readFile(ROUTE_PATH, 'utf-8')
    expect(route).not.toMatch(/req\.query\.force/)
    expect(route).not.toContain('DATA_SOURCE_FORCE_DELETE_ADMIN_ONLY')
    expect(route).not.toContain('forcedReferenceBreak')
    expect(route).toContain('await manager.removeDataSource(id)')
    expect(route).toContain('请先解绑 ${referenceCount} 个外部系统')
  })
})

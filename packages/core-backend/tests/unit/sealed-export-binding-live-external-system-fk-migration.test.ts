/**
 * #6076 residual R-073, owner ruling "option 1" — structural pins for migration
 * zzzz20260926140000_sealed_export_binding_live_external_system_fk.
 *
 * What a fake Kysely cannot exercise is pinned here as source shape:
 *   1. `live_external_system_id` is a STORED generated column that carries `external_system_id` only
 *      while `status = 'ACTIVE'` — the same liveness rule the delete guard counts by.
 *   2. The FK on it references `integration_external_systems(id)`, ON DELETE RESTRICT, NOT VALID,
 *      guarded by pg_constraint, and is never VALIDATEd by the migration (existing dangling rows
 *      must not block deploy; VALIDATE is the owner-run pack's step 03).
 *   3. down() drops constraint then column and never touches a binding row.
 *   4. The frozen S6-A writer is not modified by this cut (its file is not referenced for editing
 *      here; its pin is verified by the S6-A provenance suites) — the constraint name fits in
 *      PostgreSQL's 63-byte identifier limit so what the migration names is what the catalog holds.
 *
 * The behavioural evidence (old schema dangles / new schema refuses, RETIRED rows do not block,
 * down() with data, NOT VALID over a pre-existing dangling row, the frozen module as the
 * provisioning role in both interleavings, and the two mutations) is the real-PostgreSQL suite
 * tests/integration/sealed-export-binding-live-external-system-fk.db.test.ts.
 */
import { promises as fs } from 'fs'
import * as path from 'path'
import { describe, expect, it } from 'vitest'
import * as migration from '../../src/db/migrations/zzzz20260926140000_sealed_export_binding_live_external_system_fk'

const MIGRATION_PATH = path.join(
  __dirname,
  '../../src/db/migrations/zzzz20260926140000_sealed_export_binding_live_external_system_fk.ts',
)
const EXTERNAL_SYSTEMS_PATH = path.join(
  __dirname,
  '../../../../plugins/plugin-integration-core/lib/external-systems.cjs',
)
const MIGRATION_073_PATH = path.join(
  __dirname,
  '../../migrations/073_create_sealed_export_stock_prep_runtime_authority.sql',
)

const LIVE_FK = 'fk_sealed_export_stock_prep_binding_live_external_system'

async function source(): Promise<string> {
  return (await fs.readFile(MIGRATION_PATH, 'utf-8')).replace(/\r\n/g, '\n')
}

function section(content: string, fn: 'up' | 'down'): string {
  const start = content.indexOf(`export async function ${fn}(`)
  expect(start).toBeGreaterThanOrEqual(0)
  const next = content.indexOf('export async function ', start + 1)
  return content.slice(start, next < 0 ? undefined : next)
}

describe('zzzz20260926140000_sealed_export_binding_live_external_system_fk migration', () => {
  it('exports reversible up/down functions taking a single db argument', () => {
    expect(typeof migration.up).toBe('function')
    expect(typeof migration.down).toBe('function')
    expect(migration.up.length).toBe(1)
    expect(migration.down.length).toBe(1)
  })

  it('up(): live_external_system_id is STORED generated, external_system_id only while ACTIVE', async () => {
    const up = section(await source(), 'up')
    expect(up).toMatch(
      /ADD COLUMN IF NOT EXISTS live_external_system_id TEXT\s+GENERATED ALWAYS AS \(CASE WHEN status = 'ACTIVE' THEN external_system_id END\) STORED/,
    )
    // A pre-existing column of that name that is NOT generated is refused, not constrained.
    expect(up).toContain("attgenerated = 's'")
    expect(up).toContain("USING ERRCODE = '55000'")
  })

  it("the generated column's liveness literal is the one the delete guard counts by, and 073's status vocabulary still contains it", async () => {
    const guard = await fs.readFile(EXTERNAL_SYSTEMS_PATH, 'utf-8')
    expect(guard).toContain("const LIVE_SEALED_EXPORT_BINDING_STATUS = 'ACTIVE'")
    const m073 = await fs.readFile(MIGRATION_073_PATH, 'utf-8')
    expect(m073).toMatch(/status\s+TEXT NOT NULL CHECK \(status IN \('ACTIVE', 'RETIRED'\)\)/)
  })

  it('up(): FK -> integration_external_systems(id), RESTRICT, NOT VALID, pg_constraint-guarded, never validated here', async () => {
    const content = await source()
    const up = section(content, 'up')
    expect(content).toContain(`const LIVE_EXTERNAL_SYSTEM_FK = '${LIVE_FK}'`)
    expect(up).toMatch(
      /FOREIGN KEY \(live_external_system_id\)\s+REFERENCES integration_external_systems\(id\)\s+ON DELETE RESTRICT\s+NOT VALID;/,
    )
    expect(up).toContain('FROM pg_constraint')
    expect(up).toContain('conname = ${sql.lit(LIVE_EXTERNAL_SYSTEM_FK)}')
    expect(up).toContain("conrelid = 'integration_sealed_export_stock_prep_bindings'::regclass")
    expect(up).not.toMatch(/VALIDATE CONSTRAINT/)
    // CASCADE / SET NULL would let a system delete rewrite or erase binding rows.
    expect(up).not.toMatch(/ON (DELETE|UPDATE) (CASCADE|SET NULL|SET DEFAULT)/)
    // The migration adds nothing on the referenced table and grants nothing to anyone.
    expect(up).not.toMatch(/ALTER TABLE integration_external_systems/)
    expect(content).not.toMatch(/\bGRANT\b/)
  })

  it('up(): column first, FK only when integration_external_systems exists', async () => {
    const up = section(await source(), 'up')
    const column = up.indexOf('ADD COLUMN IF NOT EXISTS live_external_system_id')
    const esCheck = up.indexOf('checkTableExists(db, EXTERNAL_SYSTEMS_TABLE)')
    const fk = up.indexOf('ADD CONSTRAINT ${sql.raw(LIVE_EXTERNAL_SYSTEM_FK)}')
    expect(column).toBeGreaterThan(0)
    expect(esCheck).toBeGreaterThan(column)
    expect(fk).toBeGreaterThan(esCheck)
  })

  it('down(): drops the FK, then the column, and never reads or writes a binding row', async () => {
    const down = section(await source(), 'down')
    const dropFk = down.indexOf('DROP CONSTRAINT IF EXISTS ${sql.raw(LIVE_EXTERNAL_SYSTEM_FK)}')
    const dropColumn = down.indexOf('DROP COLUMN IF EXISTS live_external_system_id')
    expect(dropFk).toBeGreaterThan(0)
    expect(dropColumn).toBeGreaterThan(dropFk)
    expect(down).not.toMatch(/\b(UPDATE|DELETE FROM|INSERT INTO|TRUNCATE)\b/)
  })

  it('the constraint name fits the 63-byte identifier limit (no silent truncation)', () => {
    expect(Buffer.byteLength(LIVE_FK, 'utf8')).toBeLessThanOrEqual(63)
  })
})

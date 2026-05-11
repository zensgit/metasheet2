import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const migrationPath = path.resolve(
  __dirname,
  '../../migrations/008_plugin_infrastructure.sql'
)

function readMigration(): string {
  return readFileSync(migrationPath, 'utf8')
}

describe('008_plugin_infrastructure.sql compatibility guards', () => {
  it('repairs legacy plugin_configs tables before scoped indexes reference scope', () => {
    const sql = readMigration()

    const createTable = sql.indexOf('CREATE TABLE IF NOT EXISTS plugin_configs')
    const compatibilityGuard = sql.indexOf('ALTER TABLE plugin_configs ADD COLUMN IF NOT EXISTS scope')
    const firstScopedIndex = sql.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_configs_global')

    expect(createTable).toBeGreaterThanOrEqual(0)
    expect(compatibilityGuard).toBeGreaterThan(createTable)
    expect(firstScopedIndex).toBeGreaterThan(compatibilityGuard)
    expect(sql).toContain('ALTER TABLE plugin_configs ADD COLUMN IF NOT EXISTS config_key')
    expect(sql).toContain('ALTER TABLE plugin_configs ADD COLUMN IF NOT EXISTS value TEXT')
    expect(sql).toContain('ALTER TABLE plugin_configs ADD COLUMN IF NOT EXISTS encrypted')
    expect(sql).toContain('ALTER TABLE plugin_configs ADD COLUMN IF NOT EXISTS updated_at')
  })

  it('ships the expression unique index required by PluginConfigManager upserts', () => {
    const sql = readMigration()

    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_configs_scoped_identity')
    expect(sql).toContain("COALESCE(user_id, '')")
    expect(sql).toContain("COALESCE(tenant_id, '')")
  })

  it('normalizes jsonb plugin registry arrays before plugin views call array_length', () => {
    const sql = readMigration()

    const helper = sql.indexOf('__metasheet_plugin_jsonb_to_text_array')
    const statisticsView = sql.indexOf('CREATE OR REPLACE VIEW plugin_statistics')

    expect(helper).toBeGreaterThanOrEqual(0)
    expect(statisticsView).toBeGreaterThan(helper)
    expect(sql).toContain('ALTER COLUMN capabilities TYPE TEXT[]')
    expect(sql).toContain('ALTER COLUMN permissions TYPE TEXT[]')
    expect(sql).toContain('DROP INDEX IF EXISTS idx_plugin_registry_capabilities')
    expect(sql).toContain('DROP FUNCTION IF EXISTS __metasheet_plugin_jsonb_to_text_array')
  })

  it('repairs other legacy plugin tables before indexes and triggers reference new columns', () => {
    const sql = readMigration()

    expect(sql).toContain('ALTER TABLE plugin_security_audit ADD COLUMN IF NOT EXISTS operation')
    expect(sql).toContain('ALTER TABLE plugin_security_audit ADD COLUMN IF NOT EXISTS result')
    expect(sql.indexOf('ALTER TABLE plugin_security_audit ADD COLUMN IF NOT EXISTS operation')).toBeLessThan(
      sql.indexOf('CREATE INDEX IF NOT EXISTS idx_plugin_security_audit_operation')
    )
    expect(sql).toContain('ALTER TABLE plugin_cache ADD COLUMN IF NOT EXISTS updated_at')
    expect(sql.indexOf('ALTER TABLE plugin_cache ADD COLUMN IF NOT EXISTS updated_at')).toBeLessThan(
      sql.indexOf('CREATE TRIGGER update_plugin_cache_updated_at')
    )
  })
})

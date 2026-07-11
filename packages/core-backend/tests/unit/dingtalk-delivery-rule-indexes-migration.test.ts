import * as path from 'path'
import { promises as fs } from 'fs'
import { describe, expect, it } from 'vitest'
import * as migration from '../../src/db/migrations/zzzz20260708090000_add_delivery_rule_indexes'

const MIGRATION_PATH = path.join(
  __dirname,
  '../../src/db/migrations/zzzz20260708090000_add_delivery_rule_indexes.ts',
)

describe('zzzz20260708090000_add_delivery_rule_indexes migration', () => {
  it('exports reversible up/down functions taking a single db argument', () => {
    expect(typeof migration.up).toBe('function')
    expect(typeof migration.down).toBe('function')
    expect(migration.up.length).toBe(1)
    expect(migration.down.length).toBe(1)
  })

  it('up() creates a composite (automation_rule_id, created_at DESC) index on each delivery table', async () => {
    const content = await fs.readFile(MIGRATION_PATH, 'utf-8')

    expect(content).toContain('idx_dingtalk_group_deliveries_rule_created_at')
    expect(content).toContain('ON dingtalk_group_deliveries(automation_rule_id, created_at DESC)')
    expect(content).toContain('idx_dingtalk_person_deliveries_rule_created_at')
    expect(content).toContain('ON dingtalk_person_deliveries(automation_rule_id, created_at DESC)')
    expect(content).toContain('CREATE INDEX IF NOT EXISTS')
  })

  it('down() drops both indexes with IF EXISTS', async () => {
    const content = await fs.readFile(MIGRATION_PATH, 'utf-8')

    expect(content).toContain('DROP INDEX IF EXISTS idx_dingtalk_group_deliveries_rule_created_at')
    expect(content).toContain('DROP INDEX IF EXISTS idx_dingtalk_person_deliveries_rule_created_at')
  })
})

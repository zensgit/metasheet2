import { promises as fs } from 'fs'
import * as path from 'path'
import { describe, expect, it } from 'vitest'

const MIGRATIONS_DIR = path.join(__dirname, '../../src/db/migrations')
const BOOTSTRAP_PATH = path.join(__dirname, '../helpers/approval-schema-bootstrap.ts')
const JUMP_MIGRATION = path.join(MIGRATIONS_DIR, 'zzzz20260515130000_add_jump_action_to_approval_records.ts')
const HISTORICAL_ACTION_MIGRATIONS = [
  'zzzz20260411123000_add_created_action_to_approval_records.ts',
  'zzzz20260411120100_approval_templates_and_instance_extensions.ts',
  'zzzz20260423120000_add_remind_action_to_approval_records.ts',
]

describe('approval admin jump migration and bootstrap sync', () => {
  it('T11 exposes reversible up/down functions for the jump migration', async () => {
    const migration = await import('../../src/db/migrations/zzzz20260515130000_add_jump_action_to_approval_records')

    expect(typeof migration.up).toBe('function')
    expect(typeof migration.down).toBe('function')
    expect(migration.up.length).toBe(1)
    expect(migration.down.length).toBe(1)
  })

  it('T11 adds jump in up() and restores the non-jump constraint with NOT VALID in down()', async () => {
    const source = await fs.readFile(JUMP_MIGRATION, 'utf8')
    const [upSource, downSource] = source.split('export async function down')

    expect(upSource).toContain("'jump'")
    expect(upSource).toContain('approval_records_action_check')
    expect(upSource).toContain('ACTIONS_WITH_JUMP')
    expect(downSource).toContain('ACTIONS_WITHOUT_JUMP')
    expect(downSource).toContain('NOT VALID')
  })

  it('PD2 removes role_permissions before permissions in down() for FK safety', async () => {
    const source = await fs.readFile(JUMP_MIGRATION, 'utf8')
    const downSource = source.split('export async function down')[1] ?? ''
    const roleDeleteIndex = downSource.indexOf('DELETE FROM role_permissions')
    const permissionDeleteIndex = downSource.indexOf('DELETE FROM permissions')

    expect(source).toContain('approvals:admin')
    expect(roleDeleteIndex).toBeGreaterThanOrEqual(0)
    expect(permissionDeleteIndex).toBeGreaterThanOrEqual(0)
    expect(roleDeleteIndex).toBeLessThan(permissionDeleteIndex)
  })

  it('T-bootstrap keeps approval_schema_bootstrap action check aligned with jump', async () => {
    const source = await fs.readFile(BOOTSTRAP_PATH, 'utf8')

    expect(source).toContain("APPROVAL_SCHEMA_BOOTSTRAP_VERSION = '20260515-pr3-admin-jump-action'")
    expect(source).toContain("'remind', 'jump'")
  })

  it('does not mutate immutable historical approval action migrations', async () => {
    const sources = await Promise.all(
      HISTORICAL_ACTION_MIGRATIONS.map(async (fileName) => ({
        fileName,
        source: await fs.readFile(path.join(MIGRATIONS_DIR, fileName), 'utf8'),
      })),
    )

    for (const { fileName, source } of sources) {
      expect(source, fileName).not.toContain("'jump'")
      expect(source, fileName).not.toContain('approvals:admin')
    }
  })
})

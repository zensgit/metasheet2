import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const migrationPath = path.resolve(
  __dirname,
  '../../src/db/migrations/zzzz20260516113000_repair_onprem_multitable_record_create.ts',
)

describe('on-prem multitable record-create repair migration', () => {
  it('repairs record-create schema dependencies idempotently', async () => {
    const source = await readFile(migrationPath, 'utf8')

    expect(source).toContain('ADD COLUMN IF NOT EXISTS created_by')
    expect(source).toContain('ADD COLUMN IF NOT EXISTS modified_by')
    expect(source).toContain('CREATE TABLE IF NOT EXISTS meta_record_revisions')
    expect(source).toContain('CREATE INDEX IF NOT EXISTS idx_meta_record_revisions_sheet_record_version')
  })

  it('backfills required validation for existing integration staging fields', async () => {
    const source = await readFile(migrationPath, 'utf8')

    expect(source).toContain('plugin_multitable_object_registry')
    expect(source).toContain("to_regclass('public.plugin_multitable_object_registry')")
    expect(source).toContain("r.plugin_name = 'plugin-integration-core'")
    expect(source).toContain("r.object_id = 'standard_materials'")
    expect(source).toContain("'Material Code', 'Material Name', 'Status'")
    expect(source).toContain("r.object_id = 'bom_cleanse'")
    expect(source).toContain("'Parent Code', 'Child Code', 'Quantity', 'Status'")
    expect(source).toContain('__metasheet_add_required_field_validation')
    expect(source).toContain("rule->>'type' = 'required'")
  })
})

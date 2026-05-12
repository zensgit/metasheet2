import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const migrationPath = path.resolve(
  __dirname,
  '../../migrations/037_add_gallery_form_support.sql'
)

function readMigration(): string {
  return readFileSync(migrationPath, 'utf8')
}

function expectGuardBefore(sql: string, guardNeedle: string, guardedNeedle: string): void {
  const guardedIndex = sql.indexOf(guardedNeedle)
  expect(guardedIndex).toBeGreaterThanOrEqual(0)

  const guardIndex = sql.lastIndexOf(guardNeedle, guardedIndex)
  expect(guardIndex).toBeGreaterThanOrEqual(0)
  expect(guardIndex).toBeLessThan(guardedIndex)
}

describe('037_add_gallery_form_support.sql compatibility guards', () => {
  it('guards view_configs indexes and demo seeds by column existence', () => {
    const sql = readMigration()

    expectGuardBefore(
      sql,
      "table_name = 'view_configs' AND column_name = 'type'",
      'CREATE INDEX IF NOT EXISTS idx_view_configs_type ON view_configs(type)'
    )
    expectGuardBefore(
      sql,
      "table_name = 'view_configs' AND column_name = 'created_by'",
      'CREATE INDEX IF NOT EXISTS idx_view_configs_created_by ON view_configs(created_by)'
    )
    expectGuardBefore(
      sql,
      "table_name = 'view_configs' AND column_name = 'deleted_at'",
      'CREATE INDEX IF NOT EXISTS idx_view_configs_deleted ON view_configs(deleted_at)'
    )
    for (const column of ['id', 'name', 'type', 'description', 'config_data', 'created_by']) {
      expectGuardBefore(
        sql,
        `table_name = 'view_configs' AND column_name = '${column}'`,
        'INSERT INTO view_configs (id, name, type, description, config_data, created_by)'
      )
    }
  })

  it('guards form_responses form_id index for timestamp-based schemas', () => {
    const sql = readMigration()

    expectGuardBefore(
      sql,
      "table_name = 'form_responses' AND column_name = 'form_id'",
      'CREATE INDEX IF NOT EXISTS idx_form_responses_form_id ON form_responses(form_id)'
    )
    expectGuardBefore(
      sql,
      "table_name = 'form_responses' AND column_name = 'submitted_by'",
      'CREATE INDEX IF NOT EXISTS idx_form_responses_submitted_by ON form_responses(submitted_by)'
    )
    expectGuardBefore(
      sql,
      "table_name = 'form_responses' AND column_name = 'submitted_at'",
      'CREATE INDEX IF NOT EXISTS idx_form_responses_submitted_at ON form_responses(submitted_at DESC)'
    )
    expectGuardBefore(
      sql,
      "table_name = 'form_responses' AND column_name = 'status'",
      'CREATE INDEX IF NOT EXISTS idx_form_responses_status ON form_responses(status)'
    )
  })

  it('guards optional view_states trigger and comments by column existence', () => {
    const sql = readMigration()

    expectGuardBefore(
      sql,
      "table_name = 'view_states' AND column_name = 'user_id'",
      'CREATE INDEX IF NOT EXISTS idx_view_states_user ON view_states(user_id)'
    )
    expectGuardBefore(
      sql,
      "table_name = 'view_states' AND column_name = 'updated_at'",
      'CREATE TRIGGER update_view_states_updated_at'
    )
    expectGuardBefore(
      sql,
      "table_name = 'view_states' AND column_name = 'state_data'",
      'COMMENT ON COLUMN view_states.state_data'
    )
  })

  it('guards legacy form response comments by column existence', () => {
    const sql = readMigration()

    expectGuardBefore(
      sql,
      "table_name = 'form_responses' AND column_name = 'response_data'",
      'COMMENT ON COLUMN form_responses.response_data'
    )
    expectGuardBefore(
      sql,
      "table_name = 'form_responses' AND column_name = 'submitted_by'",
      'COMMENT ON COLUMN form_responses.submitted_by'
    )
  })
})

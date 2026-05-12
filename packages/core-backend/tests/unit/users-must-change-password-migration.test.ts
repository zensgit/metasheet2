import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

const legacySqlPath = resolve(
  __dirname,
  '../../migrations/056_add_users_must_change_password.sql'
)

const modernMigrationPath = resolve(
  __dirname,
  '../../src/db/migrations/zzzz20260512100000_add_users_must_change_password.ts'
)

describe('users must_change_password migrations', () => {
  it('guards legacy 056 SQL when users table is not created yet', () => {
    const sql = readFileSync(legacySqlPath, 'utf8')

    expect(sql).toContain("to_regclass('public.users') IS NOT NULL")
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS must_change_password')
  })

  it('adds a modern timestamp bridge migration after users table creation', () => {
    const source = readFileSync(modernMigrationPath, 'utf8')

    expect(source).toContain("checkTableExists(db, 'users')")
    expect(source).toContain('ADD COLUMN IF NOT EXISTS must_change_password')
    expect(source).toContain('DROP COLUMN IF EXISTS must_change_password')
  })
})

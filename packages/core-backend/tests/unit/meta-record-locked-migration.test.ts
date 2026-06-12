import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * LR-T8 — migration up/down clean for the record-locking storage columns
 * (design #2278 follow-up). Mirrors the modified_by precedent
 * (zzzz20260430163000_add_meta_record_modified_by.ts): additive columns, indexed
 * locker, and a `down()` that removes EVERY artifact `up()` created.
 */
const MIGRATION = resolve(
  __dirname,
  '../../src/db/migrations/zzzz20260612140000_add_meta_record_locked.ts',
)
const src = readFileSync(MIGRATION, 'utf8')

describe('meta_records locking columns migration', () => {
  it('adds locked / locked_by / locked_at to meta_records with the right shapes', () => {
    expect(src).toMatch(/ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false/)
    expect(src).toMatch(/ADD COLUMN IF NOT EXISTS locked_by text/)
    expect(src).toMatch(/ADD COLUMN IF NOT EXISTS locked_at timestamptz/)
  })

  it('indexes locked_by mirroring the modified_by precedent', () => {
    expect(src).toMatch(/CREATE INDEX IF NOT EXISTS idx_meta_records_locked_by[\s\S]*ON meta_records\(locked_by\)/)
  })

  it('down() removes every artifact up() created (clean rollback)', () => {
    expect(src).toContain('DROP INDEX IF EXISTS idx_meta_records_locked_by')
    expect(src).toContain('DROP COLUMN IF EXISTS locked_at')
    expect(src).toContain('DROP COLUMN IF EXISTS locked_by')
    expect(src).toMatch(/DROP COLUMN IF EXISTS locked\b/)
    // index dropped before columns, columns dropped in reverse-add order
    expect(src).toMatch(/down[\s\S]*DROP INDEX[\s\S]*DROP COLUMN IF EXISTS locked_at[\s\S]*DROP COLUMN IF EXISTS locked_by[\s\S]*DROP COLUMN IF EXISTS locked\b/)
  })
})

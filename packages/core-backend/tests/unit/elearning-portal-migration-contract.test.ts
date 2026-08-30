import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migrationPath = join(
  __dirname,
  '../../src/db/migrations/zzzz20260830210000_create_elearning_portal_settings.ts',
)

function source() {
  return readFileSync(migrationPath, 'utf8')
}

describe('e-learning portal migration contract', () => {
  it('owns one versioned org-scoped authority with executable head consistency', () => {
    const text = source()
    for (const table of [
      'elearning_portal_revisions',
      'elearning_portal_revision_navigation',
      'elearning_portal_heads',
      'elearning_portal_publish_requests',
    ]) expect(text).toContain(table)
    expect(text).toMatch(/PRIMARY KEY \(org_id, id\)/)
    expect(text).toMatch(/UNIQUE \(org_id, version\)/)
    expect(text).toMatch(/UNIQUE \(org_id, id, version\)/)
    expect(text).toMatch(
      /FOREIGN KEY \(org_id, active_revision_id, latest_version\)[\s\S]*REFERENCES elearning_portal_revisions \(org_id, id, version\)/,
    )
    expect(text).not.toMatch(/org_id\s+text[^\n]*DEFAULT/i)
  })

  it('keeps revisions, navigation and request evidence append-only', () => {
    const text = source()
    expect(text).toContain('elearning_portal_reject_immutable_write')
    expect(text).toMatch(/BEFORE UPDATE OR DELETE ON \$\{table\}/)
    expect(text).toContain('row.trigger_type !== 27')
    expect(text).toContain('row.when_clause !== null')
    expect(text).toContain('row.update_columns !== 0')
    expect(text).toContain("row.enabled !== 'O'")
    expect(text).toContain('row.security_definer')
  })

  it('fails replay on partial or structurally drifted authority', () => {
    const text = source()
    expect(text).toContain("drift('partial table set')")
    expect(text).toContain("drift('column set')")
    expect(text).toContain('async function assertConstraint')
    expect(text).toContain("drift(expected.name)")
    expect(text).toContain('EXPECTED_CHECKS')
    expect(text).toContain("drift('check constraint set')")
    expect(text).toContain("drift('immutable trigger set')")
    expect(text).toContain('ELEARNING_PORTAL_TABLES.length')
  })

  it('refuses destructive rollback after authority rows exist', () => {
    const text = source()
    expect(text).toContain('elearning portal migration down refused: authoritative rows exist')
    expect(text).toMatch(/SELECT count\(\*\) FROM elearning_portal_revisions/)
    expect(text).toMatch(/DROP TABLE IF EXISTS elearning_portal_publish_requests/)
    expect(text).toMatch(/DROP TABLE IF EXISTS elearning_portal_revisions/)
  })
})

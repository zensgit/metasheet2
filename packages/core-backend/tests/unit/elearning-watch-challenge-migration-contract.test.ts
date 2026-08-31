import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const migrationUrl = new URL(
  '../../src/db/migrations/zzzz20260831160000_create_elearning_watch_challenges.ts',
  import.meta.url,
)

describe('elearning watch challenge migration contract', () => {
  it('pins the video-only bounded policy and same-org schedule authority', async () => {
    const source = await readFile(migrationUrl, 'utf8')
    expect(source).toContain("item_type = 'video'")
    expect(source).toContain('watch_challenge_count BETWEEN 1 AND 10')
    expect(source).toContain('watch_challenge_response_window_ms BETWEEN 1 AND 120000')
    expect(source).toContain('FOREIGN KEY (org_id, session_id)')
    expect(source).toContain('REFERENCES elearning_learning_sessions (org_id, id) ON DELETE RESTRICT')
    expect(source).toContain('FOREIGN KEY (org_id, course_version_item_id)')
  })

  it('makes snapshots and event/request ledgers executable immutable authorities', async () => {
    const source = await readFile(migrationUrl, 'utf8')
    expect(source).toContain('elearning watch challenge snapshot is immutable')
    expect(source).toContain('elearning watch challenge ledger is append-only')
    expect(source).toContain('BEFORE UPDATE OR DELETE ON elearning_watch_challenge_schedules')
    expect(source).toContain('BEFORE UPDATE OR DELETE ON ${table}')
    expect(source).toContain('BEFORE TRUNCATE ON ${table}')
    expect(source).toContain('request_hash_version = 1')
  })

  it('fails replay on partial tables, columns, constraints, or trigger rebinding', async () => {
    const source = await readFile(migrationUrl, 'utf8')
    expect(source).toContain('migration drift: partial tables')
    expect(source).toContain('migration drift: table columns')
    expect(source).toContain('migration drift: constraints')
    expect(source).toContain('migration drift: triggers')
    expect(source).toContain('row.function_oid !== row.canonical_oid')
  })

  it('refuses a destructive down when authoritative rows exist', async () => {
    const source = await readFile(migrationUrl, 'utf8')
    expect(source).toContain('down refused: authoritative rows exist')
    expect(source).toContain("row.schedules !== '0'")
    expect(source).toContain("row.events !== '0'")
    expect(source).toContain("row.requests !== '0'")
  })
})

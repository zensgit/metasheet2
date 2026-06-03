import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

// ④ C1 (design-lock #2230) — DB-free guard that the migration DEFINES the locked ledger invariants.
// The real-DB constraint enforcement is covered by the attendance integration suite; this always-on
// unit guard catches a future edit that drops the backstop or makes the events table optional.
const MIGRATION = resolve(
  __dirname,
  '../../src/db/migrations/zzzz20260603120000_create_attendance_leave_balances.ts',
)
const src = readFileSync(MIGRATION, 'utf8')

describe('④ C1 attendance leave-balance ledger migration', () => {
  it('creates both the grant-lot ledger and the required events audit table', () => {
    expect(src).toContain("'attendance_leave_balances'")
    expect(src).toContain("'attendance_leave_balance_events'")
    // down() drops events before balances (FK order)
    expect(src).toMatch(/dropTable\(EVENTS\)[\s\S]*dropTable\(BALANCES\)/)
  })

  it('locks the double-credit backstop on source_key (NOT NULL + UNIQUE(org_id, source_key)), not source_id', () => {
    expect(src).toMatch(/addColumn\('source_key', 'text', col => col\.notNull\(\)\)/)
    // source_id stays a nullable back-link — explicitly NOT notNull
    expect(src).toMatch(/addColumn\('source_id', 'text'\)/)
    // the uniqueness is a unique index over (org_id, source_key)
    expect(src).toMatch(/uq_attendance_leave_balances_org_source_key[\s\S]*\['org_id', 'source_key'\][\s\S]*unique: true/)
  })

  it('events ledger carries the +/- audit shape and cascades from its lot', () => {
    expect(src).toContain("addColumn('balance_id'")
    expect(src).toContain('${BALANCES}.id')
    expect(src).toContain(".onDelete('cascade')")
    for (const col of ['event_type', 'delta_minutes', 'occurred_at']) {
      expect(src).toContain(`addColumn('${col}'`)
    }
  })

  it('locks the balance math + enum invariants as DB CHECK constraints (#2230)', () => {
    expect(src).toContain('amount_minutes > 0')
    expect(src).toContain('remaining_minutes >= 0 AND remaining_minutes <= amount_minutes')
    expect(src).toContain("status IN ('active', 'exhausted', 'expired', 'revoked')")
    expect(src).toContain("event_type IN ('grant', 'deduct', 'expire', 'revoke')")
    // grant > 0; deduct/expire/revoke < 0 (also forbids delta_minutes = 0)
    expect(src).toContain("event_type = 'grant' AND delta_minutes > 0")
    expect(src).toContain("event_type IN ('deduct', 'expire', 'revoke') AND delta_minutes < 0")
  })
})

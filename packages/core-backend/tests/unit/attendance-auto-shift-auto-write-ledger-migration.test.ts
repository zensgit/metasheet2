import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

const MIGRATION = resolve(
  __dirname,
  '../../src/db/migrations/zzzz20260610140000_create_attendance_auto_shift_auto_write_ledger.ts',
)
const src = readFileSync(MIGRATION, 'utf8')

describe('A2 auto-shift auto-write run ledger migration', () => {
  it('creates the dormant run parent and per-item audit tables', () => {
    expect(src).toContain("'attendance_auto_shift_auto_write_runs'")
    expect(src).toContain("'attendance_auto_shift_auto_write_run_items'")
    expect(src).toMatch(/dropTable\(ITEMS\)[\s\S]*dropTable\(RUNS\)/)
  })

  it('locks the active-run claim as a partial unique index over org/source/window', () => {
    expect(src).toMatch(/uq_attendance_auto_shift_runs_active_window[\s\S]*\['org_id', 'source', 'target_from', 'target_to'\][\s\S]*unique: true/)
    expect(src).toContain("where: sql`status = 'running'`")
  })

  it('keeps run state well-formed with DB CHECK constraints', () => {
    expect(src).toContain("status IN ('running', 'succeeded', 'partial', 'failed')")
    expect(src).toContain("source <> ''")
    expect(src).toContain('target_from <= target_to')
    expect(src).toContain("(status = 'running' AND finished_at IS NULL) OR (status <> 'running' AND finished_at IS NOT NULL)")
    expect(src).toContain('scanned_count >= 0 AND candidate_count >= 0 AND applied_count >= 0 AND skipped_count >= 0 AND error_count >= 0')
  })

  it('links each item to its run and de-duplicates user/day outcomes inside a run', () => {
    expect(src).toContain("addColumn('run_id'")
    expect(src).toMatch(/uq_attendance_auto_shift_runs_id_org[\s\S]*\['id', 'org_id'\][\s\S]*unique: true/)
    expect(src).toContain("'fk_attendance_auto_shift_run_items_run_org'")
    expect(src).toContain("['run_id', 'org_id']")
    expect(src).toContain("['id', 'org_id']")
    expect(src).toContain(".onDelete('cascade')")
    expect(src).toMatch(/uq_attendance_auto_shift_run_items_user_day[\s\S]*\['run_id', 'user_id', 'work_date'\][\s\S]*unique: true/)
  })

  it('locks item outcome invariants for later rollback and audit semantics', () => {
    expect(src).toContain("status IN ('applied', 'skipped', 'error')")
    expect(src).toContain("confidence IS NULL OR confidence IN ('high', 'medium', 'low')")
    expect(src).toContain("jsonb_typeof(evidence_event_ids) = 'array'")
    expect(src).toContain("(status = 'applied') = (assignment_id IS NOT NULL)")
    expect(src).toContain("status = 'applied' OR reason IS NOT NULL OR error_message IS NOT NULL")
  })
})

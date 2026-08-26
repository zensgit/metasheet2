import { promises as fs } from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  ELEARNING_ATTEMPT_AWAITING_MANUAL_CHECK,
  ELEARNING_ATTEMPT_EARNED_SCORE_CAP_CHECK,
  ELEARNING_ATTEMPT_MANUAL_SCORE_CHECK,
  ELEARNING_ATTEMPT_MANUAL_STATUS_CHECK,
  ELEARNING_ATTEMPT_REGRADE_CHECK,
  ELEARNING_GRADING_RECORD_AUTO_UNIQUE,
  ELEARNING_GRADING_RECORD_EFFECTIVE_INDEX,
  ELEARNING_GRADING_RECORD_KIND_CHECK,
  ELEARNING_GRADING_RECORD_KIND_SHAPE_CHECK,
  ELEARNING_GRADING_RECORD_QUESTION_FK,
  ELEARNING_GRADING_RECORD_REQUEST_UNIQUE,
  ELEARNING_GRADING_RECORD_SEQUENCE_CHECK,
  ELEARNING_GRADING_RECORD_SEQUENCE_UNIQUE,
  ELEARNING_MANUAL_GRADING_DOWN_NONEMPTY,
  down,
  up,
} from '../../src/db/migrations/zzzz20260826235930_prepare_elearning_manual_grading'

const MIGRATION = path.join(
  __dirname,
  '../../src/db/migrations/zzzz20260826235930_prepare_elearning_manual_grading.ts',
)

describe('e-learning manual-grading migration contract', () => {
  it('exports a reversible migration and names every new database invariant', () => {
    expect(typeof up).toBe('function')
    expect(typeof down).toBe('function')
    expect([
      ELEARNING_ATTEMPT_MANUAL_STATUS_CHECK,
      ELEARNING_ATTEMPT_MANUAL_SCORE_CHECK,
      ELEARNING_ATTEMPT_AWAITING_MANUAL_CHECK,
      ELEARNING_ATTEMPT_EARNED_SCORE_CAP_CHECK,
      ELEARNING_ATTEMPT_REGRADE_CHECK,
      ELEARNING_GRADING_RECORD_KIND_CHECK,
      ELEARNING_GRADING_RECORD_KIND_SHAPE_CHECK,
      ELEARNING_GRADING_RECORD_SEQUENCE_CHECK,
      ELEARNING_GRADING_RECORD_SEQUENCE_UNIQUE,
      ELEARNING_GRADING_RECORD_QUESTION_FK,
      ELEARNING_GRADING_RECORD_AUTO_UNIQUE,
      ELEARNING_GRADING_RECORD_REQUEST_UNIQUE,
      ELEARNING_GRADING_RECORD_EFFECTIVE_INDEX,
    ]).toEqual([
      'elearning_exam_attempts_status_chk',
      'elearning_exam_attempts_manual_score_nonneg_chk',
      'elearning_exam_attempts_awaiting_manual_chk',
      'elearning_exam_attempts_earned_score_cap_chk',
      'elearning_exam_attempts_regraded_at_chk',
      'elearning_grading_records_kind_chk',
      'elearning_grading_records_kind_shape_chk',
      'elearning_grading_records_seq_chk',
      'elearning_grading_records_org_attempt_seq_uniq',
      'elearning_grading_records_question_revision_fk',
      'idx_elearning_grading_records_one_auto',
      'idx_elearning_grading_records_request_id',
      'idx_elearning_grading_records_effective_question',
    ])
  })

  it('adds manual grading without introducing an API or a new question type', async () => {
    const source = await fs.readFile(MIGRATION, 'utf8')
    const upSource = source.split('export async function down')[0] ?? ''

    expect(upSource).toContain(
      'ADD COLUMN manual_score numeric NOT NULL DEFAULT 0',
    )
    expect(upSource).toContain('ADD COLUMN regraded_at timestamptz')
    expect(upSource).toContain("'awaiting_manual'")
    expect(upSource).toContain("CHECK (kind IN ('auto', 'manual', 'regrade'))")
    expect(upSource).toContain('ADD COLUMN question_revision_id uuid')
    expect(upSource).toContain('ADD COLUMN request_id uuid')
    expect(upSource).toContain('ADD COLUMN seq integer NOT NULL DEFAULT 1')
    expect(upSource).toContain('FOREIGN KEY (org_id, question_revision_id)')
    expect(upSource).toContain('UNIQUE (org_id, attempt_id, seq)')
    expect(upSource).toContain("WHERE kind = 'auto'")
    expect(upSource).toContain('WHERE request_id IS NOT NULL')
    expect(upSource).toContain('auto_score + manual_score <= total_score')
    expect(upSource).toContain(
      "NEW.status IN ('submitted', 'awaiting_manual', 'expired')",
    )
    expect(upSource).toContain(
      "OLD.status IN ('submitted', 'awaiting_manual', 'expired')",
    )
    expect(upSource).toContain('regrade must advance regraded_at')
    expect(upSource).not.toContain("'short_answer'")
    expect(upSource).not.toMatch(/\bRouter\b|app\.(get|post|put|patch)/)
  })

  it('keeps the objective-only rollback shape and fails closed on manual residue', async () => {
    const source = await fs.readFile(MIGRATION, 'utf8')
    const downSource = source.split('export async function down')[1] ?? ''

    expect(ELEARNING_MANUAL_GRADING_DOWN_NONEMPTY).toBe(
      'cannot roll back manual grading while manual state or ledger data exists',
    )
    expect(downSource).toContain('ELEARNING_MANUAL_GRADING_DOWN_NONEMPTY')
    expect(downSource).toContain("status = 'awaiting_manual'")
    expect(downSource).toContain("kind <> 'auto'")
    expect(downSource).toContain('request_id IS NOT NULL')
    expect(downSource).toContain('seq <> 1')
    expect(downSource).toContain(
      "CHECK (status IN ('started', 'submitted', 'graded', 'expired'))",
    )
    expect(downSource).toContain("CHECK (kind IN ('auto'))")
    expect(downSource).toContain('UNIQUE (org_id, attempt_id, kind)')
    expect(downSource).not.toMatch(/\bCASCADE\b/)
  })
})

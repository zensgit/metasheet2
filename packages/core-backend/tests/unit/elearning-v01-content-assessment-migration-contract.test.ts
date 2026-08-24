import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  COURSE_VERSIONS_STATE_FN,
  COURSE_VERSIONS_STATE_TRIGGER,
  COURSE_VERSION_ITEMS_DRAFT_FN,
  COURSE_VERSION_ITEMS_DRAFT_TRIGGER,
  COURSES_ACTIVE_VERSION_FN,
  COURSES_ACTIVE_VERSION_TRIGGER,
  ELEARNING_V01_IMMUTABILITY_TRIGGERS,
  ELEARNING_V01_TABLES,
  EXAMS_STATE_FN,
  EXAMS_STATE_TRIGGER,
  EXAM_ATTEMPTS_STATE_FN,
  EXAM_ATTEMPTS_STATE_TRIGGER,
  EXAM_QUESTIONS_DRAFT_FN,
  EXAM_QUESTIONS_DRAFT_TRIGGER,
  GRADING_RECORD_ATTEMPT_KIND_UNIQ,
  GRADING_RECORD_DENY_FN,
  GRADING_RECORD_DENY_TRIGGER,
  QUESTION_REVISION_DENY_FN,
  QUESTION_REVISION_DENY_TRIGGER,
} from '../../src/db/migrations/zzzz20260824120000_create_elearning_v01_content_assessment'
import { ELEARNING_PERMISSION_CODES } from '../../src/db/migrations/zzzz20260824121000_add_elearning_permissions'
import {
  ASSIGNMENT_MEMBERS_PIT_FN,
  ASSIGNMENT_MEMBERS_PIT_TRIGGER,
  ASSIGNMENTS_PUBLISHED_VERSION_FN,
  ASSIGNMENTS_PUBLISHED_VERSION_TRIGGER,
  COMPLETION_EVIDENCE_DENY_FN,
  COMPLETION_EVIDENCE_DENY_TRIGGER,
  ELEARNING_V01_WATCH_IMMUTABILITY_TRIGGERS,
  ELEARNING_V01_WATCH_TABLES,
  LEARNING_SESSIONS_ONE_ACTIVE_INDEX,
} from '../../src/db/migrations/zzzz20260825120000_create_elearning_v01_watch_progress'

const MIGRATIONS_DIR = path.join(__dirname, '../../src/db/migrations')
const CONTENT_MIGRATION = path.join(
  MIGRATIONS_DIR,
  'zzzz20260824120000_create_elearning_v01_content_assessment.ts',
)
const PERMISSION_MIGRATION = path.join(
  MIGRATIONS_DIR,
  'zzzz20260824121000_add_elearning_permissions.ts',
)
const WATCH_MIGRATION = path.join(
  MIGRATIONS_DIR,
  'zzzz20260825120000_create_elearning_v01_watch_progress.ts',
)

function plpgsqlBody(source: string, fnName: string): string {
  const header = `CREATE OR REPLACE FUNCTION ${fnName}()`
  const start = source.indexOf(header)
  expect(start, header).toBeGreaterThanOrEqual(0)
  const asTag = source.indexOf('AS $fn$', start)
  expect(asTag, `${fnName} AS $fn$`).toBeGreaterThan(start)
  const bodyStart = asTag + 'AS $fn$'.length
  const bodyEnd = source.indexOf('$fn$', bodyStart)
  expect(bodyEnd, `${fnName} closing $fn$`).toBeGreaterThan(bodyStart)
  return source.slice(bodyStart, bodyEnd)
}

describe('elearning V0.1 content/assessment migration source contract', () => {
  it('exposes reversible up/down on both Part A migrations', async () => {
    const content = await import(
      '../../src/db/migrations/zzzz20260824120000_create_elearning_v01_content_assessment'
    )
    const permissions = await import(
      '../../src/db/migrations/zzzz20260824121000_add_elearning_permissions'
    )
    expect(typeof content.up).toBe('function')
    expect(typeof content.down).toBe('function')
    expect(typeof permissions.up).toBe('function')
    expect(typeof permissions.down).toBe('function')
  })

  it('creates exactly the 10 Part A tables and names append-only / state-machine triggers', async () => {
    const source = await fs.readFile(CONTENT_MIGRATION, 'utf8')
    expect(ELEARNING_V01_TABLES).toHaveLength(10)
    for (const table of ELEARNING_V01_TABLES) {
      expect(source).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
    expect(ELEARNING_V01_IMMUTABILITY_TRIGGERS).toHaveLength(8)
    for (const { table, name, fn } of ELEARNING_V01_IMMUTABILITY_TRIGGERS) {
      expect(source).toContain(`CREATE OR REPLACE FUNCTION ${fn}()`)
      expect(source).toContain(`CREATE TRIGGER ${name}`)
      expect(source).toContain(`ON ${table}`)
      expect(source).toContain(`EXECUTE FUNCTION ${fn}()`)
    }
    expect(source).toContain(QUESTION_REVISION_DENY_FN)
    expect(source).toContain(QUESTION_REVISION_DENY_TRIGGER)
    expect(source).toContain(GRADING_RECORD_DENY_FN)
    expect(source).toContain(GRADING_RECORD_DENY_TRIGGER)
    expect(source).toContain(COURSES_ACTIVE_VERSION_FN)
    expect(source).toContain(COURSES_ACTIVE_VERSION_TRIGGER)
    expect(source).toContain(COURSE_VERSIONS_STATE_FN)
    expect(source).toContain(COURSE_VERSIONS_STATE_TRIGGER)
    expect(source).toContain(COURSE_VERSION_ITEMS_DRAFT_FN)
    expect(source).toContain(COURSE_VERSION_ITEMS_DRAFT_TRIGGER)
    expect(source).toContain(EXAMS_STATE_FN)
    expect(source).toContain(EXAMS_STATE_TRIGGER)
    expect(source).toContain(EXAM_QUESTIONS_DRAFT_FN)
    expect(source).toContain(EXAM_QUESTIONS_DRAFT_TRIGGER)
    expect(source).toContain(EXAM_ATTEMPTS_STATE_FN)
    expect(source).toContain(EXAM_ATTEMPTS_STATE_TRIGGER)
    expect(source).toContain('FOREIGN KEY (org_id, id, active_version_id)')
    expect(source).toContain('FOREIGN KEY (org_id, id, latest_version_id)')
    expect(source).toContain(`CONSTRAINT ${GRADING_RECORD_ATTEMPT_KIND_UNIQ} UNIQUE (org_id, attempt_id, kind)`)
    expect(source).toContain('elearning_exam_attempts_started_no_grade_chk')
    expect(source).toContain('elearning_exam_attempts_submitted_expired_frozen_chk')
    expect(source).toContain('elearning_exam_attempts_graded_complete_chk')
    expect(source).toContain('BEFORE INSERT OR UPDATE OR DELETE ON elearning_exam_attempts')
    expect(source).toContain('active_version_id must reference a published course version')
    expect(source).toContain('cannot retire course version while it is the course active_version_id')
    expect(source).toContain('cannot publish exam: at least one exam question is required')
    expect(source).toContain('cannot publish course version: at least one video item is required')
    expect(source).toContain('cannot publish course version: at least one exam item is required')
    expect(source).toContain('video items require media status ready')
    expect(source).toContain('exam items require exam status published')
    expect(source).toContain('elearning_course_version_items cannot move across parents')
    expect(source).toContain('UNIQUE (org_id, course_version_id, id)')
    expect(source).toContain('completion_policy_version text')
    expect(source).toContain('completion_threshold_bps integer')
    expect(source).toContain('elearning_course_version_items_completion_policy_chk')
    expect(source).toContain('elearning_course_version_items_org_version_id_uniq')

    const itemsStart = source.indexOf('CREATE TABLE IF NOT EXISTS elearning_course_version_items')
    const itemsEnd = source.indexOf('CREATE TABLE IF NOT EXISTS elearning_exam_attempts')
    expect(itemsStart).toBeGreaterThanOrEqual(0)
    expect(itemsEnd).toBeGreaterThan(itemsStart)
    const itemsBlock = source.slice(itemsStart, itemsEnd)
    expect(itemsBlock).not.toMatch(/completion_policy_version text[^\n]*DEFAULT/i)
    expect(itemsBlock).not.toMatch(/completion_threshold_bps integer[^\n]*DEFAULT/i)
    expect(source).toContain('elearning_exam_questions cannot move across parents')
    expect(source).toContain('elearning_course_versions audit fields are immutable')
    expect(source).toContain('elearning_exams audit fields are immutable')
    expect(source).toContain('elearning_exam_attempts must be inserted as started')
    expect(source).toContain('elearning_exam_attempts identity fields are immutable after insert')
    expect(source).toContain('elearning_exam_attempts answers and submitted_at are immutable after submit/expire')
    expect(source).toContain('elearning_exam_attempts graded rows cannot be updated')
    expect(source).toContain('elearning_exam_attempts graded rows cannot be deleted')

    const itemsBody = plpgsqlBody(source, COURSE_VERSION_ITEMS_DRAFT_FN)
    expect(itemsBody).toMatch(
      /SELECT status INTO parent_status\s+FROM elearning_course_versions[\s\S]*FOR UPDATE/,
    )
    const questionsBody = plpgsqlBody(source, EXAM_QUESTIONS_DRAFT_FN)
    expect(questionsBody).toMatch(
      /SELECT status INTO parent_status\s+FROM elearning_exams[\s\S]*FOR UPDATE/,
    )
    const activeBody = plpgsqlBody(source, COURSES_ACTIVE_VERSION_FN)
    expect(activeBody).toMatch(
      /SELECT status INTO version_status\s+FROM elearning_course_versions\s+WHERE org_id = NEW\.org_id\s+AND course_id = NEW\.id\s+AND id = NEW\.active_version_id;/,
    )
    expect(activeBody).not.toMatch(/FOR UPDATE/)
    const versionsBody = plpgsqlBody(source, COURSE_VERSIONS_STATE_FN)
    expect(versionsBody).toMatch(
      /PERFORM 1\s+FROM elearning_courses\s+WHERE org_id = NEW\.org_id\s+AND id = NEW\.course_id\s+FOR UPDATE/,
    )
    expect(plpgsqlBody(source, EXAM_ATTEMPTS_STATE_FN)).toContain("TG_OP = 'INSERT'")
    expect(source).not.toContain('elearning_scopes')
    expect(source).not.toContain('elearning_assignments')
    expect(source).not.toContain('elearning_progress')
    expect(source).not.toContain('elearning_jobs')
    expect(source).not.toContain('elearning_credit')
    expect(source).not.toContain('elearning_certificate')
  })

  it('declares org_id TEXT NOT NULL with no DEFAULT on every table', async () => {
    const source = await fs.readFile(CONTENT_MIGRATION, 'utf8')
    const orgIdLines = source
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^org_id\s+/i.test(line))
    expect(orgIdLines.length).toBeGreaterThanOrEqual(ELEARNING_V01_TABLES.length)
    for (const line of orgIdLines) {
      expect(line.toLowerCase()).toContain('text')
      expect(line.toLowerCase()).toContain('not null')
      expect(line.toLowerCase()).not.toContain('default')
    }
  })

  it('drops triggers, functions, and tables in reverse dependency order without CASCADE', async () => {
    const source = await fs.readFile(CONTENT_MIGRATION, 'utf8')
    const downSource = source.split('export async function down')[1] ?? ''
    expect(downSource).not.toMatch(/\bCASCADE\b/)

    const markers = [
      'DROP TRIGGER IF EXISTS trg_elearning_grading_records_deny_mutation',
      'DROP FUNCTION IF EXISTS elearning_grading_records_deny_mutation()',
      'DROP TRIGGER IF EXISTS trg_elearning_exam_attempts_state_guard',
      'DROP FUNCTION IF EXISTS elearning_exam_attempts_state_guard()',
      'DROP TABLE IF EXISTS elearning_grading_records',
      'DROP TABLE IF EXISTS elearning_exam_attempts',
      'DROP TRIGGER IF EXISTS trg_elearning_course_version_items_draft_parent',
      'DROP FUNCTION IF EXISTS elearning_course_version_items_draft_parent()',
      'DROP TABLE IF EXISTS elearning_course_version_items',
      'DROP TRIGGER IF EXISTS trg_elearning_exam_questions_draft_parent',
      'DROP FUNCTION IF EXISTS elearning_exam_questions_draft_parent()',
      'DROP TABLE IF EXISTS elearning_exam_questions',
      'DROP TRIGGER IF EXISTS trg_elearning_exams_state_guard',
      'DROP FUNCTION IF EXISTS elearning_exams_state_guard()',
      'DROP TABLE IF EXISTS elearning_exams',
      'DROP TRIGGER IF EXISTS trg_elearning_question_revisions_deny_mutation',
      'DROP FUNCTION IF EXISTS elearning_question_revisions_deny_mutation()',
      'DROP TABLE IF EXISTS elearning_question_revisions',
      'DROP TABLE IF EXISTS elearning_questions',
      'DROP TABLE IF EXISTS elearning_media',
      'DROP TRIGGER IF EXISTS trg_elearning_course_versions_state_guard',
      'DROP FUNCTION IF EXISTS elearning_course_versions_state_guard()',
      'DROP CONSTRAINT IF EXISTS elearning_courses_active_version_fk',
      'DROP CONSTRAINT IF EXISTS elearning_courses_latest_version_fk',
      'DROP TRIGGER IF EXISTS trg_elearning_courses_active_version_published',
      'DROP FUNCTION IF EXISTS elearning_courses_active_version_published()',
      'DROP TABLE IF EXISTS elearning_course_versions',
      'DROP TABLE IF EXISTS elearning_courses',
    ]
    const indexes = markers.map((marker) => downSource.indexOf(marker))
    for (const [index, marker] of markers.entries()) {
      expect(indexes[index], marker).toBeGreaterThanOrEqual(0)
      if (index > 0) {
        expect(indexes[index], marker).toBeGreaterThan(indexes[index - 1])
      }
    }
  })

  it('seeds the five elearning permissions with DO $$ + ON CONFLICT and domain-only down', async () => {
    const source = await fs.readFile(PERMISSION_MIGRATION, 'utf8')
    expect(source).toContain('DO $$')
    expect(source).toContain('ON CONFLICT (code) DO NOTHING')
    expect(source).toContain('ON CONFLICT DO NOTHING')
    for (const code of ELEARNING_PERMISSION_CODES) {
      expect(source).toContain(`'${code}'`)
    }
    expect(ELEARNING_PERMISSION_CODES).toHaveLength(5)

    const downSource = source.split('export async function down')[1] ?? ''
    const roleDelete = downSource.indexOf('DELETE FROM role_permissions')
    const permissionDelete = downSource.indexOf('DELETE FROM permissions')
    expect(roleDelete).toBeGreaterThanOrEqual(0)
    expect(permissionDelete).toBeGreaterThan(roleDelete)
    expect(downSource).not.toContain('attendance:')
    expect(downSource).toContain("permission_code IN")
  })
})

describe('elearning V0.1 watch-progress migration source contract', () => {
  it('exposes reversible up/down', async () => {
    const watch = await import(
      '../../src/db/migrations/zzzz20260825120000_create_elearning_v01_watch_progress'
    )
    expect(typeof watch.up).toBe('function')
    expect(typeof watch.down).toBe('function')
  })

  it('creates exactly the six assignment-only watch tables and names immutability triggers', async () => {
    const source = await fs.readFile(WATCH_MIGRATION, 'utf8')
    expect(ELEARNING_V01_WATCH_TABLES).toHaveLength(6)
    for (const table of ELEARNING_V01_WATCH_TABLES) {
      expect(source).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
    expect(ELEARNING_V01_WATCH_IMMUTABILITY_TRIGGERS).toHaveLength(3)
    for (const { table, name, fn } of ELEARNING_V01_WATCH_IMMUTABILITY_TRIGGERS) {
      expect(source).toContain(`CREATE OR REPLACE FUNCTION ${fn}()`)
      expect(source).toContain(`CREATE TRIGGER ${name}`)
      expect(source).toContain(`ON ${table}`)
      expect(source).toContain(`EXECUTE FUNCTION ${fn}()`)
    }
    expect(source).toContain(ASSIGNMENT_MEMBERS_PIT_FN)
    expect(source).toContain(ASSIGNMENT_MEMBERS_PIT_TRIGGER)
    expect(source).toContain(ASSIGNMENTS_PUBLISHED_VERSION_FN)
    expect(source).toContain(ASSIGNMENTS_PUBLISHED_VERSION_TRIGGER)
    expect(source).toContain(COMPLETION_EVIDENCE_DENY_FN)
    expect(source).toContain(COMPLETION_EVIDENCE_DENY_TRIGGER)
    expect(source).toContain(LEARNING_SESSIONS_ONE_ACTIVE_INDEX)
    expect(source).toContain("CHECK (kind IN ('start', 'heartbeat'))")
    expect(source).toContain('required_at_completion IS TRUE')
    expect(source).toContain('assignment_member_id uuid NOT NULL')
    expect(source).toContain('UNIQUE (org_id, id, course_version_id)')
    expect(source).toContain('UNIQUE (org_id, assignment_id, user_id)')
    expect(source).toContain('UNIQUE (org_id, session_id, sequence)')
    expect(source).toContain('UNIQUE (org_id, id, course_version_id, course_version_item_id, user_id)')
    expect(source).toContain(
      'FOREIGN KEY (org_id, session_id, course_version_id, course_version_item_id, user_id)',
    )
    expect(source).toContain(
      'REFERENCES elearning_learning_sessions (org_id, id, course_version_id, course_version_item_id, user_id)',
    )
    expect(source).toContain('elearning_progress_events_session_identity_fk')
    expect(source).toContain('ON DELETE RESTRICT')
    expect(source).toContain('WHERE status = \'active\'')
    expect(source).toContain('assignment-only named pilot')
    expect(source).toContain('elearning_assignments.course_version_id must reference a published course version')
    expect(source).toContain('elearning_assignment_members cannot be inserted already revoked')
    expect(source).toContain('BEFORE INSERT OR UPDATE ON elearning_assignments')
    expect(source).not.toMatch(
      /FOREIGN KEY \(org_id, session_id\)\s+REFERENCES elearning_learning_sessions \(org_id, id\)/,
    )
    expect(source).not.toContain('scope_revision_rule_id')
    expect(source).not.toContain('elearning_scopes')
    expect(source).not.toContain('elearning_jobs')
    expect(source).not.toContain('elearning_credit')
    expect(source).not.toContain('elearning_certificate')

    const assignmentBody = plpgsqlBody(source, ASSIGNMENTS_PUBLISHED_VERSION_FN)
    expect(assignmentBody).toMatch(
      /SELECT status INTO version_status\s+FROM elearning_course_versions[\s\S]*FOR SHARE/,
    )
    expect(assignmentBody).toContain('org_id = NEW.org_id')
    expect(assignmentBody).toContain('id = NEW.course_version_id')
    expect(assignmentBody).not.toMatch(/FOR UPDATE/)
    expect(assignmentBody).toContain("TG_OP = 'UPDATE'")
    expect(assignmentBody).toContain('NEW.course_version_id IS NOT DISTINCT FROM OLD.course_version_id')

    const membersBody = plpgsqlBody(source, ASSIGNMENT_MEMBERS_PIT_FN)
    expect(membersBody).toContain("TG_OP = 'INSERT'")
    expect(membersBody).toContain('cannot be inserted already revoked')
    expect(membersBody).toContain('NEW.revoked_at IS NOT NULL')
  })

  it('declares org_id TEXT NOT NULL with no DEFAULT on every watch table', async () => {
    const source = await fs.readFile(WATCH_MIGRATION, 'utf8')
    const orgIdLines = source
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^org_id\s+/i.test(line))
    expect(orgIdLines.length).toBeGreaterThanOrEqual(ELEARNING_V01_WATCH_TABLES.length)
    for (const line of orgIdLines) {
      expect(line.toLowerCase()).toContain('text')
      expect(line.toLowerCase()).toContain('not null')
      expect(line.toLowerCase()).not.toContain('default')
    }
  })

  it('drops triggers, functions, and tables in reverse dependency order without CASCADE', async () => {
    const source = await fs.readFile(WATCH_MIGRATION, 'utf8')
    const downSource = source.split('export async function down')[1] ?? ''
    expect(downSource).not.toMatch(/\bCASCADE\b/)

    const markers = [
      'DROP TRIGGER IF EXISTS trg_elearning_completion_evidence_deny_mutation',
      'DROP FUNCTION IF EXISTS elearning_completion_evidence_deny_mutation()',
      'DROP TABLE IF EXISTS elearning_completion_evidence',
      'DROP TABLE IF EXISTS elearning_progress',
      'DROP TABLE IF EXISTS elearning_progress_events',
      'DROP INDEX IF EXISTS idx_elearning_learning_sessions_one_active_per_user_item',
      'DROP TABLE IF EXISTS elearning_learning_sessions',
      'DROP TRIGGER IF EXISTS trg_elearning_assignment_members_point_in_time',
      'DROP FUNCTION IF EXISTS elearning_assignment_members_point_in_time()',
      'DROP TABLE IF EXISTS elearning_assignment_members',
      'DROP TRIGGER IF EXISTS trg_elearning_assignments_published_version',
      'DROP FUNCTION IF EXISTS elearning_assignments_published_version()',
      'DROP TABLE IF EXISTS elearning_assignments',
    ]
    const indexes = markers.map((marker) => downSource.indexOf(marker))
    for (const [index, marker] of markers.entries()) {
      expect(indexes[index], marker).toBeGreaterThanOrEqual(0)
      if (index > 0) {
        expect(indexes[index], marker).toBeGreaterThan(indexes[index - 1])
      }
    }
  })
})

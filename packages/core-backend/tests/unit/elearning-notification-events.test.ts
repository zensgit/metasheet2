import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import {
  ElearningNotificationEventsError,
  checkElearningEventNotificationEligibility,
  collectElearningNotificationEvents,
  type ElearningNotificationEventDb,
} from '../../src/services/elearning-notification-events'

const SINCE = '2026-09-08T00:00:00.000Z'
const ORG = 'org-events'
const USER = 'user-events'
const DELIVERY = '11111111-1111-4111-8111-111111111111'
const MEMBER = '22222222-2222-4222-8222-222222222222'
const ENROLLMENT = '33333333-3333-4333-8333-333333333333'
const ATTEMPT = '44444444-4444-4444-8444-444444444444'
const VERSION = '55555555-5555-4555-8555-555555555555'
const COURSE = '66666666-6666-4666-8666-666666666666'

function marker(sql: string): string | undefined {
  return sql.match(/\/\* ([^*]+) \*\//)?.[1]
}

function result(rows: Array<Record<string, unknown>> = [], rowCount = rows.length) {
  return { rows, rowCount }
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    org_id: ORG,
    recipient_user_id: USER,
    kind: 'training_available',
    source_key: `training_available:assignment_member:${MEMBER}`,
    occurred_at: SINCE,
    assignment_member_id: MEMBER,
    enrollment_id: null,
    exam_attempt_id: null,
    ...overrides,
  }
}

describe('e-learning event notification collector', () => {
  it('defaults every capability option off and excludes persisted keys before the bounded order', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(marker(sql)).toBe('elearning-notification-events:collect')
      expect(params).toEqual([SINCE, 100, false, false, false])
      expect(sql.indexOf('WHERE NOT EXISTS')).toBeGreaterThan(sql.indexOf('FROM event_candidates candidate'))
      expect(sql.indexOf('WHERE NOT EXISTS')).toBeLessThan(sql.indexOf('LIMIT $2'))
      expect(sql).toContain('candidate.org_id ASC')
      expect(sql).toContain('delivery.org_id = candidate.org_id')
      expect(sql).toContain('delivery.source_key = candidate.source_key')
      expect(sql).toContain('app.tenant_id = candidate.org_id')
      expect(sql).toContain('app.workspace_id = candidate.org_id')
      expect(sql).toContain("app.app_id = 'elearning' AND app.plugin_id = 'plugin-elearning'")
      expect(sql).toContain("app.instance_key = 'primary' AND app.status = 'active'")
      expect(sql).toContain("app.config_json->'notificationsEnabled' = 'true'::jsonb")
      expect(sql.indexOf('FROM platform_app_instances app')).toBeLessThan(sql.indexOf('LIMIT $2'))
      return result()
    })

    await expect(collectElearningNotificationEvents(
      { query },
      { since: SINCE },
    )).resolves.toEqual({ inserted: 0 })
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('passes each independent capability gate and inserts values-free event rows', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const db: ElearningNotificationEventDb = {
      query: async (sql, params) => {
        calls.push({ sql, params })
        if (marker(sql) === 'elearning-notification-events:collect') {
          expect(params).toEqual([SINCE, 7, true, true, true])
          expect(sql).toContain('AND $3::boolean')
          expect(sql).toContain('AND $4::boolean')
          expect(sql).toContain('AND $5::boolean')
          expect(sql).toContain("attempt.status = 'graded'")
          expect(sql).toContain("course.status <> 'withdrawn'")
          return result([
            candidate(),
            candidate({
              source_key: `training_available:enrollment:${ENROLLMENT}`,
              assignment_member_id: null,
              enrollment_id: ENROLLMENT,
            }),
            candidate({
              kind: 'result_published',
              source_key: `result_published:exam_attempt:${ATTEMPT}`,
              assignment_member_id: null,
              exam_attempt_id: ATTEMPT,
            }),
          ])
        }
        expect(marker(sql)).toBe('elearning-notification-events:insert')
        expect(sql).toContain("'{}'::jsonb")
        expect(sql).toContain('ON CONFLICT (org_id, source_key) DO NOTHING')
        expect(params?.[7]).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/))
        return result([], 1)
      },
    }

    await expect(collectElearningNotificationEvents(db, {
      since: SINCE,
      limit: 7,
      assignments: true,
      enrollments: true,
      results: true,
    })).resolves.toEqual({ inserted: 3 })
    expect(calls).toHaveLength(4)
  })

  it('fresh-reads a concurrent conflict and accepts only the same hash and version', async () => {
    let expectedHash = ''
    const matchingDb: ElearningNotificationEventDb = {
      query: async (sql, params) => {
        switch (marker(sql)) {
          case 'elearning-notification-events:collect':
            return result([candidate()])
          case 'elearning-notification-events:insert':
            expectedHash = String(params?.[7])
            return result([], 0)
          case 'elearning-notification-events:load-conflict':
            expect(params).toEqual([
              ORG,
              `training_available:assignment_member:${MEMBER}`,
            ])
            return result([{ request_hash: expectedHash, request_hash_version: 1 }])
          default:
            throw new Error('unexpected query')
        }
      },
    }
    await expect(collectElearningNotificationEvents(matchingDb, {
      since: SINCE,
      assignments: true,
    })).resolves.toEqual({ inserted: 0 })

    const conflictingDb: ElearningNotificationEventDb = {
      query: async (sql) => {
        switch (marker(sql)) {
          case 'elearning-notification-events:collect':
            return result([candidate()])
          case 'elearning-notification-events:insert':
            return result([], 0)
          case 'elearning-notification-events:load-conflict':
            return result([{ request_hash: '0'.repeat(64), request_hash_version: 1 }])
          default:
            throw new Error('unexpected query')
        }
      },
    }
    await expect(collectElearningNotificationEvents(conflictingDb, {
      since: SINCE,
      assignments: true,
    })).rejects.toMatchObject<Partial<ElearningNotificationEventsError>>({
      code: 'conflict',
    })
  })

  it('requires a canonical cutoff and enforces the batch cap', async () => {
    const db = { query: vi.fn() }
    await expect(collectElearningNotificationEvents(db, { since: '' }))
      .rejects.toThrow('invalid_input')
    await expect(collectElearningNotificationEvents(db, {
      since: '2026-09-08T00:00:00Z',
    })).rejects.toThrow('invalid_input')
    await expect(collectElearningNotificationEvents(db, {
      since: SINCE,
      limit: 101,
    })).rejects.toThrow('invalid_input')
    expect(db.query).not.toHaveBeenCalled()
  })
})

describe('e-learning event notification eligibility', () => {
  it('returns false for a definitive missing, revoked, or inactive source', async () => {
    const db = { query: vi.fn(async () => result()) }
    await expect(checkElearningEventNotificationEligibility(db, {
      orgId: ORG,
      deliveryId: DELIVERY,
      recipientUserId: USER,
    })).resolves.toBe(false)
    expect(String(db.query.mock.calls[0]?.[0])).toContain('member.revoked_at IS NULL')
    expect(String(db.query.mock.calls[0]?.[0])).toContain('membership.is_active = TRUE')
    expect(String(db.query.mock.calls[0]?.[0])).toContain("attempt.status = 'graded'")
  })

  it('rechecks canonical course access and returns true only when it still resolves', async () => {
    const db: ElearningNotificationEventDb = {
      query: vi.fn(async (sql: string) => {
        switch (marker(sql)) {
          case 'elearning-notification-events:eligibility-source':
            return result([{ kind: 'training_available', course_version_id: VERSION }])
          case 'elearning-access:lock-course':
            return result([{
              course_id: COURSE,
              course_status: 'active',
              active_version_id: VERSION,
              scope_id: null,
              version_status: 'published',
            }])
          case 'elearning-access:lock-assignment':
            return result([{ id: MEMBER }])
          default:
            throw new Error('unexpected query')
        }
      }),
    }
    await expect(checkElearningEventNotificationEligibility(db, {
      orgId: ORG,
      deliveryId: DELIVERY,
      recipientUserId: USER,
    })).resolves.toBe(true)
  })

  it('returns false for canonical access denial but throws unavailable on SQL failure', async () => {
    const deniedDb: ElearningNotificationEventDb = {
      query: vi.fn(async (sql: string) => {
        if (marker(sql) === 'elearning-notification-events:eligibility-source') {
          return result([{ kind: 'result_published', course_version_id: VERSION }])
        }
        if (marker(sql) === 'elearning-access:lock-course') {
          return result([{
            course_id: COURSE,
            course_status: 'withdrawn',
            active_version_id: VERSION,
            scope_id: null,
            version_status: 'published',
          }])
        }
        throw new Error('unexpected query')
      }),
    }
    await expect(checkElearningEventNotificationEligibility(deniedDb, {
      orgId: ORG,
      deliveryId: DELIVERY,
      recipientUserId: USER,
    })).resolves.toBe(false)

    const unavailableDb: ElearningNotificationEventDb = {
      query: vi.fn(async () => {
        throw new Error('database detail')
      }),
    }
    await expect(checkElearningEventNotificationEligibility(unavailableDb, {
      orgId: ORG,
      deliveryId: DELIVERY,
      recipientUserId: USER,
    })).rejects.toMatchObject<Partial<ElearningNotificationEventsError>>({
      code: 'unavailable',
    })
  })
})

describe('e-learning event notification migration shape', () => {
  const migrationPath = fileURLToPath(new URL(
    '../../src/db/migrations/zzzz20260908170000_extend_elearning_notification_events.ts',
    import.meta.url,
  ))
  const source = readFileSync(migrationPath, 'utf8')

  it('uses affected-column, constraint, function, and trigger catalog audits', () => {
    expect(source).toContain('pg_catalog.pg_attribute')
    expect(source).toContain('pg_catalog.pg_constraint')
    expect(source).toContain('pg_catalog.pg_get_constraintdef')
    expect(source).toContain('procedure_row.prosrc AS source')
    expect(source).toContain('pg_catalog.pg_trigger')
    expect(source).toContain('trigger_row.tgtype::integer AS trigger_type')
    expect(source).toContain('trigger_row.tgfoid::text AS function_oid')
    expect(source).toContain('LOCK TABLE elearning_notification_deliveries IN ACCESS EXCLUSIVE MODE')
    expect(source).toContain("assertAffectedCatalogShape(db, 'before')")
    expect(source).toContain("assertAffectedCatalogShape(db, 'after')")
  })

  it('pins the closed basis matrix, same-org FKs, immutable IDs, and refusing down', () => {
    expect(source).toContain("kind = 'assignment_reminder'")
    expect(source).toContain("kind = 'training_available'")
    expect(source).toContain("kind = 'result_published'")
    expect(source).toContain('num_nonnulls(assignment_member_id, enrollment_id) = 1')
    expect(source).toContain('FOREIGN KEY (org_id, enrollment_id)')
    expect(source).toContain('FOREIGN KEY (org_id, exam_attempt_id)')
    expect(source).toContain('NEW.enrollment_id IS DISTINCT FROM OLD.enrollment_id')
    expect(source).toContain('NEW.exam_attempt_id IS DISTINCT FROM OLD.exam_attempt_id')
    expect(source).toContain('migration down refused: new event rows exist')
  })
})

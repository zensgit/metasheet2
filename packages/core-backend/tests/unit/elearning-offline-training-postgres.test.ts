import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { ElearningOfflineError, hashElearningOfflineRequest } from '../../src/services/elearning-offline-training'
import {
  issueElearningOfflineQr,
  listMyElearningOfflineTrainings,
  publishElearningOfflineTraining,
  recordElearningOfflineAttendance,
  type ElearningOfflineDb,
} from '../../src/services/elearning-offline-training-postgres'

const ORG = 'offline-org'
const ACTOR = randomUUID()
const MEMBER = randomUUID()
const REQUEST = randomUUID()
const TRAINING = randomUUID()
const REVISION = randomUUID()
const TARGET = randomUUID()
const EVENT = randomUUID()
const SECRET = 'offline-postgres-test-secret-with-at-least-thirty-two-bytes'

function publishCommand(overrides: Record<string, unknown> = {}) {
  return {
    requestId: REQUEST,
    title: 'Training',
    location: 'Room',
    attendanceMode: 'training',
    targets: [{
      title: 'Session',
      startsAt: '2026-09-01T09:00:00.000Z',
      endsAt: '2026-09-01T10:00:00.000Z',
      checkInOpensAt: '2026-09-01T08:45:00.000Z',
      checkInClosesAt: '2026-09-01T09:15:00.000Z',
      checkOutOpensAt: '2026-09-01T09:45:00.000Z',
      checkOutClosesAt: '2026-09-01T10:15:00.000Z',
    }],
    memberUserIds: [MEMBER],
    ...overrides,
  }
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Training',
    location: 'Room',
    attendance_mode: 'training',
    created_at: new Date('2026-09-01T00:00:00.000Z'),
    member_count: 1,
    target_id: TARGET,
    position: 1,
    starts_at: new Date('2026-09-01T09:00:00.000Z'),
    ends_at: new Date('2026-09-01T10:00:00.000Z'),
    check_in_opens_at: new Date('2026-09-01T08:45:00.000Z'),
    check_in_closes_at: new Date('2026-09-01T09:15:00.000Z'),
    check_out_opens_at: new Date('2026-09-01T09:45:00.000Z'),
    check_out_closes_at: new Date('2026-09-01T10:15:00.000Z'),
    ...overrides,
  }
}

function db(handler: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>) {
  const statements: string[] = []
  const query = async (sql: string, params: unknown[] = []) => {
    statements.push(sql)
    const rows = await handler(sql, params)
    return { rows, rowCount: rows.length }
  }
  const value: ElearningOfflineDb = {
    query,
    transaction: async (run) => run({ query }),
  }
  return { value, statements }
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ElearningOfflineError)
  expect((error as ElearningOfflineError).code).toBe(code)
  expect((error as Error).message).toBe(code)
}

describe('e-learning offline training PostgreSQL authority', () => {
  it('publishes revision, ordered targets and member snapshot in one transaction', async () => {
    const store = db(async (sql) => {
      if (sql.includes('elearning-offline:active-user')) return [{ ok: 1 }]
      if (sql.includes('elearning-offline:members')) return [{ user_id: MEMBER }]
      if (sql.includes('elearning-offline:publish-result')) return [row()]
      if (sql.includes('elearning-offline:publish-targets')) return [row({ title: 'Session' })]
      return []
    })
    const result = await publishElearningOfflineTraining(store.value, {
      orgId: ORG,
      actorId: ACTOR,
      command: publishCommand(),
    })
    expect(result).toEqual({
      trainingId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      revisionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      title: 'Training',
      location: 'Room',
      attendanceMode: 'training',
      targets: [expect.objectContaining({ targetId: TARGET, position: 1, title: 'Session' })],
      memberCount: 1,
      createdAt: '2026-09-01T00:00:00.000Z',
      duplicate: false,
    })
    expect(store.statements.filter((sql) => sql.includes('INSERT INTO elearning_offline_training_revisions'))).toHaveLength(1)
    expect(store.statements.filter((sql) => sql.includes('INSERT INTO elearning_offline_training_targets'))).toHaveLength(1)
    expect(store.statements.filter((sql) => sql.includes('INSERT INTO elearning_offline_training_members'))).toHaveLength(1)
    expect(store.statements.filter((sql) => sql.includes('INSERT INTO elearning_offline_publish_requests'))).toHaveLength(1)
  })

  it('replays the same publish result and rejects a different payload values-free', async () => {
    const command = publishCommand()
    const { requestId: _requestId, ...payload } = command
    const requestHash = hashElearningOfflineRequest('publish', payload)
    const store = db(async (sql) => {
      if (sql.includes('elearning-offline:active-user')) return [{ ok: 1 }]
      if (sql.includes('FROM elearning_offline_publish_requests')) return [{
        request_hash: requestHash,
        request_hash_version: 1,
        training_id: TRAINING,
        revision_id: REVISION,
      }]
      if (sql.includes('elearning-offline:publish-result')) return [row()]
      if (sql.includes('elearning-offline:publish-targets')) return [row()]
      return []
    })
    const replay = await publishElearningOfflineTraining(store.value, {
      orgId: ORG,
      actorId: ACTOR,
      command,
    })
    expect(replay).toMatchObject({ trainingId: TRAINING, revisionId: REVISION, duplicate: true })
    await expect(publishElearningOfflineTraining(store.value, {
      orgId: ORG,
      actorId: ACTOR,
      command: publishCommand({ title: 'Changed' }),
    })).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'conflict')
      return true
    })
    expect(store.statements.some((sql) => sql.includes('INSERT INTO elearning_offline_training_revisions'))).toBe(false)
  })

  it.each([
    {},
    { ELEARNING_OFFLINE_QR_SIGNING_SECRET: 'too-short' },
  ])('fails QR issuance before SQL when the signing secret is unavailable %#', async (env) => {
    const store = db(async () => [])
    await expect(issueElearningOfflineQr(store.value, {
      orgId: ORG,
      actorId: ACTOR,
      command: {
        requestId: REQUEST,
        trainingId: TRAINING,
        targetId: TARGET,
        action: 'check_in',
      },
    }, env)).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'unavailable')
      return true
    })
    expect(store.statements).toEqual([])
  })

  it('locks the QR effect identity before rotating an active challenge', async () => {
    const store = db(async (sql) => {
      if (sql.includes('elearning-offline:active-user')) return [{ ok: 1 }]
      if (sql.includes('FROM elearning_offline_trainings training')) return [{ revision_id: REVISION }]
      if (sql.includes('clock_timestamp')) return [{ now: new Date('2026-09-01T09:00:00.000Z') }]
      return []
    })
    const result = await issueElearningOfflineQr(store.value, {
      orgId: ORG,
      actorId: ACTOR,
      command: {
        requestId: REQUEST,
        trainingId: TRAINING,
        targetId: TARGET,
        action: 'check_in',
      },
    }, { ELEARNING_OFFLINE_QR_SIGNING_SECRET: SECRET })
    expect(result).toMatchObject({
      trainingId: TRAINING,
      revisionId: REVISION,
      targetId: TARGET,
      action: 'check_in',
      duplicate: false,
    })
    const locks = store.statements
      .map((sql, index) => ({ index, sql }))
      .filter(({ sql }) => sql.includes('pg_advisory_xact_lock'))
    const rotation = store.statements.findIndex((sql) => sql.includes('UPDATE elearning_offline_qr_challenges'))
    expect(locks).toHaveLength(2)
    expect(rotation).toBeGreaterThan(locks[1]!.index)
  })

  it('does not re-sign a superseded challenge during request replay', async () => {
    const requestHash = hashElearningOfflineRequest('qr-issue', {
      action: 'check_in',
      targetId: TARGET,
      trainingId: TRAINING,
    })
    const store = db(async (sql) => {
      if (sql.includes('elearning-offline:active-user')) return [{ ok: 1 }]
      if (sql.includes('FROM elearning_offline_qr_requests')) return [{
        request_hash: requestHash,
        request_hash_version: 1,
        challenge_id: EVENT,
      }]
      if (sql.includes('FROM elearning_offline_qr_challenges')) return [{
        challenge_id: EVENT,
        training_id: TRAINING,
        revision_id: REVISION,
        target_id: TARGET,
        action: 'check_in',
        issued_at: new Date('2026-09-01T09:00:00.000Z'),
        expires_at: new Date('2026-09-01T09:01:00.000Z'),
        superseded_at: new Date('2026-09-01T09:00:30.000Z'),
      }]
      return []
    })
    await expect(issueElearningOfflineQr(store.value, {
      orgId: ORG,
      actorId: ACTOR,
      command: {
        requestId: REQUEST,
        trainingId: TRAINING,
        targetId: TARGET,
        action: 'check_in',
      },
    }, { ELEARNING_OFFLINE_QR_SIGNING_SECRET: SECRET })).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'conflict')
      return true
    })
  })

  it('replays a recorded effect before current token expiry checks', async () => {
    const token = 'already-expired-but-never-returned-in-errors'
    const tokenDigest = hashElearningOfflineRequest('irrelevant', {})
    const requestHash = hashElearningOfflineRequest('attendance', {
      tokenDigest: await import('node:crypto').then(({ createHash }) => (
        createHash('sha256').update(token).digest('hex')
      )),
    })
    expect(tokenDigest).toMatch(/^[0-9a-f]{64}$/)
    const store = db(async (sql) => {
      if (sql.includes('elearning-offline:active-user')) return [{ ok: 1 }]
      if (sql.includes('FROM elearning_offline_attendance_requests')) return [{
        request_hash: requestHash,
        request_hash_version: 1,
        event_id: EVENT,
      }]
      if (sql.includes('FROM elearning_offline_attendance_events event')) return [{
        event_id: EVENT,
        training_id: TRAINING,
        revision_id: REVISION,
        target_id: TARGET,
        action: 'check_out',
        occurred_at: new Date('2026-09-01T10:00:00.000Z'),
        total_target_count: 1,
        completed_target_count: 1,
      }]
      return []
    })
    const replay = await recordElearningOfflineAttendance(store.value, {
      orgId: ORG,
      userId: MEMBER,
      command: { requestId: REQUEST, token },
    }, { ELEARNING_OFFLINE_QR_SIGNING_SECRET: SECRET })
    expect(replay).toEqual({
      eventId: EVENT,
      trainingId: TRAINING,
      revisionId: REVISION,
      targetId: TARGET,
      action: 'check_out',
      occurredAt: '2026-09-01T10:00:00.000Z',
      targetStatus: 'checked_out',
      completionStatus: 'completed',
      completedTargetCount: 1,
      totalTargetCount: 1,
      duplicate: true,
    })
    expect(store.statements.some((sql) => sql.includes('clock_timestamp'))).toBe(false)
  })

  it('rechecks current organization membership before serving a replay', async () => {
    const store = db(async (sql) => {
      if (sql.includes('elearning-offline:active-user')) return []
      if (sql.includes('FROM elearning_offline_publish_requests')) return [{
        request_hash: '0'.repeat(64),
        request_hash_version: 1,
        training_id: TRAINING,
        revision_id: REVISION,
      }]
      return []
    })
    await expect(publishElearningOfflineTraining(store.value, {
      orgId: ORG,
      actorId: ACTOR,
      command: publishCommand(),
    })).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'forbidden')
      return true
    })
    expect(store.statements.some((sql) => sql.includes('FROM elearning_offline_publish_requests')))
      .toBe(false)
  })

  it('parses ordered learner targets without leaking challenge or token fields', async () => {
    const store = db(async () => [row({
      training_id: TRAINING,
      revision_id: REVISION,
      training_title: 'Training',
      status: 'active',
      checked_in_at: new Date('2026-09-01T09:00:00.000Z'),
      checked_out_at: null,
    })])
    const result = await listMyElearningOfflineTrainings(store.value, { orgId: ORG, userId: MEMBER })
    expect(result).toEqual([{
      trainingId: TRAINING,
      revisionId: REVISION,
      title: 'Training',
      location: 'Room',
      attendanceMode: 'training',
      status: 'active',
      completionStatus: 'in_progress',
      targets: [expect.objectContaining({
        targetId: TARGET,
        attendanceStatus: 'checked_in',
        checkedInAt: '2026-09-01T09:00:00.000Z',
        checkedOutAt: null,
      })],
    }])
    expect(JSON.stringify(result)).not.toMatch(/token|digest|challenge/i)
  })
})

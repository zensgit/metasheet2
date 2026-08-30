import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { isElearningWatchSurfaceEnabled } from '../../src/elearning/feature-flags'
import {
  ELEARNING_WATCH_DIGEST_DOMAIN,
  ELEARNING_WATCH_EVALUATOR_VERSION,
  ELEARNING_WATCH_POLICY_VERSION,
  ELEARNING_WATCH_THRESHOLD_BPS,
  computeElearningWatchCredit,
  elearningWatchCompletionThresholdMs,
  elearningWatchLockKey,
  ElearningWatchError,
  recordElearningHeartbeat,
  rollElearningWatchEventDigest,
  startElearningWatch,
  type ElearningWatchDb,
  type ElearningWatchQueryable,
} from '../../src/services/elearning-watch-progress'

const ORG = 'org-watch-1'
const USER = 'user-watch-1'
const ITEM = '11111111-1111-4111-8111-111111111111'
const VERSION = '22222222-2222-4222-8222-222222222222'
const COURSE = '77777777-7777-4777-8777-777777777777'
const MEMBER = '33333333-3333-4333-8333-333333333333'
const MEMBER_B = '66666666-6666-4666-8666-666666666666'
const MEDIA = '44444444-4444-4444-8444-444444444444'
const SESSION = '55555555-5555-4555-8555-555555555555'
const SCOPE = '88888888-8888-4888-8888-888888888888'
const SCOPE_REVISION = '99999999-9999-4999-8999-999999999999'
const SCOPE_RULE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const LOOKALIKES: Array<string | undefined> = [
  undefined,
  '',
  'false',
  'FALSE',
  '0',
  '1',
  'yes',
  'on',
  'TRUE',
  'True',
  ' true',
  'true ',
  ' true ',
]

const ALL_ON = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_CONTENT_ENABLED: 'true',
  ELEARNING_ASSIGNMENT_ENABLED: 'true',
  ELEARNING_MEDIA_ENABLED: 'true',
} as NodeJS.ProcessEnv

interface ItemRow {
  id: string
  versionId: string
  itemType: string
  policyVersion: string
  thresholdBps: number
  mediaId: string
  versionStatus: string
  courseStatus: string
  mediaStatus: string
  durationMs: number
  courseId?: string
  activeVersionId?: string | null
  scopeId?: string | null
  scopeRevisionId?: string | null
  scopeRuleId?: string | null
  scopeSubjectType?: 'all' | 'user'
  scopeSubjectRef?: string | null
}

interface MemberRow {
  id: string
  userId: string
  versionId: string
  revokedAt: string | null
}

interface SessionRow {
  id: string
  memberId: string | null
  scopeRuleId: string | null
  versionId: string
  itemId: string
  userId: string
  status: string
  lastSequence: number
  lastClientPositionMs: number
  effectiveMs: number
  maxPositionMs: number
  rollingEventDigest: string
  lastEventAt: number
  closedAt: number | null
}

interface EventRow {
  sessionId: string
  sequence: number
  kind: string
  reportedPositionMs: number
  playing: boolean
  creditedMs: number
  eventDigest: string
}

interface ProgressRow {
  id: string
  memberId: string | null
  scopeRuleId: string | null
  versionId: string
  itemId: string
  userId: string
  status: 'in_progress' | 'completed'
  effectiveMs: number
  maxPositionMs: number
  completedAt: number | null
  required: boolean
}

interface EvidenceRow {
  memberId: string | null
  scopeRuleId: string | null
  versionId: string
  itemId: string
  policyVersion: string
  thresholdBps: number
  durationMs: number
  effectiveMs: number
  maxPositionMs: number
  eventDigest: string
  evaluatorVersion: string
}

interface Mem {
  now: number
  item: ItemRow | null
  members: MemberRow[]
  sessions: SessionRow[]
  events: EventRow[]
  progress: ProgressRow[]
  evidence: EvidenceRow[]
  queries: string[]
}

function tagOf(sql: string): string | null {
  const match = /\/\* (elearning-(?:watch|access|audience):[a-z-]+) \*\//.exec(sql)
  return match ? match[1] : null
}

function createMemoryDb(seed: Partial<Mem> = {}): { db: ElearningWatchDb; mem: Mem } {
  const mem: Mem = {
    now: 1_000_000,
    item: {
      id: ITEM,
      versionId: VERSION,
      itemType: 'video',
      policyVersion: ELEARNING_WATCH_POLICY_VERSION,
      thresholdBps: ELEARNING_WATCH_THRESHOLD_BPS,
      mediaId: MEDIA,
      versionStatus: 'published',
      courseStatus: 'active',
      mediaStatus: 'ready',
      durationMs: 10_000,
    },
    members: [{ id: MEMBER, userId: USER, versionId: VERSION, revokedAt: null }],
    sessions: [],
    events: [],
    progress: [],
    evidence: [],
    queries: [],
    ...seed,
  }
  if (seed.item !== undefined) mem.item = seed.item
  if (seed.members) mem.members = seed.members
  if (seed.sessions) mem.sessions = seed.sessions
  if (seed.events) mem.events = seed.events
  if (seed.progress) mem.progress = seed.progress
  if (seed.evidence) mem.evidence = seed.evidence

  let lockTail = Promise.resolve()
  const query = async (sql: string, params: unknown[] = []) => {
    mem.queries.push(sql)
    const tag = tagOf(sql)
    const item = mem.item
    if (tag === 'elearning-watch:lock') {
      expect(sql).toContain('pg_advisory_xact_lock')
      expect(params[0]).toBe(elearningWatchLockKey(ORG, USER, ITEM))
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-watch:lock-course') {
      expect(sql).toContain('FOR SHARE OF c')
      if (!item || item.id !== params[1]) return { rows: [], rowCount: 0 }
      return { rows: [{ status: item.courseStatus }], rowCount: 1 }
    }
    if (tag === 'elearning-watch:load-item') {
      expect(sql).toContain('FOR SHARE OF c')
      if (!item || item.id !== params[1]) return { rows: [], rowCount: 0 }
      return {
        rows: [{
          id: item.id,
          course_version_id: item.versionId,
          item_type: item.itemType,
          completion_policy_version: item.policyVersion,
          completion_threshold_bps: item.thresholdBps,
          media_id: item.mediaId,
          version_status: item.versionStatus,
          course_status: item.courseStatus,
          media_status: item.mediaStatus,
          duration_ms: String(item.durationMs),
        }],
        rowCount: 1,
      }
    }
    if (tag === 'elearning-access:lock-course') {
      if (!item || item.versionId !== params[1]) return { rows: [], rowCount: 0 }
      return {
        rows: [{
          course_id: item.courseId ?? COURSE,
          course_status: item.courseStatus,
          active_version_id: item.activeVersionId === undefined
            ? item.versionId
            : item.activeVersionId,
          scope_id: item.scopeId ?? null,
          version_status: item.versionStatus,
        }],
        rowCount: 1,
      }
    }
    if (tag === 'elearning-access:lock-assignment') {
      const rows = mem.members
        .filter((m) => m.userId === params[1] && m.versionId === params[2] && m.revokedAt === null)
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, 1)
        .map((m) => ({ id: m.id }))
      return { rows, rowCount: rows.length }
    }
    if (tag === 'elearning-access:lock-scope') {
      if (!item || item.scopeId !== params[1] || item.scopeRevisionId == null) {
        return { rows: [], rowCount: 0 }
      }
      return { rows: [{ active_revision_id: item.scopeRevisionId }], rowCount: 1 }
    }
    if (tag === 'elearning-audience:load-revision-rules') {
      if (!item || item.scopeRuleId == null || item.scopeRevisionId !== params[1]) {
        return { rows: [], rowCount: 0 }
      }
      return {
        rows: [{
          rule_id: item.scopeRuleId,
          scope_revision_id: item.scopeRevisionId,
          subject_type: item.scopeSubjectType,
          subject_ref: item.scopeSubjectRef,
          include_children: false,
        }],
        rowCount: 1,
      }
    }
    if (tag === 'elearning-audience:lock-principal') {
      return { rows: [{ id: USER }], rowCount: 1 }
    }
    if (tag === 'elearning-audience:resolve-membership') {
      if (!item || params[0] !== ORG || typeof params[1] !== 'string') {
        return { rows: [], rowCount: 0 }
      }
      const rules = JSON.parse(params[1]) as Array<Record<string, unknown>>
      const rows = rules.flatMap((rule) => {
        const matches = rule.subject_type === 'all'
          || (rule.subject_type === 'user' && rule.subject_ref === USER)
        return matches ? [{ rule_key: rule.rule_key, user_id: USER }] : []
      })
      return { rows, rowCount: rows.length }
    }
    if (tag === 'elearning-watch:load-progress') {
      const row = mem.progress.find((p) => p.userId === params[1] && p.itemId === params[2])
      if (!row) return { rows: [], rowCount: 0 }
      return {
        rows: [{
          id: row.id,
          status: row.status,
          effective_ms: String(row.effectiveMs),
          max_position_ms: String(row.maxPositionMs),
        }],
        rowCount: 1,
      }
    }
    if (tag === 'elearning-watch:load-active-session') {
      const row = mem.sessions.find(
        (s) => s.userId === params[1] && s.itemId === params[2] && s.status === 'active',
      )
      if (!row) return { rows: [], rowCount: 0 }
      return {
        rows: [sessionQueryRow(row)],
        rowCount: 1,
      }
    }
    if (tag === 'elearning-watch:peek-session') {
      const row = mem.sessions.find((s) => s.id === params[1])
      if (!row) return { rows: [], rowCount: 0 }
      return {
        rows: [{ user_id: row.userId, course_version_item_id: row.itemId }],
        rowCount: 1,
      }
    }
    if (tag === 'elearning-watch:lock-session') {
      expect(sql).toContain('FOR SHARE OF c')
      const row = mem.sessions.find((s) => s.id === params[1])
      if (!row || !item) return { rows: [], rowCount: 0 }
      const elapsed = Math.max(0, mem.now - row.lastEventAt)
      return {
        rows: [{
          ...sessionQueryRow(row),
          user_id: row.userId,
          item_type: item.itemType,
          completion_policy_version: item.policyVersion,
          completion_threshold_bps: item.thresholdBps,
          version_status: item.versionStatus,
          course_status: item.courseStatus,
          media_status: item.mediaStatus,
          duration_ms: String(item.durationMs),
          elapsed_ms: String(elapsed),
        }],
        rowCount: 1,
      }
    }
    if (tag === 'elearning-watch:load-event') {
      const row = mem.events.find(
        (e) => e.sessionId === params[1] && e.sequence === Number(params[2]),
      )
      if (!row) return { rows: [], rowCount: 0 }
      return {
        rows: [{
          reported_position_ms: String(row.reportedPositionMs),
          playing: row.playing,
        }],
        rowCount: 1,
      }
    }
    if (tag === 'elearning-watch:insert-session') {
      mem.sessions.push({
        id: String(params[0]),
        memberId: params[2] == null ? null : String(params[2]),
        scopeRuleId: params[3] == null ? null : String(params[3]),
        versionId: String(params[4]),
        itemId: String(params[5]),
        userId: String(params[6]),
        status: 'active',
        lastSequence: 0,
        lastClientPositionMs: 0,
        effectiveMs: 0,
        maxPositionMs: 0,
        rollingEventDigest: String(params[7]),
        lastEventAt: mem.now,
        closedAt: null,
      })
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-watch:insert-event') {
      const isStart = sql.includes("'start'")
      mem.events.push({
        sessionId: String(params[1]),
        sequence: isStart ? 0 : Number(params[5]),
        kind: isStart ? 'start' : 'heartbeat',
        reportedPositionMs: isStart ? 0 : Number(params[6]),
        playing: isStart ? false : Boolean(params[7]),
        creditedMs: isStart ? 0 : Number(params[8]),
        eventDigest: String(isStart ? params[5] : params[9]),
      })
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-watch:insert-progress') {
      mem.progress.push({
        id: 'progress-1',
        memberId: params[1] == null ? null : String(params[1]),
        scopeRuleId: params[2] == null ? null : String(params[2]),
        versionId: String(params[3]),
        itemId: String(params[4]),
        userId: String(params[5]),
        status: 'in_progress',
        effectiveMs: 0,
        maxPositionMs: 0,
        completedAt: null,
        required: Boolean(params[6]),
      })
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-watch:update-session') {
      const row = mem.sessions.find((s) => s.id === params[6] && s.status === 'active')
      if (!row) return { rows: [], rowCount: 0 }
      row.lastSequence = Number(params[0])
      row.lastClientPositionMs = Number(params[1])
      row.effectiveMs = Number(params[2])
      row.maxPositionMs = Number(params[3])
      row.rollingEventDigest = String(params[4])
      row.lastEventAt = mem.now
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-watch:update-progress') {
      const row = mem.progress.find(
        (p) => p.userId === params[3] && p.itemId === params[4] && p.status === 'in_progress',
      )
      if (!row) return { rows: [], rowCount: 0 }
      row.effectiveMs = Number(params[0])
      row.maxPositionMs = Number(params[1])
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-watch:insert-evidence') {
      expect(sql).toMatch(/course_version_item_id,\s+user_id,\s+item_type,/)
      expect(sql).toMatch(/\$5,\s+\$6,\s+'video',\s+\$7/)
      mem.evidence.push({
        memberId: params[1] == null ? null : String(params[1]),
        scopeRuleId: params[2] == null ? null : String(params[2]),
        versionId: String(params[3]),
        itemId: String(params[4]),
        policyVersion: String(params[6]),
        thresholdBps: Number(params[7]),
        durationMs: Number(params[8]),
        effectiveMs: Number(params[9]),
        maxPositionMs: Number(params[10]),
        eventDigest: String(params[11]),
        evaluatorVersion: String(params[12]),
      })
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-watch:complete-progress') {
      const row = mem.progress.find(
        (p) => p.userId === params[2] && p.itemId === params[3] && p.status === 'in_progress',
      )
      if (!row) return { rows: [], rowCount: 0 }
      row.status = 'completed'
      row.completedAt = mem.now
      row.required = Boolean(params[0])
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-watch:close-session') {
      const row = mem.sessions.find((s) => s.id === params[1] && s.status === 'active')
      if (!row) return { rows: [], rowCount: 0 }
      row.status = 'completed'
      row.closedAt = mem.now
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-watch:rebind-session-access') {
      const row = mem.sessions.find((s) => s.id === params[3] && s.status === 'active')
      if (!row) return { rows: [], rowCount: 0 }
      row.memberId = params[0] == null ? null : String(params[0])
      row.scopeRuleId = params[1] == null ? null : String(params[1])
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-watch:rebind-progress') {
      const row = mem.progress.find(
        (p) => p.userId === params[4] && p.itemId === params[5] && p.status === 'in_progress',
      )
      if (!row) return { rows: [], rowCount: 0 }
      row.memberId = params[0] == null ? null : String(params[0])
      row.scopeRuleId = params[1] == null ? null : String(params[1])
      row.required = Boolean(params[2])
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected query: ${sql}`)
  }

  const runTx = async <T>(handler: (tx: ElearningWatchQueryable) => Promise<T>): Promise<T> => {
    const prev = lockTail
    let release!: () => void
    lockTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await prev
    try {
      return await handler({ query })
    } finally {
      release()
    }
  }

  return {
    mem,
    db: { query, transaction: runTx },
  }
}

function sessionQueryRow(row: SessionRow): Record<string, unknown> {
  return {
    id: row.id,
    assignment_member_id: row.memberId,
    scope_revision_rule_id: row.scopeRuleId,
    course_version_id: row.versionId,
    course_version_item_id: row.itemId,
    status: row.status,
    last_sequence: row.lastSequence,
    last_client_position_ms: String(row.lastClientPositionMs),
    effective_ms: String(row.effectiveMs),
    max_position_ms: String(row.maxPositionMs),
    rolling_event_digest: row.rollingEventDigest,
  }
}

function seededSession(over: Partial<SessionRow> = {}): SessionRow {
  const startDigest = rollElearningWatchEventDigest('', {
    sequence: 0,
    kind: 'start',
    reportedPositionMs: 0,
    playing: false,
    creditedMs: 0,
  })
  return {
    id: SESSION,
    memberId: MEMBER,
    scopeRuleId: null,
    versionId: VERSION,
    itemId: ITEM,
    userId: USER,
    status: 'active',
    lastSequence: 0,
    lastClientPositionMs: 0,
    effectiveMs: 0,
    maxPositionMs: 0,
    rollingEventDigest: startDigest,
    lastEventAt: 1_000_000,
    closedAt: null,
    ...over,
  }
}

function seededEvent(over: Partial<EventRow> = {}): EventRow {
  return {
    sessionId: SESSION,
    sequence: 0,
    kind: 'start',
    reportedPositionMs: 0,
    playing: false,
    creditedMs: 0,
    eventDigest: seededSession().rollingEventDigest,
    ...over,
  }
}

function seededProgress(over: Partial<ProgressRow> = {}): ProgressRow {
  return {
    id: 'progress-1',
    memberId: MEMBER,
    scopeRuleId: null,
    versionId: VERSION,
    itemId: ITEM,
    userId: USER,
    status: 'in_progress',
    effectiveMs: 0,
    maxPositionMs: 0,
    completedAt: null,
    required: true,
    ...over,
  }
}

function scopeVisibleItem(over: Partial<ItemRow> = {}): ItemRow {
  return {
    id: ITEM,
    versionId: VERSION,
    itemType: 'video',
    policyVersion: ELEARNING_WATCH_POLICY_VERSION,
    thresholdBps: ELEARNING_WATCH_THRESHOLD_BPS,
    mediaId: MEDIA,
    versionStatus: 'published',
    courseStatus: 'active',
    mediaStatus: 'ready',
    durationMs: 10_000,
    courseId: COURSE,
    activeVersionId: VERSION,
    scopeId: SCOPE,
    scopeRevisionId: SCOPE_REVISION,
    scopeRuleId: SCOPE_RULE,
    scopeSubjectType: 'all',
    scopeSubjectRef: null,
    ...over,
  }
}

function assertValuesFree(error: unknown): void {
  expect(error).toBeInstanceOf(ElearningWatchError)
  const err = error as ElearningWatchError
  const blob = `${err.message}\n${err.stack ?? ''}\n${JSON.stringify(err)}`
  expect(blob).not.toContain(ORG)
  expect(blob).not.toContain(USER)
  expect(blob).not.toContain('answer_key')
  expect(blob).not.toContain('storage_key')
  expect(blob).not.toMatch(/elearning-media\//)
  expect(blob).not.toContain(ELEARNING_WATCH_DIGEST_DOMAIN)
}

describe('isElearningWatchSurfaceEnabled', () => {
  it('requires exact true for master + content + media but not assignment', () => {
    expect(isElearningWatchSurfaceEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    expect(isElearningWatchSurfaceEnabled(ALL_ON)).toBe(true)
    expect(isElearningWatchSurfaceEnabled({
      ...ALL_ON,
      ELEARNING_ASSESSMENT_ENABLED: 'false',
    } as NodeJS.ProcessEnv)).toBe(true)
    for (const value of LOOKALIKES) {
      expect(isElearningWatchSurfaceEnabled({
        ...ALL_ON,
        ELEARNING_ENABLED: value,
      } as NodeJS.ProcessEnv)).toBe(false)
      expect(isElearningWatchSurfaceEnabled({
        ...ALL_ON,
        ELEARNING_CONTENT_ENABLED: value,
      } as NodeJS.ProcessEnv)).toBe(false)
      expect(isElearningWatchSurfaceEnabled({
        ...ALL_ON,
        ELEARNING_ASSIGNMENT_ENABLED: value,
      } as NodeJS.ProcessEnv)).toBe(true)
      expect(isElearningWatchSurfaceEnabled({
        ...ALL_ON,
        ELEARNING_MEDIA_ENABLED: value,
      } as NodeJS.ProcessEnv)).toBe(false)
    }
  })
})

describe('watch credit and digest', () => {
  it('uses a versioned domain prefix for the rolling SHA-256 digest', () => {
    const digest = rollElearningWatchEventDigest('', {
      sequence: 0,
      kind: 'start',
      reportedPositionMs: 0,
      playing: false,
      creditedMs: 0,
    })
    const expected = createHash('sha256')
      .update(
        [
          ELEARNING_WATCH_DIGEST_DOMAIN,
          '',
          '0',
          'start',
          '0',
          '0',
          '0',
        ].join('\n'),
        'utf8',
      )
      .digest('hex')
    expect(digest).toBe(expected)
    expect(ELEARNING_WATCH_DIGEST_DOMAIN).toBe('elearning.watch.event.v1')
  })

  it('credits only novel forward movement, clamps elapsed to 30s and playback to 2x, and pauses to zero without advancing trusted max', () => {
    expect(computeElearningWatchCredit({
      playing: false,
      reportedPositionMs: 8_000,
      durationMs: 10_000,
      priorMaxPositionMs: 1_000,
      priorLastClientPositionMs: 1_000,
      elapsedMs: 5_000,
    })).toEqual({ clampedPositionMs: 8_000, creditedMs: 0, maxPositionMs: 1_000 })

    expect(computeElearningWatchCredit({
      playing: false,
      reportedPositionMs: 10_000,
      durationMs: 10_000,
      priorMaxPositionMs: 0,
      priorLastClientPositionMs: 0,
      elapsedMs: 5_000,
    })).toEqual({ clampedPositionMs: 10_000, creditedMs: 0, maxPositionMs: 0 })

    expect(computeElearningWatchCredit({
      playing: true,
      reportedPositionMs: 50_000,
      durationMs: 10_000,
      priorMaxPositionMs: 0,
      priorLastClientPositionMs: 0,
      elapsedMs: 1_000,
    })).toEqual({ clampedPositionMs: 10_000, creditedMs: 2_000, maxPositionMs: 2_000 })

    expect(computeElearningWatchCredit({
      playing: true,
      reportedPositionMs: 120_000,
      durationMs: 120_000,
      priorMaxPositionMs: 0,
      priorLastClientPositionMs: 0,
      elapsedMs: 120_000,
    })).toEqual({ clampedPositionMs: 120_000, creditedMs: 60_000, maxPositionMs: 60_000 })

    expect(elearningWatchCompletionThresholdMs(10_000)).toBe(9_000)
    expect(elearningWatchCompletionThresholdMs(60_000, 9_000)).toBe(54_000)
    expect(elearningWatchCompletionThresholdMs(0)).toBe(0)
    expect(elearningWatchCompletionThresholdMs(1)).toBe(1)
  })

  it('does not credit an unchanged position even when wall-clock elapsed is large', () => {
    expect(computeElearningWatchCredit({
      playing: true,
      reportedPositionMs: 8_000,
      durationMs: 10_000,
      priorMaxPositionMs: 2_000,
      priorLastClientPositionMs: 8_000,
      elapsedMs: 30_000,
    })).toEqual({ clampedPositionMs: 8_000, creditedMs: 0, maxPositionMs: 2_000 })
  })

  it('resumes credit after rewind without double-crediting the trusted frontier', () => {
    expect(computeElearningWatchCredit({
      playing: true,
      reportedPositionMs: 0,
      durationMs: 10_000,
      priorMaxPositionMs: 4_000,
      priorLastClientPositionMs: 8_000,
      elapsedMs: 1_000,
    })).toEqual({ clampedPositionMs: 0, creditedMs: 0, maxPositionMs: 4_000 })

    expect(computeElearningWatchCredit({
      playing: true,
      reportedPositionMs: 4_000,
      durationMs: 10_000,
      priorMaxPositionMs: 4_000,
      priorLastClientPositionMs: 0,
      elapsedMs: 5_000,
    })).toEqual({ clampedPositionMs: 4_000, creditedMs: 0, maxPositionMs: 4_000 })

    expect(computeElearningWatchCredit({
      playing: true,
      reportedPositionMs: 6_000,
      durationMs: 10_000,
      priorMaxPositionMs: 4_000,
      priorLastClientPositionMs: 4_000,
      elapsedMs: 2_000,
    })).toEqual({ clampedPositionMs: 6_000, creditedMs: 2_000, maxPositionMs: 6_000 })
  })

  it('computes ceil(duration*bps/10000) with BigInt so MAX_SAFE_INTEGER is exact, not off by 1', () => {
    const duration = Number.MAX_SAFE_INTEGER
    const jsNumber = Math.trunc((duration * ELEARNING_WATCH_THRESHOLD_BPS + 9999) / 10000)
    const exact = Number(
      (BigInt(duration) * BigInt(ELEARNING_WATCH_THRESHOLD_BPS) + 9999n) / 10000n,
    )
    expect(jsNumber).not.toBe(exact)
    expect(elearningWatchCompletionThresholdMs(duration)).toBe(exact)
    expect(Number.isSafeInteger(elearningWatchCompletionThresholdMs(duration))).toBe(true)

    expect(() => elearningWatchCompletionThresholdMs(-1)).toThrow(ElearningWatchError)
    expect(() => elearningWatchCompletionThresholdMs(1.5)).toThrow(ElearningWatchError)
    expect(() => elearningWatchCompletionThresholdMs(10_000, 1.2)).toThrow(ElearningWatchError)
    try {
      elearningWatchCompletionThresholdMs(Number.MAX_SAFE_INTEGER + 1)
      throw new Error('expected invalid_input')
    } catch (error) {
      expect((error as ElearningWatchError).code).toBe('invalid_input')
      assertValuesFree(error)
    }
  })
})

describe('startElearningWatch', () => {
  it('rejects invalid identifiers without leaking actor values', async () => {
    const { db } = createMemoryDb()
    for (const input of [
      { orgId: '', userId: USER, itemId: ITEM },
      { orgId: ORG, userId: '  ', itemId: ITEM },
      { orgId: ORG, userId: USER, itemId: 'not-a-uuid' },
    ]) {
      try {
        await startElearningWatch(db, input)
        throw new Error('expected invalid_input')
      } catch (error) {
        expect((error as ElearningWatchError).code).toBe('invalid_input')
        assertValuesFree(error)
      }
    }
  })

  it('locks then inserts one session, start event at sequence 0, and in_progress row', async () => {
    const { db, mem } = createMemoryDb()
    const state = await startElearningWatch(db, { orgId: ORG, userId: USER, itemId: ITEM })
    expect(mem.queries[0]).toContain('elearning-watch:lock')
    expect(mem.queries[1]).toContain('elearning-watch:lock-course')
    expect(mem.queries[1]).toContain('FOR SHARE OF c')
    expect(mem.sessions).toHaveLength(1)
    expect(mem.events).toEqual([
      expect.objectContaining({ sequence: 0, kind: 'start', creditedMs: 0, playing: false }),
    ])
    expect(mem.progress).toEqual([
      expect.objectContaining({ status: 'in_progress', effectiveMs: 0 }),
    ])
    expect(state).toEqual(expect.objectContaining({
      sessionId: mem.sessions[0].id,
      status: 'in_progress',
      lastSequence: 0,
      creditedMs: 0,
      duplicate: false,
    }))
    expect(JSON.stringify(state)).not.toContain(ORG)
    expect(JSON.stringify(state)).not.toContain(USER)
    expect(JSON.stringify(state)).not.toContain(mem.sessions[0].rollingEventDigest)
  })

  it('reuses an existing active session and does not insert a second start event', async () => {
    const { db, mem } = createMemoryDb({
      sessions: [seededSession()],
      events: [seededEvent()],
      progress: [seededProgress()],
    })
    const first = await startElearningWatch(db, { orgId: ORG, userId: USER, itemId: ITEM })
    const second = await startElearningWatch(db, { orgId: ORG, userId: USER, itemId: ITEM })
    expect(first.sessionId).toBe(SESSION)
    expect(second.sessionId).toBe(SESSION)
    expect(mem.sessions).toHaveLength(1)
    expect(mem.events.filter((e) => e.kind === 'start')).toHaveLength(1)
    expect(mem.queries.filter((q) => q.includes('elearning-access:lock-assignment')))
      .toHaveLength(2)
    expect(mem.queries.some((q) => q.includes('elearning-watch:insert-session'))).toBe(false)
  })

  it('returns completed server state without opening a session', async () => {
    const { db, mem } = createMemoryDb({
      progress: [seededProgress({
        status: 'completed',
        effectiveMs: 9_000,
        maxPositionMs: 10_000,
        completedAt: 1,
      })],
    })
    const state = await startElearningWatch(db, { orgId: ORG, userId: USER, itemId: ITEM })
    expect(state).toEqual(expect.objectContaining({
      sessionId: null,
      status: 'completed',
      effectiveMs: 9_000,
    }))
    expect(mem.queries.map(tagOf)).toEqual([
      'elearning-watch:lock',
      'elearning-watch:lock-course',
      'elearning-watch:load-item',
      'elearning-access:lock-course',
      'elearning-access:lock-assignment',
      'elearning-watch:load-progress',
    ])
    expect(mem.sessions).toHaveLength(0)
    expect(mem.events).toHaveLength(0)
  })

  it('serializes concurrent starts so only one session and start event exist', async () => {
    const { db, mem } = createMemoryDb()
    const results = await Promise.all([
      startElearningWatch(db, { orgId: ORG, userId: USER, itemId: ITEM }),
      startElearningWatch(db, { orgId: ORG, userId: USER, itemId: ITEM }),
    ])
    expect(new Set(results.map((r) => r.sessionId)).size).toBe(1)
    expect(mem.sessions).toHaveLength(1)
    expect(mem.events.filter((e) => e.kind === 'start')).toHaveLength(1)
    expect(mem.progress).toHaveLength(1)
  })

  it('blocks withdrawn, revoked, exam items, and unsupported policies', async () => {
    const withdrawn = createMemoryDb({
      item: {
        id: ITEM,
        versionId: VERSION,
        itemType: 'video',
        policyVersion: ELEARNING_WATCH_POLICY_VERSION,
        thresholdBps: ELEARNING_WATCH_THRESHOLD_BPS,
        mediaId: MEDIA,
        versionStatus: 'published',
        courseStatus: 'withdrawn',
        mediaStatus: 'ready',
        durationMs: 10_000,
      },
    })
    await expect(startElearningWatch(withdrawn.db, { orgId: ORG, userId: USER, itemId: ITEM }))
      .rejects.toMatchObject({ code: 'course_withdrawn' })

    const revoked = createMemoryDb({
      members: [{ id: MEMBER, userId: USER, versionId: VERSION, revokedAt: 'now' }],
    })
    await expect(startElearningWatch(revoked.db, { orgId: ORG, userId: USER, itemId: ITEM }))
      .rejects.toMatchObject({ code: 'assignment_unavailable' })

    const exam = createMemoryDb({
      item: {
        id: ITEM,
        versionId: VERSION,
        itemType: 'exam',
        policyVersion: ELEARNING_WATCH_POLICY_VERSION,
        thresholdBps: ELEARNING_WATCH_THRESHOLD_BPS,
        mediaId: MEDIA,
        versionStatus: 'published',
        courseStatus: 'active',
        mediaStatus: 'ready',
        durationMs: 10_000,
      },
    })
    await expect(startElearningWatch(exam.db, { orgId: ORG, userId: USER, itemId: ITEM }))
      .rejects.toMatchObject({ code: 'unsupported_item' })

    const policy = createMemoryDb({
      item: {
        id: ITEM,
        versionId: VERSION,
        itemType: 'video',
        policyVersion: 'video-v1-80pct',
        thresholdBps: 8000,
        mediaId: MEDIA,
        versionStatus: 'published',
        courseStatus: 'active',
        mediaStatus: 'ready',
        durationMs: 10_000,
      },
    })
    await expect(startElearningWatch(policy.db, { orgId: ORG, userId: USER, itemId: ITEM }))
      .rejects.toMatchObject({ code: 'unsupported_policy' })
  })

  it('allows archived courses and retired versions when an assignment member is valid', async () => {
    const archived = createMemoryDb({
      item: {
        id: ITEM,
        versionId: VERSION,
        itemType: 'video',
        policyVersion: ELEARNING_WATCH_POLICY_VERSION,
        thresholdBps: ELEARNING_WATCH_THRESHOLD_BPS,
        mediaId: MEDIA,
        versionStatus: 'published',
        courseStatus: 'archived',
        mediaStatus: 'ready',
        durationMs: 10_000,
      },
    })
    await expect(startElearningWatch(archived.db, { orgId: ORG, userId: USER, itemId: ITEM }))
      .resolves.toMatchObject({ status: 'in_progress' })

    const retired = createMemoryDb({
      item: {
        id: ITEM,
        versionId: VERSION,
        itemType: 'video',
        policyVersion: ELEARNING_WATCH_POLICY_VERSION,
        thresholdBps: ELEARNING_WATCH_THRESHOLD_BPS,
        mediaId: MEDIA,
        versionStatus: 'retired',
        courseStatus: 'active',
        mediaStatus: 'ready',
        durationMs: 10_000,
      },
    })
    await expect(startElearningWatch(retired.db, { orgId: ORG, userId: USER, itemId: ITEM }))
      .resolves.toMatchObject({ status: 'in_progress' })
  })

  it('starts and completes self-study with a visibility rule and freezes optional evidence', async () => {
    const { db, mem } = createMemoryDb({
      item: scopeVisibleItem(),
      members: [],
    })
    const started = await startElearningWatch(db, { orgId: ORG, userId: USER, itemId: ITEM })
    expect(mem.sessions[0]).toEqual(expect.objectContaining({
      memberId: null,
      scopeRuleId: SCOPE_RULE,
    }))
    expect(mem.progress[0]).toEqual(expect.objectContaining({
      memberId: null,
      scopeRuleId: SCOPE_RULE,
      required: false,
    }))

    mem.now += 20_000
    const completed = await recordElearningHeartbeat(db, {
      sessionId: started.sessionId!,
      orgId: ORG,
      userId: USER,
      sequence: 1,
      positionMs: 10_000,
      playing: true,
    })
    expect(completed.status).toBe('completed')
    expect(mem.evidence).toEqual([
      expect.objectContaining({
        memberId: null,
        scopeRuleId: SCOPE_RULE,
      }),
    ])
    expect(mem.progress[0]).toEqual(expect.objectContaining({
      status: 'completed',
      required: false,
    }))
  })

  it('prefers assignment over matching visibility and freezes the course as required', async () => {
    const { db, mem } = createMemoryDb({ item: scopeVisibleItem() })
    const started = await startElearningWatch(db, { orgId: ORG, userId: USER, itemId: ITEM })
    expect(mem.sessions[0]).toEqual(expect.objectContaining({
      memberId: MEMBER,
      scopeRuleId: null,
    }))
    expect(mem.progress[0].required).toBe(true)
    expect(mem.queries.some((sql) => sql.includes('elearning-audience:'))).toBe(false)

    mem.now += 20_000
    await recordElearningHeartbeat(db, {
      sessionId: started.sessionId!,
      orgId: ORG,
      userId: USER,
      sequence: 1,
      positionMs: 10_000,
      playing: true,
    })
    expect(mem.evidence).toEqual([
      expect.objectContaining({ memberId: MEMBER, scopeRuleId: null }),
    ])
    expect(mem.progress[0].required).toBe(true)
  })

  it('blocks new credit after scope shrink without mutating the event chain or rollup', async () => {
    const { db, mem } = createMemoryDb({
      item: scopeVisibleItem(),
      members: [],
    })
    const started = await startElearningWatch(db, { orgId: ORG, userId: USER, itemId: ITEM })
    mem.now += 10_000
    const first = await recordElearningHeartbeat(db, {
      sessionId: started.sessionId!,
      orgId: ORG,
      userId: USER,
      sequence: 1,
      positionMs: 4_000,
      playing: true,
    })
    expect(first.effectiveMs).toBe(4_000)
    mem.item!.scopeRuleId = null
    mem.now += 10_000

    await expect(recordElearningHeartbeat(db, {
      sessionId: started.sessionId!,
      orgId: ORG,
      userId: USER,
      sequence: 2,
      positionMs: 8_000,
      playing: true,
    })).rejects.toMatchObject({ code: 'assignment_unavailable' })
    expect(mem.events).toHaveLength(2)
    expect(mem.sessions[0]).toEqual(expect.objectContaining({
      lastSequence: 1,
      effectiveMs: 4_000,
      scopeRuleId: SCOPE_RULE,
    }))
    expect(mem.progress[0]).toEqual(expect.objectContaining({
      effectiveMs: 4_000,
      scopeRuleId: SCOPE_RULE,
      status: 'in_progress',
    }))
  })

  it('does not let visibility open archived courses or retired versions', async () => {
    const archived = createMemoryDb({
      item: scopeVisibleItem({ courseStatus: 'archived' }),
      members: [],
    })
    await expect(startElearningWatch(archived.db, {
      orgId: ORG,
      userId: USER,
      itemId: ITEM,
    })).rejects.toMatchObject({ code: 'assignment_unavailable' })

    const retired = createMemoryDb({
      item: scopeVisibleItem({ versionStatus: 'retired' }),
      members: [],
    })
    await expect(startElearningWatch(retired.db, {
      orgId: ORG,
      userId: USER,
      itemId: ITEM,
    })).rejects.toMatchObject({ code: 'assignment_unavailable' })
  })

  it('rebinds a revoked assignment basis in place without resetting credited progress', async () => {
    const { db, mem } = createMemoryDb({
      members: [
        { id: MEMBER, userId: USER, versionId: VERSION, revokedAt: 'now' },
        { id: MEMBER_B, userId: USER, versionId: VERSION, revokedAt: null },
      ],
      sessions: [seededSession({
        lastSequence: 1,
        lastClientPositionMs: 4_000,
        effectiveMs: 4_000,
        maxPositionMs: 4_000,
        rollingEventDigest: 'old-digest',
      })],
      events: [
        seededEvent(),
        {
          sessionId: SESSION,
          sequence: 1,
          kind: 'heartbeat',
          reportedPositionMs: 4_000,
          playing: true,
          creditedMs: 4_000,
          eventDigest: 'old-digest',
        },
      ],
      progress: [seededProgress({
        memberId: MEMBER,
        effectiveMs: 4_000,
        maxPositionMs: 4_000,
      })],
    })
    const state = await startElearningWatch(db, { orgId: ORG, userId: USER, itemId: ITEM })
    expect(state.sessionId).toBe(SESSION)
    expect(state).toEqual(expect.objectContaining({
      status: 'in_progress',
      lastSequence: 1,
      lastClientPositionMs: 4_000,
      effectiveMs: 4_000,
      maxPositionMs: 4_000,
      creditedMs: 0,
    }))
    expect(mem.sessions).toHaveLength(1)
    expect(mem.sessions[0]).toEqual(expect.objectContaining({
      id: SESSION,
      status: 'active',
      closedAt: null,
      memberId: MEMBER_B,
      effectiveMs: 4_000,
    }))
    expect(mem.sessions[0].rollingEventDigest).toBe('old-digest')
    expect(mem.progress).toEqual([
      expect.objectContaining({
        memberId: MEMBER_B,
        status: 'in_progress',
        effectiveMs: 4_000,
        maxPositionMs: 4_000,
        completedAt: null,
      }),
    ])
    expect(mem.events.filter((e) => e.kind === 'start')).toHaveLength(1)

    mem.now = 1_020_000
    const beat = await recordElearningHeartbeat(db, {
      sessionId: state.sessionId!,
      orgId: ORG,
      userId: USER,
      sequence: 2,
      positionMs: 8_000,
      playing: true,
    })
    expect(beat.duplicate).toBe(false)
    expect(beat.status).toBe('in_progress')
    expect(beat.creditedMs).toBeGreaterThan(0)
    expect(beat.effectiveMs).toBe(4_000 + beat.creditedMs)
    expect(mem.sessions[0].status).toBe('active')
    expect(mem.progress[0].memberId).toBe(MEMBER_B)
  })

  it('keeps one active chain and deterministically rebinds to the canonical valid member', async () => {
    const { db, mem } = createMemoryDb({
      members: [
        { id: MEMBER, userId: USER, versionId: VERSION, revokedAt: null },
        { id: MEMBER_B, userId: USER, versionId: VERSION, revokedAt: null },
      ],
      sessions: [seededSession({ memberId: MEMBER_B, lastSequence: 1, effectiveMs: 2_000 })],
      events: [seededEvent()],
      progress: [seededProgress({ memberId: MEMBER_B, effectiveMs: 2_000, maxPositionMs: 2_000 })],
    })
    const state = await startElearningWatch(db, { orgId: ORG, userId: USER, itemId: ITEM })
    expect(state.sessionId).toBe(SESSION)
    expect(state.effectiveMs).toBe(2_000)
    expect(mem.sessions).toHaveLength(1)
    expect(mem.sessions[0].memberId).toBe(MEMBER)
    expect(mem.sessions[0].status).toBe('active')
    expect(mem.events.filter((e) => e.kind === 'start')).toHaveLength(1)
    expect(mem.progress[0]).toEqual(expect.objectContaining({
      memberId: MEMBER,
      effectiveMs: 2_000,
    }))
  })

  it('does not reset completed progress when the old member is revoked and a new member exists', async () => {
    const { db, mem } = createMemoryDb({
      members: [
        { id: MEMBER, userId: USER, versionId: VERSION, revokedAt: 'now' },
        { id: MEMBER_B, userId: USER, versionId: VERSION, revokedAt: null },
      ],
      progress: [seededProgress({
        status: 'completed',
        effectiveMs: 9_000,
        maxPositionMs: 10_000,
        completedAt: 1,
      })],
    })
    const state = await startElearningWatch(db, { orgId: ORG, userId: USER, itemId: ITEM })
    expect(state).toEqual(expect.objectContaining({
      sessionId: null,
      status: 'completed',
      effectiveMs: 9_000,
    }))
    expect(mem.queries.map(tagOf)).toEqual([
      'elearning-watch:lock',
      'elearning-watch:lock-course',
      'elearning-watch:load-item',
      'elearning-access:lock-course',
      'elearning-access:lock-assignment',
      'elearning-watch:load-progress',
    ])
    expect(mem.sessions).toHaveLength(0)
    expect(mem.events).toHaveLength(0)
    expect(mem.evidence).toHaveLength(0)
    expect(mem.progress[0]).toEqual(expect.objectContaining({
      status: 'completed',
      memberId: MEMBER,
      effectiveMs: 9_000,
      completedAt: 1,
    }))
  })

  it('rejects completed progress when the only assignment member is revoked and leaves history untouched', async () => {
    const evidence: EvidenceRow = {
      memberId: MEMBER,
      scopeRuleId: null,
      versionId: VERSION,
      itemId: ITEM,
      policyVersion: ELEARNING_WATCH_POLICY_VERSION,
      thresholdBps: ELEARNING_WATCH_THRESHOLD_BPS,
      durationMs: 10_000,
      effectiveMs: 9_000,
      maxPositionMs: 10_000,
      eventDigest: 'done-digest',
      evaluatorVersion: ELEARNING_WATCH_EVALUATOR_VERSION,
    }
    const { db, mem } = createMemoryDb({
      members: [{ id: MEMBER, userId: USER, versionId: VERSION, revokedAt: 'now' }],
      sessions: [seededSession({
        status: 'completed',
        lastSequence: 1,
        lastClientPositionMs: 10_000,
        effectiveMs: 9_000,
        maxPositionMs: 10_000,
        closedAt: 1,
      })],
      events: [
        seededEvent(),
        {
          sessionId: SESSION,
          sequence: 1,
          kind: 'heartbeat',
          reportedPositionMs: 10_000,
          playing: true,
          creditedMs: 9_000,
          eventDigest: 'done-digest',
        },
      ],
      progress: [seededProgress({
        status: 'completed',
        effectiveMs: 9_000,
        maxPositionMs: 10_000,
        completedAt: 1,
      })],
      evidence: [evidence],
    })
    try {
      await startElearningWatch(db, { orgId: ORG, userId: USER, itemId: ITEM })
      throw new Error('expected assignment_unavailable')
    } catch (error) {
      expect((error as ElearningWatchError).code).toBe('assignment_unavailable')
      assertValuesFree(error)
    }
    expect(mem.queries.map(tagOf)).toEqual([
      'elearning-watch:lock',
      'elearning-watch:lock-course',
      'elearning-watch:load-item',
      'elearning-access:lock-course',
      'elearning-access:lock-assignment',
    ])
    expect(mem.sessions).toEqual([
      expect.objectContaining({
        id: SESSION,
        status: 'completed',
        memberId: MEMBER,
        effectiveMs: 9_000,
        closedAt: 1,
      }),
    ])
    expect(mem.events).toHaveLength(2)
    expect(mem.progress).toEqual([
      expect.objectContaining({
        status: 'completed',
        memberId: MEMBER,
        effectiveMs: 9_000,
        maxPositionMs: 10_000,
        completedAt: 1,
      }),
    ])
    expect(mem.evidence).toEqual([evidence])
  })
})

describe('recordElearningHeartbeat', () => {
  const baseInput = {
    sessionId: SESSION,
    orgId: ORG,
    userId: USER,
    sequence: 1,
    positionMs: 4_000,
    playing: true,
  }

  it('rejects non-safe integers, sequence < 1, negative position, and non-boolean playing', async () => {
    const { db } = createMemoryDb({
      sessions: [seededSession()],
      events: [seededEvent()],
      progress: [seededProgress()],
    })
    const bad = [
      { sequence: 0 },
      { sequence: 1.5 },
      { sequence: Number.MAX_SAFE_INTEGER + 1 },
      { positionMs: -1 },
      { positionMs: 1.2 },
      { playing: 1 as unknown as boolean },
      { sessionId: 'nope' },
    ]
    for (const over of bad) {
      await expect(recordElearningHeartbeat(db, { ...baseInput, ...over }))
        .rejects.toMatchObject({ code: 'invalid_input' })
    }
  })

  it('ignores client completed/delta/timestamp and never writes a completed event', async () => {
    const { db, mem } = createMemoryDb({
      sessions: [seededSession({ lastEventAt: 980_000 })],
      events: [seededEvent()],
      progress: [seededProgress()],
    })
    const state = await recordElearningHeartbeat(db, {
      ...baseInput,
      ...{
        completed: true,
        delta: 9_000,
        timestamp: 1,
      },
    } as typeof baseInput)
    expect(state.duplicate).toBe(false)
    expect(mem.events.map((e) => e.kind)).toEqual(['start', 'heartbeat'])
    expect(mem.events.some((e) => e.kind === 'completed')).toBe(false)
  })

  it('returns duplicate zero-credit state for the same stored position and playing', async () => {
    const { db, mem } = createMemoryDb({
      sessions: [seededSession({ lastEventAt: 980_000 })],
      events: [seededEvent()],
      progress: [seededProgress()],
    })
    const first = await recordElearningHeartbeat(db, baseInput)
    const second = await recordElearningHeartbeat(db, baseInput)
    expect(first.duplicate).toBe(false)
    expect(first.creditedMs).toBeGreaterThan(0)
    expect(second).toEqual(expect.objectContaining({
      duplicate: true,
      creditedMs: 0,
      effectiveMs: first.effectiveMs,
      lastSequence: first.lastSequence,
    }))
    expect(mem.events.filter((e) => e.kind === 'heartbeat')).toHaveLength(1)
  })

  it('conflicts when the replayed payload differs or the prior event is missing', async () => {
    const { db } = createMemoryDb({
      sessions: [seededSession({ lastSequence: 1, lastEventAt: 980_000 })],
      events: [seededEvent()],
      progress: [seededProgress()],
    })
    await expect(recordElearningHeartbeat(db, baseInput))
      .rejects.toMatchObject({ code: 'conflict' })

    const withEvent = createMemoryDb({
      sessions: [seededSession({
        lastSequence: 1,
        lastClientPositionMs: 4_000,
        lastEventAt: 980_000,
      })],
      events: [
        seededEvent(),
        {
          sessionId: SESSION,
          sequence: 1,
          kind: 'heartbeat',
          reportedPositionMs: 4_000,
          playing: true,
          creditedMs: 4_000,
          eventDigest: 'x',
        },
      ],
      progress: [seededProgress()],
    })
    await expect(recordElearningHeartbeat(withEvent.db, { ...baseInput, positionMs: 5_000 }))
      .rejects.toMatchObject({ code: 'conflict' })
  })

  it('rejects a sequence gap', async () => {
    const { db } = createMemoryDb({
      sessions: [seededSession()],
      events: [seededEvent()],
      progress: [seededProgress()],
    })
    await expect(recordElearningHeartbeat(db, { ...baseInput, sequence: 2 }))
      .rejects.toMatchObject({ code: 'sequence_gap' })
  })

  it('credits zero while paused and still records the clamped position', async () => {
    const { db, mem } = createMemoryDb({
      sessions: [seededSession({ lastEventAt: 980_000 })],
      events: [seededEvent()],
      progress: [seededProgress()],
    })
    const state = await recordElearningHeartbeat(db, {
      ...baseInput,
      playing: false,
      positionMs: 8_000,
    })
    expect(state.creditedMs).toBe(0)
    expect(state.lastClientPositionMs).toBe(8_000)
    expect(state.maxPositionMs).toBe(0)
    expect(state.effectiveMs).toBe(0)
    expect(mem.events.at(-1)).toEqual(expect.objectContaining({
      playing: false,
      creditedMs: 0,
      reportedPositionMs: 8_000,
    }))
  })

  it('clamps seek credit by 2x elapsed and elapsed itself to 30s', async () => {
    const seek = createMemoryDb({
      sessions: [seededSession({ lastEventAt: 999_000 })],
      events: [seededEvent()],
      progress: [seededProgress()],
    })
    seek.mem.now = 1_000_000
    const seekState = await recordElearningHeartbeat(seek.db, {
      ...baseInput,
      positionMs: 9_000,
    })
    expect(seekState.creditedMs).toBe(2_000)
    expect(seekState.maxPositionMs).toBe(2_000)
    expect(seekState.lastClientPositionMs).toBe(9_000)

    const wall = createMemoryDb({
      item: {
        id: ITEM,
        versionId: VERSION,
        itemType: 'video',
        policyVersion: ELEARNING_WATCH_POLICY_VERSION,
        thresholdBps: ELEARNING_WATCH_THRESHOLD_BPS,
        mediaId: MEDIA,
        versionStatus: 'published',
        courseStatus: 'active',
        mediaStatus: 'ready',
        durationMs: 120_000,
      },
      sessions: [seededSession({ lastEventAt: 1_000_000 })],
      events: [seededEvent()],
      progress: [seededProgress()],
    })
    wall.mem.now = 1_000_000 + 120_000
    const wallState = await recordElearningHeartbeat(wall.db, {
      ...baseInput,
      positionMs: 120_000,
    })
    expect(wallState.creditedMs).toBe(60_000)
    expect(wallState.maxPositionMs).toBe(60_000)
    expect(wallState.lastClientPositionMs).toBe(120_000)
  })

  it('recovers earnable credit after a paused duration seek and a wall-clock-clamped playing seek', async () => {
    const { db, mem } = createMemoryDb({
      item: {
        id: ITEM,
        versionId: VERSION,
        itemType: 'video',
        policyVersion: ELEARNING_WATCH_POLICY_VERSION,
        thresholdBps: ELEARNING_WATCH_THRESHOLD_BPS,
        mediaId: MEDIA,
        versionStatus: 'published',
        courseStatus: 'active',
        mediaStatus: 'ready',
        durationMs: 120_000,
      },
      sessions: [seededSession()],
      events: [seededEvent()],
      progress: [seededProgress()],
    })

    const paused = await recordElearningHeartbeat(db, {
      ...baseInput,
      sequence: 1,
      positionMs: 120_000,
      playing: false,
    })
    expect(paused).toEqual(expect.objectContaining({
      creditedMs: 0,
      maxPositionMs: 0,
      lastClientPositionMs: 120_000,
      effectiveMs: 0,
    }))

    mem.now += 1_000
    const rewind = await recordElearningHeartbeat(db, {
      ...baseInput,
      sequence: 2,
      positionMs: 0,
      playing: false,
    })
    expect(rewind).toEqual(expect.objectContaining({
      creditedMs: 0,
      maxPositionMs: 0,
      lastClientPositionMs: 0,
    }))

    mem.now += 10_000
    const watched = await recordElearningHeartbeat(db, {
      ...baseInput,
      sequence: 3,
      positionMs: 3_000,
      playing: true,
    })
    expect(watched.creditedMs).toBe(3_000)
    expect(watched.maxPositionMs).toBe(3_000)

    mem.now += 1_000
    const seek = await recordElearningHeartbeat(db, {
      ...baseInput,
      sequence: 4,
      positionMs: 100_000,
      playing: true,
    })
    expect(seek.creditedMs).toBe(2_000)
    expect(seek.maxPositionMs).toBe(5_000)
    expect(seek.lastClientPositionMs).toBe(100_000)
    expect(seek.effectiveMs).toBe(5_000)

    mem.now += 10_000
    const idle = await recordElearningHeartbeat(db, {
      ...baseInput,
      sequence: 5,
      positionMs: 100_000,
      playing: true,
    })
    expect(idle).toEqual(expect.objectContaining({
      creditedMs: 0,
      maxPositionMs: 5_000,
      lastClientPositionMs: 100_000,
      effectiveMs: 5_000,
    }))

    mem.now += 1_000
    const back = await recordElearningHeartbeat(db, {
      ...baseInput,
      sequence: 6,
      positionMs: 0,
      playing: false,
    })
    expect(back).toEqual(expect.objectContaining({
      creditedMs: 0,
      maxPositionMs: 5_000,
      lastClientPositionMs: 0,
    }))

    mem.now += 10_000
    const replay = await recordElearningHeartbeat(db, {
      ...baseInput,
      sequence: 7,
      positionMs: 5_000,
      playing: true,
    })
    expect(replay).toEqual(expect.objectContaining({
      creditedMs: 0,
      maxPositionMs: 5_000,
      effectiveMs: 5_000,
    }))

    mem.now += 2_000
    const novel = await recordElearningHeartbeat(db, {
      ...baseInput,
      sequence: 8,
      positionMs: 7_000,
      playing: true,
    })
    expect(novel.creditedMs).toBe(2_000)
    expect(novel.maxPositionMs).toBe(7_000)
    expect(novel.effectiveMs).toBe(7_000)
    expect(mem.sessions[0].lastClientPositionMs).toBe(7_000)
    expect(mem.progress[0]).toEqual(expect.objectContaining({
      effectiveMs: 7_000,
      maxPositionMs: 7_000,
    }))
  })

  it('completes in one transaction with frozen policy evidence and no completed event', async () => {
    const { db, mem } = createMemoryDb({
      sessions: [seededSession({ lastEventAt: 970_000 })],
      events: [seededEvent()],
      progress: [seededProgress()],
    })
    const state = await recordElearningHeartbeat(db, {
      ...baseInput,
      positionMs: 10_000,
    })
    expect(state.status).toBe('completed')
    expect(state.effectiveMs).toBeGreaterThanOrEqual(9_000)
    expect(mem.evidence).toEqual([
      expect.objectContaining({
        policyVersion: ELEARNING_WATCH_POLICY_VERSION,
        thresholdBps: ELEARNING_WATCH_THRESHOLD_BPS,
        durationMs: 10_000,
        evaluatorVersion: ELEARNING_WATCH_EVALUATOR_VERSION,
        effectiveMs: state.effectiveMs,
      }),
    ])
    expect(mem.progress[0]).toEqual(expect.objectContaining({ status: 'completed' }))
    expect(mem.sessions[0]).toEqual(expect.objectContaining({
      status: 'completed',
      closedAt: mem.now,
    }))
    expect(mem.events.map((e) => e.kind)).toEqual(['start', 'heartbeat'])
    expect(JSON.stringify(state)).not.toContain(mem.evidence[0].eventDigest)
  })

  it('does not add credit twice for serialized parallel heartbeats', async () => {
    const { db, mem } = createMemoryDb({
      sessions: [seededSession({ lastEventAt: 980_000 })],
      events: [seededEvent()],
      progress: [seededProgress()],
    })
    const results = await Promise.allSettled([
      recordElearningHeartbeat(db, baseInput),
      recordElearningHeartbeat(db, baseInput),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled') as Array<PromiseFulfilledResult<{
      creditedMs: number
      duplicate: boolean
      effectiveMs: number
    }>>
    expect(fulfilled).toHaveLength(2)
    const credits = fulfilled.map((r) => r.value.creditedMs).sort((a, b) => a - b)
    expect(credits[0]).toBe(0)
    expect(credits[1]).toBeGreaterThan(0)
    expect(fulfilled.filter((r) => r.value.duplicate)).toHaveLength(1)
    expect(mem.events.filter((e) => e.kind === 'heartbeat')).toHaveLength(1)
    expect(mem.sessions[0].effectiveMs).toBe(credits[1])
  })

  it('keeps errors values-free on withdrawn and revoked heartbeat rechecks', async () => {
    const withdrawn = createMemoryDb({
      item: {
        id: ITEM,
        versionId: VERSION,
        itemType: 'video',
        policyVersion: ELEARNING_WATCH_POLICY_VERSION,
        thresholdBps: ELEARNING_WATCH_THRESHOLD_BPS,
        mediaId: MEDIA,
        versionStatus: 'published',
        courseStatus: 'withdrawn',
        mediaStatus: 'ready',
        durationMs: 10_000,
      },
      sessions: [seededSession()],
      events: [seededEvent()],
      progress: [seededProgress()],
    })
    try {
      await recordElearningHeartbeat(withdrawn.db, baseInput)
      throw new Error('expected withdrawn')
    } catch (error) {
      expect((error as ElearningWatchError).code).toBe('course_withdrawn')
      assertValuesFree(error)
    }

    const revoked = createMemoryDb({
      members: [{ id: MEMBER, userId: USER, versionId: VERSION, revokedAt: 'now' }],
      sessions: [seededSession()],
      events: [seededEvent()],
      progress: [seededProgress()],
    })
    await expect(recordElearningHeartbeat(revoked.db, baseInput))
      .rejects.toMatchObject({ code: 'assignment_unavailable' })
  })
})

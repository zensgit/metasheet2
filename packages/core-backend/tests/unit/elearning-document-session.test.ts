import { describe, expect, it } from 'vitest'

import { ELEARNING_DOCUMENT_COMPLETION_POLICY_VERSION } from '../../src/services/elearning-document-completion-policy'
import type {
  ElearningDocumentProgressSnapshot,
} from '../../src/services/elearning-document-progress'
import {
  type ElearningDocumentSessionAuthority,
  type ElearningDocumentSessionStore,
  type ElearningDocumentSessionTransaction,
  ElearningDocumentSessionError,
  startElearningDocumentSession,
} from '../../src/services/elearning-document-session'

const SENTINEL = 'secret-document-session-value'
const ORG_ID = 'org-1'
const USER_ID = 'user-1'
const ITEM_ID = '10000000-0000-4000-8000-000000000001'
const VERSION_ID = '10000000-0000-4000-8000-000000000002'
const MEDIA_ID = '10000000-0000-4000-8000-000000000003'
const MEMBER_ID = '10000000-0000-4000-8000-000000000004'
const RULE_ID = '10000000-0000-4000-8000-000000000005'
const SESSION_ID = '10000000-0000-4000-8000-000000000006'
const OTHER_SESSION_ID = '10000000-0000-4000-8000-000000000007'
const NOW = '2026-08-28T13:00:00.000Z'

function input(overrides: Record<string, unknown> = {}) {
  return {
    courseVersionItemId: ITEM_ID,
    orgId: ORG_ID,
    userId: USER_ID,
    ...overrides,
  }
}

function inProgressSnapshot(
  overrides: Partial<ElearningDocumentProgressSnapshot> = {},
): ElearningDocumentProgressSnapshot {
  return {
    completedAt: null,
    evidenceDigest: null,
    requiredPageCount: 3,
    serverPageCount: 4,
    status: 'in_progress',
    thresholdBps: 7_500,
    viewedPageCount: 1,
    viewedPageRanges: [{ endPage: 1, startPage: 1 }],
    ...overrides,
  }
}

function completedSnapshot(): ElearningDocumentProgressSnapshot {
  return {
    completedAt: NOW,
    evidenceDigest: 'a'.repeat(64),
    requiredPageCount: 3,
    serverPageCount: 4,
    status: 'completed',
    thresholdBps: 7_500,
    viewedPageCount: 3,
    viewedPageRanges: [{ endPage: 3, startPage: 1 }],
  }
}

function authority(
  overrides: Partial<ElearningDocumentSessionAuthority> = {},
): ElearningDocumentSessionAuthority {
  return {
    accessBasis: { assignmentMemberId: MEMBER_ID, kind: 'assignment' },
    activeSession: null,
    completion: null,
    courseVersionId: VERSION_ID,
    courseVersionItemId: ITEM_ID,
    documentMediaId: MEDIA_ID,
    policyVersion: ELEARNING_DOCUMENT_COMPLETION_POLICY_VERSION,
    serverPageCount: 4,
    thresholdBps: 7_500,
    ...overrides,
  }
}

function expectCode(action: () => Promise<unknown>, code: string): Promise<void> {
  return action().then(
    () => { throw new Error('expected document session error') },
    (error: unknown) => {
      expect(error).toBeInstanceOf(ElearningDocumentSessionError)
      const sessionError = error as ElearningDocumentSessionError
      expect(sessionError.code).toBe(code)
      expect(sessionError.message).toBe(code)
      expect(sessionError.cause).toBeUndefined()
      expect(`${sessionError.message}\n${sessionError.stack ?? ''}`).not.toContain(
        SENTINEL,
      )
    },
  )
}

class FakeDocumentSessionStore
implements ElearningDocumentSessionStore, ElearningDocumentSessionTransaction {
  authority: ElearningDocumentSessionAuthority | null = authority()
  readonly calls: string[] = []
  readonly creates: Array<Parameters<
    ElearningDocumentSessionTransaction['createDocumentSession']
  >[0]> = []
  readonly events: Array<Parameters<
    ElearningDocumentSessionTransaction['appendDocumentStartEvent']
  >[0]> = []
  readonly locks: Array<Parameters<
    ElearningDocumentSessionTransaction['lockAccessibleDocumentForSessionStart']
  >[0]> = []
  readonly progressWrites: Array<Parameters<
    ElearningDocumentSessionTransaction['upsertDocumentProgress']
  >[0]> = []
  nextSessionId = SESSION_ID
  throwFromLock = false
  private transactionTail: Promise<void> = Promise.resolve()
  private createdSessionId: string | null = null

  transaction<T>(
    handler: (tx: ElearningDocumentSessionTransaction) => Promise<T>,
  ): Promise<T> {
    const run = this.transactionTail.then(async () => {
      this.calls.push('transaction')
      return handler(this)
    })
    this.transactionTail = run.then(() => undefined, () => undefined)
    return run
  }

  async lockAccessibleDocumentForSessionStart(
    lock: Parameters<
      ElearningDocumentSessionTransaction['lockAccessibleDocumentForSessionStart']
    >[0],
  ): Promise<ElearningDocumentSessionAuthority | null> {
    this.calls.push('lock')
    this.locks.push(lock)
    if (this.throwFromLock) throw new Error(SENTINEL)
    return this.authority
  }

  async createDocumentSession(
    create: Parameters<ElearningDocumentSessionTransaction['createDocumentSession']>[0],
  ): Promise<string> {
    this.calls.push('create')
    this.creates.push(create)
    this.createdSessionId = this.nextSessionId
    return this.nextSessionId
  }

  async appendDocumentStartEvent(
    event: Parameters<ElearningDocumentSessionTransaction['appendDocumentStartEvent']>[0],
  ): Promise<void> {
    this.calls.push('event')
    this.events.push(event)
  }

  async upsertDocumentProgress(
    progress: Parameters<ElearningDocumentSessionTransaction['upsertDocumentProgress']>[0],
  ): Promise<void> {
    this.calls.push('progress')
    this.progressWrites.push(progress)
    if (!this.authority || !this.createdSessionId) throw new Error('session missing')
    this.authority = {
      ...this.authority,
      activeSession: {
        progress: progress.snapshot,
        sessionId: this.createdSessionId,
      },
    }
  }
}

describe('elearning document session runtime', () => {
  it('creates a session, sequence-zero start event, and initial progress atomically', async () => {
    const store = new FakeDocumentSessionStore()
    const result = await startElearningDocumentSession(
      store,
      input(),
      () => new Date(NOW),
    )
    expect(result).toEqual({
      completedAt: null,
      created: true,
      evidenceDigest: null,
      requiredPageCount: 3,
      serverPageCount: 4,
      sessionId: SESSION_ID,
      status: 'in_progress',
      thresholdBps: 7_500,
      viewedPageCount: 0,
      viewedPageRanges: [],
    })
    expect(store.calls).toEqual([
      'transaction', 'lock', 'create', 'event', 'progress',
    ])
    expect(store.locks).toEqual([input()])
    expect(store.creates).toEqual([{
      accessBasis: { assignmentMemberId: MEMBER_ID, kind: 'assignment' },
      courseVersionId: VERSION_ID,
      courseVersionItemId: ITEM_ID,
      orgId: ORG_ID,
      startedAt: NOW,
      userId: USER_ID,
    }])
    expect(store.events).toEqual([{
      courseVersionId: VERSION_ID,
      courseVersionItemId: ITEM_ID,
      eventDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      orgId: ORG_ID,
      receivedAt: NOW,
      sequence: 0,
      sessionId: SESSION_ID,
      userId: USER_ID,
    }])
    expect(store.progressWrites[0]).toMatchObject({
      accessBasis: { assignmentMemberId: MEMBER_ID, kind: 'assignment' },
      courseVersionId: VERSION_ID,
      courseVersionItemId: ITEM_ID,
      orgId: ORG_ID,
      userId: USER_ID,
    })
    expect(Object.keys(result)).toEqual([
      'completedAt',
      'created',
      'evidenceDigest',
      'requiredPageCount',
      'serverPageCount',
      'sessionId',
      'status',
      'thresholdBps',
      'viewedPageCount',
      'viewedPageRanges',
    ])
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.viewedPageRanges)).toBe(true)
  })

  it('serializes concurrent starts so only one active session is created', async () => {
    const store = new FakeDocumentSessionStore()
    const [first, second] = await Promise.all([
      startElearningDocumentSession(store, input(), () => new Date(NOW)),
      startElearningDocumentSession(store, input(), () => new Date(NOW)),
    ])
    expect(first).toMatchObject({ created: true, sessionId: SESSION_ID })
    expect(second).toMatchObject({ created: false, sessionId: SESSION_ID })
    expect(store.creates).toHaveLength(1)
    expect(store.events).toHaveLength(1)
    expect(store.progressWrites).toHaveLength(1)
  })

  it('reuses an existing active session and its progress without writing', async () => {
    const store = new FakeDocumentSessionStore()
    store.authority = authority({
      activeSession: {
        progress: inProgressSnapshot(),
        sessionId: SESSION_ID,
      },
    })
    const result = await startElearningDocumentSession(store, input())
    expect(result).toEqual({
      ...inProgressSnapshot(),
      created: false,
      sessionId: SESSION_ID,
    })
    expect(store.calls).toEqual(['transaction', 'lock'])
    expect(store.creates).toEqual([])
    expect(store.events).toEqual([])
    expect(store.progressWrites).toEqual([])
  })

  it('returns completed state without creating or reviving a session', async () => {
    const store = new FakeDocumentSessionStore()
    store.authority = authority({ completion: completedSnapshot() })
    const result = await startElearningDocumentSession(store, input())
    expect(result).toEqual({
      ...completedSnapshot(),
      created: false,
      sessionId: null,
    })
    expect(store.calls).toEqual(['transaction', 'lock'])
    expect(store.creates).toEqual([])
  })

  it('freezes the current visibility rule as the optional access basis', async () => {
    const store = new FakeDocumentSessionStore()
    store.authority = authority({
      accessBasis: { kind: 'visibility', scopeRevisionRuleId: RULE_ID },
    })
    await startElearningDocumentSession(store, input(), () => new Date(NOW))
    expect(store.creates[0].accessBasis).toEqual({
      kind: 'visibility',
      scopeRevisionRuleId: RULE_ID,
    })
    expect(store.progressWrites[0].accessBasis).toEqual({
      kind: 'visibility',
      scopeRevisionRuleId: RULE_ID,
    })
  })

  it('binds the start digest to the server-created session identity', async () => {
    const first = new FakeDocumentSessionStore()
    const second = new FakeDocumentSessionStore()
    second.nextSessionId = OTHER_SESSION_ID
    await startElearningDocumentSession(first, input(), () => new Date(NOW))
    await startElearningDocumentSession(second, input(), () => new Date(NOW))
    expect(first.events[0].eventDigest).not.toBe(second.events[0].eventDigest)
  })

  it('fails closed when access or server policy authority is unavailable', async () => {
    const denied = new FakeDocumentSessionStore()
    denied.authority = null
    await expectCode(() => startElearningDocumentSession(denied, input()), 'unavailable')
    expect(denied.calls).toEqual(['transaction', 'lock'])

    const wrongItem = new FakeDocumentSessionStore()
    wrongItem.authority = authority({ courseVersionItemId: SESSION_ID })
    await expectCode(
      () => startElearningDocumentSession(wrongItem, input()),
      'unavailable',
    )
    expect(wrongItem.creates).toEqual([])

    const corruptPolicy = new FakeDocumentSessionStore()
    corruptPolicy.authority = authority({ serverPageCount: 0 })
    await expectCode(
      () => startElearningDocumentSession(corruptPolicy, input()),
      'unavailable',
    )
    expect(corruptPolicy.creates).toEqual([])
  })

  it('rejects contradictory completed and active server state', async () => {
    const store = new FakeDocumentSessionStore()
    store.authority = authority({
      activeSession: {
        progress: inProgressSnapshot(),
        sessionId: SESSION_ID,
      },
      completion: completedSnapshot(),
    })
    await expectCode(() => startElearningDocumentSession(store, input()), 'unavailable')
    expect(store.creates).toEqual([])
  })

  it('accepts only the closed start command and never accepts completed', async () => {
    for (const value of [
      null,
      {},
      { ...input(), completed: true },
      input({ courseVersionItemId: 'item-1' }),
      input({ orgId: '' }),
      input({ userId: '' }),
    ]) {
      const store = new FakeDocumentSessionStore()
      await expectCode(
        () => startElearningDocumentSession(store, value),
        'invalid_input',
      )
      expect(store.calls).toEqual([])
    }
  })

  it('keeps adapter and clock failures values-free', async () => {
    const store = new FakeDocumentSessionStore()
    store.throwFromLock = true
    await expectCode(() => startElearningDocumentSession(store, input()), 'unavailable')

    const badClock = new FakeDocumentSessionStore()
    await expectCode(
      () => startElearningDocumentSession(
        badClock,
        input(),
        () => new Date(Number.NaN),
      ),
      'unavailable',
    )
    expect(badClock.creates).toEqual([])
  })
})

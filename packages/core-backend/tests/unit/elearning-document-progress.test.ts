import { describe, expect, it } from 'vitest'

import {
  type ElearningDocumentAuthority,
  type ElearningDocumentPageViewClaim,
  type ElearningDocumentPageViewTransaction,
  type ElearningDocumentProgressSnapshot,
  type ElearningDocumentProgressStore,
  ELEARNING_DOCUMENT_PAGE_VIEW_REQUEST_HASH_VERSION,
  ElearningDocumentProgressError,
  recordElearningDocumentPageView,
} from '../../src/services/elearning-document-progress'
import {
  type ElearningDocumentCompletionEvaluation,
  ELEARNING_DOCUMENT_COMPLETION_POLICY_VERSION,
} from '../../src/services/elearning-document-completion-policy'

const SENTINEL = 'secret-document-runtime-value'
const ORG_ID = 'org-1'
const USER_ID = 'user-1'
const ITEM_ID = '10000000-0000-4000-8000-000000000001'
const VERSION_ID = '10000000-0000-4000-8000-000000000002'
const MEDIA_ID = '10000000-0000-4000-8000-000000000003'
const MEMBER_ID = '10000000-0000-4000-8000-000000000004'
const RULE_ID = '10000000-0000-4000-8000-000000000005'
const REQUEST_ID = '10000000-0000-4000-8000-000000000006'
const OTHER_REQUEST_ID = '10000000-0000-4000-8000-000000000007'
const SESSION_ID = '10000000-0000-4000-8000-000000000008'
const NOW = '2026-08-28T12:34:56.000Z'

function authority(
  overrides: Partial<ElearningDocumentAuthority> = {},
): ElearningDocumentAuthority {
  return {
    accessBasis: { assignmentMemberId: MEMBER_ID, kind: 'assignment' },
    completion: null,
    courseVersionId: VERSION_ID,
    courseVersionItemId: ITEM_ID,
    documentMediaId: MEDIA_ID,
    documentMediaKind: 'document',
    documentMediaStatus: 'ready',
    documentPageCountAuthority: 'server_probe',
    policyVersion: ELEARNING_DOCUMENT_COMPLETION_POLICY_VERSION,
    serverPageCount: 4,
    sessionId: SESSION_ID,
    thresholdBps: 7_500,
    ...overrides,
  }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    courseVersionItemId: ITEM_ID,
    orgId: ORG_ID,
    pageNumber: 3,
    requestId: REQUEST_ID,
    sessionId: SESSION_ID,
    userId: USER_ID,
    ...overrides,
  }
}

function expectCode(action: () => Promise<unknown>, code: string): Promise<void> {
  return action().then(
    () => { throw new Error('expected document progress error') },
    (error: unknown) => {
      expect(error).toBeInstanceOf(ElearningDocumentProgressError)
      const progressError = error as ElearningDocumentProgressError
      expect(progressError.code).toBe(code)
      expect(progressError.message).toBe(code)
      expect(progressError.cause).toBeUndefined()
      expect(`${progressError.message}\n${progressError.stack ?? ''}`).not.toContain(
        SENTINEL,
      )
    },
  )
}

function completionSnapshot(
  evaluation: ElearningDocumentCompletionEvaluation,
  completedAt: string,
): ElearningDocumentProgressSnapshot {
  return Object.freeze({
    completedAt,
    evidenceDigest: evaluation.evidenceDigest,
    requiredPageCount: evaluation.requiredPageCount,
    serverPageCount: evaluation.serverPageCount,
    status: 'completed' as const,
    thresholdBps: evaluation.thresholdBps,
    viewedPageCount: evaluation.viewedPageCount,
    viewedPageRanges: evaluation.viewedPageRanges,
  })
}

class FakeDocumentStore
implements ElearningDocumentProgressStore, ElearningDocumentPageViewTransaction {
  authority: ElearningDocumentAuthority | null = authority()
  readonly calls: string[] = []
  readonly claims: Array<Parameters<
    ElearningDocumentPageViewTransaction['claimPageViewRequest']
  >[0]> = []
  readonly completionInputs: Array<Parameters<
    ElearningDocumentPageViewTransaction['appendCompletionEvidenceIfAbsent']
  >[0]> = []
  readonly events: Array<Parameters<
    ElearningDocumentPageViewTransaction['appendPageView']
  >[0]> = []
  readonly progressWrites: Array<Parameters<
    ElearningDocumentPageViewTransaction['upsertProgress']
  >[0]> = []
  readonly requestResults: Array<Parameters<
    ElearningDocumentPageViewTransaction['storePageViewRequestResult']
  >[0]> = []
  readonly requestLedger = new Map<string, {
    requestHash: string
    result?: ElearningDocumentProgressSnapshot
  }>()
  viewedPages: number[] = []
  throwFromLock = false

  async transaction<T>(
    handler: (tx: ElearningDocumentPageViewTransaction) => Promise<T>,
  ): Promise<T> {
    this.calls.push('transaction')
    return handler(this)
  }

  async lockAccessibleDocumentForUpdate(): Promise<ElearningDocumentAuthority | null> {
    this.calls.push('lock')
    if (this.throwFromLock) throw new Error(SENTINEL)
    return this.authority
  }

  async claimPageViewRequest(
    claim: Parameters<ElearningDocumentPageViewTransaction['claimPageViewRequest']>[0],
  ): Promise<ElearningDocumentPageViewClaim> {
    this.calls.push('claim')
    this.claims.push(claim)
    const existing = this.requestLedger.get(claim.requestId)
    if (existing?.result) {
      return {
        kind: 'existing',
        requestHash: existing.requestHash,
        result: existing.result,
      }
    }
    this.requestLedger.set(claim.requestId, { requestHash: claim.requestHash })
    return { kind: 'claimed' }
  }

  async listViewedPages(): Promise<readonly number[]> {
    this.calls.push('list')
    return [...this.viewedPages]
  }

  async appendPageView(
    event: Parameters<ElearningDocumentPageViewTransaction['appendPageView']>[0],
  ): Promise<void> {
    this.calls.push('event')
    this.events.push(event)
    this.viewedPages.push(event.pageNumber)
  }

  async appendCompletionEvidenceIfAbsent(
    evidence: Parameters<
      ElearningDocumentPageViewTransaction['appendCompletionEvidenceIfAbsent']
    >[0],
  ): Promise<ElearningDocumentProgressSnapshot> {
    this.calls.push('evidence')
    this.completionInputs.push(evidence)
    const snapshot = completionSnapshot(evidence.evaluation, evidence.completedAt)
    this.authority = { ...this.authority!, completion: snapshot }
    return snapshot
  }

  async upsertProgress(
    progress: Parameters<ElearningDocumentPageViewTransaction['upsertProgress']>[0],
  ): Promise<void> {
    this.calls.push('progress')
    this.progressWrites.push(progress)
  }

  async storePageViewRequestResult(
    stored: Parameters<
      ElearningDocumentPageViewTransaction['storePageViewRequestResult']
    >[0],
  ): Promise<void> {
    this.calls.push('result')
    this.requestResults.push(stored)
    const request = this.requestLedger.get(stored.requestId)
    if (!request) throw new Error('request claim missing')
    request.result = stored.result
  }
}

describe('elearning document page-view runtime', () => {
  it('records a page and appends immutable completion effects in one transaction', async () => {
    const store = new FakeDocumentStore()
    store.viewedPages = [1, 2]
    const result = await recordElearningDocumentPageView(
      store,
      input(),
      () => new Date(NOW),
    )
    expect(result).toEqual({
      completedAt: NOW,
      evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      replayed: false,
      requiredPageCount: 3,
      serverPageCount: 4,
      status: 'completed',
      thresholdBps: 7_500,
      viewedPageCount: 3,
      viewedPageRanges: [{ endPage: 3, startPage: 1 }],
    })
    expect(store.calls).toEqual([
      'transaction',
      'lock',
      'claim',
      'list',
      'event',
      'evidence',
      'progress',
      'result',
    ])
    expect(store.events).toEqual([{
      courseVersionId: VERSION_ID,
      courseVersionItemId: ITEM_ID,
      orgId: ORG_ID,
      pageNumber: 3,
      receivedAt: NOW,
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      requestHashVersion: ELEARNING_DOCUMENT_PAGE_VIEW_REQUEST_HASH_VERSION,
      requestId: REQUEST_ID,
      sessionId: SESSION_ID,
      userId: USER_ID,
    }])
    expect(store.claims).toEqual([{
      courseVersionItemId: ITEM_ID,
      orgId: ORG_ID,
      requestHash: store.events[0].requestHash,
      requestHashVersion: ELEARNING_DOCUMENT_PAGE_VIEW_REQUEST_HASH_VERSION,
      requestId: REQUEST_ID,
      sessionId: SESSION_ID,
      userId: USER_ID,
    }])
    expect(store.completionInputs[0]).toMatchObject({
      accessBasis: { assignmentMemberId: MEMBER_ID, kind: 'assignment' },
      completedAt: NOW,
      courseVersionId: VERSION_ID,
      courseVersionItemId: ITEM_ID,
      documentMediaId: MEDIA_ID,
      orgId: ORG_ID,
      userId: USER_ID,
    })
    expect(store.progressWrites[0].snapshot).toEqual(
      store.requestResults[0].result,
    )
    expect(Object.keys(result)).toEqual([
      'completedAt',
      'evidenceDigest',
      'replayed',
      'requiredPageCount',
      'serverPageCount',
      'status',
      'thresholdBps',
      'viewedPageCount',
      'viewedPageRanges',
    ])
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('stores in-progress state without creating completion evidence', async () => {
    const store = new FakeDocumentStore()
    const result = await recordElearningDocumentPageView(
      store,
      input({ pageNumber: 1 }),
      () => new Date(NOW),
    )
    expect(result).toEqual({
      completedAt: null,
      evidenceDigest: null,
      replayed: false,
      requiredPageCount: 3,
      serverPageCount: 4,
      status: 'in_progress',
      thresholdBps: 7_500,
      viewedPageCount: 1,
      viewedPageRanges: [{ endPage: 1, startPage: 1 }],
    })
    expect(store.completionInputs).toEqual([])
    expect(store.calls).toEqual([
      'transaction', 'lock', 'claim', 'list', 'event', 'progress', 'result',
    ])
  })

  it('replays the stored result without duplicating any business effect', async () => {
    const store = new FakeDocumentStore()
    const first = await recordElearningDocumentPageView(
      store,
      input({ pageNumber: 1 }),
      () => new Date(NOW),
    )
    const effectCounts = {
      events: store.events.length,
      evidence: store.completionInputs.length,
      progress: store.progressWrites.length,
      results: store.requestResults.length,
    }
    const replay = await recordElearningDocumentPageView(
      store,
      input({ pageNumber: 1 }),
      () => new Date('2026-08-29T00:00:00.000Z'),
    )
    expect(replay).toEqual({ ...first, replayed: true })
    expect(store.events).toHaveLength(effectCounts.events)
    expect(store.completionInputs).toHaveLength(effectCounts.evidence)
    expect(store.progressWrites).toHaveLength(effectCounts.progress)
    expect(store.requestResults).toHaveLength(effectCounts.results)
    expect(store.calls.slice(-3)).toEqual(['transaction', 'lock', 'claim'])
  })

  it('rejects a reused request id when its logical page payload changes', async () => {
    const store = new FakeDocumentStore()
    await recordElearningDocumentPageView(
      store,
      input({ pageNumber: 1 }),
      () => new Date(NOW),
    )
    await expectCode(() => recordElearningDocumentPageView(
      store,
      input({ pageNumber: 2 }),
      () => new Date(NOW),
    ), 'conflict')
    expect(store.events).toHaveLength(1)
    expect(store.progressWrites).toHaveLength(1)
  })

  it('binds the request hash to the server-validated learning session', async () => {
    const store = new FakeDocumentStore()
    await recordElearningDocumentPageView(
      store,
      input({ pageNumber: 1 }),
      () => new Date(NOW),
    )
    store.authority = authority({ sessionId: OTHER_REQUEST_ID })
    await expectCode(() => recordElearningDocumentPageView(
      store,
      input({ pageNumber: 1, sessionId: OTHER_REQUEST_ID }),
      () => new Date(NOW),
    ), 'conflict')
    expect(store.events).toHaveLength(1)
    expect(store.progressWrites).toHaveLength(1)
  })

  it('deduplicates pages across prior events before evaluating completion', async () => {
    const store = new FakeDocumentStore()
    store.viewedPages = [1, 1, 2]
    const result = await recordElearningDocumentPageView(
      store,
      input({ pageNumber: 2 }),
      () => new Date(NOW),
    )
    expect(result).toMatchObject({
      status: 'in_progress',
      viewedPageCount: 2,
      viewedPageRanges: [{ endPage: 2, startPage: 1 }],
    })
  })

  it('uses the visibility rule as the optional completion access basis', async () => {
    const store = new FakeDocumentStore()
    store.authority = authority({
      accessBasis: { kind: 'visibility', scopeRevisionRuleId: RULE_ID },
    })
    store.viewedPages = [1, 2]
    await recordElearningDocumentPageView(store, input(), () => new Date(NOW))
    expect(store.completionInputs[0].accessBasis).toEqual({
      kind: 'visibility',
      scopeRevisionRuleId: RULE_ID,
    })
    expect(store.progressWrites[0].accessBasis).toEqual({
      kind: 'visibility',
      scopeRevisionRuleId: RULE_ID,
    })
  })

  it('returns existing completion for a new request without appending a late event', async () => {
    const store = new FakeDocumentStore()
    const existing: ElearningDocumentProgressSnapshot = Object.freeze({
      completedAt: NOW,
      evidenceDigest: 'a'.repeat(64),
      requiredPageCount: 3,
      serverPageCount: 4,
      status: 'completed',
      thresholdBps: 7_500,
      viewedPageCount: 3,
      viewedPageRanges: [{ endPage: 3, startPage: 1 }],
    })
    store.authority = authority({ completion: existing })
    const result = await recordElearningDocumentPageView(
      store,
      input({ requestId: OTHER_REQUEST_ID, pageNumber: 4 }),
      () => new Date('2026-08-29T00:00:00.000Z'),
    )
    expect(result).toEqual({ ...existing, replayed: false })
    expect(Object.isFrozen(result.viewedPageRanges)).toBe(true)
    expect(result.viewedPageRanges.every(Object.isFrozen)).toBe(true)
    expect(store.calls).toEqual(['transaction', 'lock', 'claim', 'result'])
    expect(store.events).toEqual([])
    expect(store.completionInputs).toEqual([])
    expect(store.progressWrites).toEqual([])
  })

  it('fails closed before claiming when access or server authority is unavailable', async () => {
    const denied = new FakeDocumentStore()
    denied.authority = null
    await expectCode(
      () => recordElearningDocumentPageView(denied, input()),
      'unavailable',
    )
    expect(denied.calls).toEqual(['transaction', 'lock'])
    expect(denied.claims).toEqual([])

    const corrupt = new FakeDocumentStore()
    corrupt.authority = authority({ serverPageCount: 0 })
    await expectCode(
      () => recordElearningDocumentPageView(corrupt, input()),
      'unavailable',
    )
    expect(corrupt.claims).toEqual([])

    for (const override of [
      { documentMediaKind: 'video' },
      { documentMediaStatus: 'probing' },
      { documentPageCountAuthority: 'client' },
    ]) {
      const untrusted = new FakeDocumentStore()
      untrusted.authority = authority(
        override as Partial<ElearningDocumentAuthority>,
      )
      await expectCode(
        () => recordElearningDocumentPageView(untrusted, input()),
        'unavailable',
      )
      expect(untrusted.claims).toEqual([])
    }

    const dualBasis = new FakeDocumentStore()
    dualBasis.authority = authority({
      accessBasis: {
        assignmentMemberId: MEMBER_ID,
        kind: 'assignment',
        scopeRevisionRuleId: RULE_ID,
      } as unknown as ElearningDocumentAuthority['accessBasis'],
    })
    await expectCode(
      () => recordElearningDocumentPageView(dualBasis, input()),
      'unavailable',
    )
    expect(dualBasis.claims).toEqual([])

    const wrongSession = new FakeDocumentStore()
    wrongSession.authority = authority({ sessionId: OTHER_REQUEST_ID })
    await expectCode(
      () => recordElearningDocumentPageView(wrongSession, input()),
      'unavailable',
    )
    expect(wrongSession.claims).toEqual([])
  })

  it('rejects a corrupt stored replay snapshot instead of exposing it', async () => {
    const store = new FakeDocumentStore()
    await recordElearningDocumentPageView(
      store,
      input({ pageNumber: 1 }),
      () => new Date(NOW),
    )
    const request = store.requestLedger.get(REQUEST_ID)!
    request.result = {
      completedAt: null,
      evidenceDigest: null,
      requiredPageCount: 3,
      serverPageCount: 4,
      status: 'in_progress',
      thresholdBps: 8_000,
      viewedPageCount: 1,
      viewedPageRanges: [{ endPage: 1, startPage: 1 }],
    }
    await expectCode(
      () => recordElearningDocumentPageView(store, input({ pageNumber: 1 })),
      'unavailable',
    )
    expect(store.events).toHaveLength(1)
    expect(store.progressWrites).toHaveLength(1)
  })

  it('rejects page numbers beyond the server-probed bound before claiming', async () => {
    const store = new FakeDocumentStore()
    await expectCode(
      () => recordElearningDocumentPageView(store, input({ pageNumber: 5 })),
      'invalid_input',
    )
    expect(store.calls).toEqual(['transaction', 'lock'])
    expect(store.claims).toEqual([])
  })

  it('accepts only the closed client command and never accepts completed', async () => {
    for (const value of [
      null,
      {},
      { ...input(), completed: true },
      input({ courseVersionItemId: 'item-1' }),
      input({ orgId: '' }),
      input({ pageNumber: 0 }),
      input({ pageNumber: 1.5 }),
      input({ requestId: 'request-1' }),
      input({ sessionId: 'session-1' }),
      input({ userId: '' }),
    ]) {
      const store = new FakeDocumentStore()
      await expectCode(
        () => recordElearningDocumentPageView(store, value),
        'invalid_input',
      )
      expect(store.calls).toEqual([])
    }
  })

  it('keeps adapter failures values-free', async () => {
    const store = new FakeDocumentStore()
    store.throwFromLock = true
    await expectCode(
      () => recordElearningDocumentPageView(store, input()),
      'unavailable',
    )
  })
})

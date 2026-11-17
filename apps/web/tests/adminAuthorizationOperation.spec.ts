import { describe, expect, it } from 'vitest'
import { useAdminAuthorizationOperation } from '../src/composables/useAdminAuthorizationOperation'
import {
  ADMIN_AUTHORIZATION_OPERATIONS_PATH,
  ADMIN_AUTHORIZATION_PENDING_STORAGE_KEY,
  ADMIN_AUTHORIZATION_PREVIEW_PATH,
  adminAuthorizationOperationLookupPath,
  readAdminAuthorizationAction,
  readAdminAuthorizationImpact,
  readAdminAuthorizationReceipt,
  readAdminAuthorizationRequest,
  type AdminAuthorizationEffectivePermission,
  type AdminAuthorizationImpact,
  type AdminAuthorizationRequest,
  type AdminAuthorizationTransportRequest,
  type AdminAuthorizationTransportResponse,
} from '../src/utils/adminAuthorizationOperation'

const PRINCIPAL = 'principal-1'
const TARGET = 'target-1'
const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_OPERATION_ID = '33333333-3333-4333-8333-333333333333'

function platformAdminSources() {
  return [
    { kind: 'role' as const, id: 'admin' },
    { kind: 'profile' as const, id: null },
  ]
}

function grant(
  code: string,
  sources: AdminAuthorizationEffectivePermission['sources'],
  effective = true,
): AdminAuthorizationEffectivePermission {
  return { code, sources, effective }
}

function impact(effectiveAfter = [
  grant('*:*', platformAdminSources()),
]): AdminAuthorizationImpact {
  return {
    sourceChanges: [
      { source: 'role', id: 'admin', operation: 'assign', changed: true },
      { source: 'direct', id: 'grant-1', operation: 'revoke', changed: false },
      { source: 'legacy', id: 'old-1', operation: 'revoke', changed: true },
    ],
    admissionChanges: [
      { namespace: 'attendance', before: null, after: true, cause: 'explicit' },
      { namespace: 'project', before: true, after: false, cause: 'role_revoke' },
    ],
    scopeCleanup: [
      { namespace: 'attendance', kind: 'department', id: 'dept-1' },
      { namespace: 'project', kind: 'member_group', id: 'group-1' },
    ],
    effectiveBefore: [
      grant('sheet:write', [{ kind: 'direct', id: null }], false),
    ],
    effectiveAfter,
    retainedOtherGrants: [
      grant('sheet:read', [{ kind: 'legacy', id: null }], false),
    ],
    warnings: ['kept'],
  }
}

function operationRequest(roleId = 'role-1'): AdminAuthorizationRequest {
  return {
    targetUserId: TARGET,
    action: { kind: 'role.assign', roleId },
    admissionChanges: [{ namespace: 'attendance', enabled: true }],
    reason: 'cover the desk',
  }
}

function previewFor(roleId: string, version: string): AdminAuthorizationTransportResponse {
  return {
    status: 200,
    body: {
      expectedVersion: version,
      impact: impact([grant(`${roleId}:use`, [{ kind: 'role', id: roleId }])]),
    },
  }
}

function roleIdOf(request: AdminAuthorizationTransportRequest): string | null {
  if (typeof request.body !== 'object' || request.body === null || !('action' in request.body)) return null
  const action = request.body.action
  if (typeof action !== 'object' || action === null || !('roleId' in action)) return null
  return typeof action.roleId === 'string' ? action.roleId : null
}

function previewResponse(): AdminAuthorizationTransportResponse {
  return { status: 200, body: { expectedVersion: 'version-1', impact: impact() } }
}

function committedBody(id = OPERATION_ID): AdminAuthorizationTransportResponse {
  return {
    status: 200,
    body: {
      status: 'committed',
      clientOperationId: id,
      receipt: {
        targetUserId: TARGET,
        action: { kind: 'role.assign', roleId: 'role-1' },
        impact: impact(),
        resultVersion: 'version-2',
      },
    },
  }
}

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
  }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (reason?: unknown) => void = () => {}
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

function createHarness(options: {
  storage?: Pick<Storage, 'getItem' | 'setItem'>
  principal?: string
  target?: string
  verifyLive?: () => Promise<boolean>
  createClientOperationId?: () => string
  handler: (request: AdminAuthorizationTransportRequest) => Promise<AdminAuthorizationTransportResponse> | AdminAuthorizationTransportResponse
}) {
  let principal = options.principal ?? PRINCIPAL
  let target = options.target ?? TARGET
  const live = { run: options.verifyLive ?? (async () => false) }
  const calls: AdminAuthorizationTransportRequest[] = []
  const storage = options.storage ?? memoryStorage()
  const operation = useAdminAuthorizationOperation({
    transport: async (request) => {
      calls.push(request)
      return options.handler(request)
    },
    getPrincipalId: () => principal,
    getTargetId: () => target,
    verifyLive: () => live.run(),
    storage,
    createClientOperationId: options.createClientOperationId ?? (() => OPERATION_ID),
  })
  return {
    operation,
    calls,
    storage,
    setPrincipal(value: string) {
      principal = value
    },
    setTarget(value: string) {
      target = value
    },
    setVerifyLive(run: () => Promise<boolean>) {
      live.run = run
    },
    posts() {
      return calls.filter((call) => call.method === 'POST' && call.path === ADMIN_AUTHORIZATION_OPERATIONS_PATH)
    },
    gets() {
      return calls.filter((call) => call.method === 'GET')
    },
  }
}

async function previewed(harness: ReturnType<typeof createHarness>) {
  await harness.operation.preview(operationRequest())
  expect(harness.operation.phase.value).toBe('awaiting_confirmation')
}

describe('admin authorization operation recovery', () => {
  it('posts the commit once when confirm is invoked twice in the same turn', async () => {
    const gate = deferred<AdminAuthorizationTransportResponse>()
    const harness = createHarness({
      handler: (request) => {
        if (request.path === ADMIN_AUTHORIZATION_PREVIEW_PATH) return previewResponse()
        return gate.promise
      },
    })
    await previewed(harness)
    const first = harness.operation.confirm()
    const second = harness.operation.confirm()
    expect(harness.posts()).toHaveLength(1)
    expect(harness.posts()[0]?.body).toEqual({
      ...operationRequest(),
      clientOperationId: OPERATION_ID,
      expectedVersion: 'version-1',
    })
    gate.resolve(committedBody())
    await Promise.all([first, second])
    expect(harness.posts()).toHaveLength(1)
    expect(harness.operation.phase.value).toBe('committed')
    expect(harness.operation.detail.value).toBe('receipt_only')
    expect(harness.operation.verified.value).toBe(false)
    expect(harness.operation.receipt.value?.resultVersion).toBe('version-2')
  })

  it('stays pending and does not rebuild the POST when the commit response is lost', async () => {
    const harness = createHarness({
      handler: (request) => {
        if (request.path === ADMIN_AUTHORIZATION_PREVIEW_PATH) return previewResponse()
        throw new Error('response lost')
      },
    })
    await previewed(harness)
    await harness.operation.confirm()
    expect(harness.operation.phase.value).toBe('pending')
    expect(harness.operation.verified.value).toBe(false)
    expect(harness.operation.receipt.value).toBeNull()
    const raw = harness.storage.getItem(ADMIN_AUTHORIZATION_PENDING_STORAGE_KEY)
    expect(raw).toBe(JSON.stringify({
      formatVersion: 1,
      entries: [{ principalId: PRINCIPAL, targetId: TARGET, clientOperationId: OPERATION_ID }],
    }))
    expect(raw).not.toContain('cover the desk')
    expect(raw).not.toContain('role-1')
    await harness.operation.confirm()
    await harness.operation.preview(operationRequest())
    expect(harness.posts()).toHaveLength(1)
    expect(harness.calls.filter((call) => call.path === ADMIN_AUTHORIZATION_PREVIEW_PATH)).toHaveLength(1)
  })

  it('treats a commit 5xx as pending and only GETs afterwards', async () => {
    let lookups = 0
    const harness = createHarness({
      handler: (request) => {
        if (request.path === ADMIN_AUTHORIZATION_PREVIEW_PATH) return previewResponse()
        if (request.method === 'POST') return { status: 503, body: { error: 'unavailable' } }
        lookups += 1
        return { status: 200, body: { status: 'unknown_or_pending', clientOperationId: OPERATION_ID } }
      },
    })
    await previewed(harness)
    await harness.operation.confirm()
    expect(harness.operation.phase.value).toBe('pending')
    expect(harness.operation.verified.value).toBe(false)
    await harness.operation.lookup()
    expect(lookups).toBe(1)
    expect(harness.gets()[0]?.path).toBe(adminAuthorizationOperationLookupPath(OPERATION_ID))
    expect(harness.gets()[0]?.body).toBeUndefined()
    expect(harness.posts()).toHaveLength(1)
    expect(harness.operation.phase.value).toBe('pending')
  })

  it('moves from unknown to a receipt with GET and does not POST again', async () => {
    const gate = deferred<AdminAuthorizationTransportResponse>()
    let lookups = 0
    const harness = createHarness({
      handler: (request) => {
        if (request.path === ADMIN_AUTHORIZATION_PREVIEW_PATH) return previewResponse()
        if (request.method === 'POST') return gate.promise
        lookups += 1
        if (lookups === 1) {
          return { status: 200, body: { status: 'unknown_or_pending', clientOperationId: OPERATION_ID } }
        }
        if (lookups === 2) return committedBody()
        return { status: 404, body: {} }
      },
    })
    await previewed(harness)
    const confirming = harness.operation.confirm()
    await harness.operation.lookup()
    expect(harness.operation.phase.value).toBe('pending')
    expect(harness.operation.verified.value).toBe(false)
    await harness.operation.lookup()
    expect(harness.operation.phase.value).toBe('committed')
    expect(harness.operation.detail.value).toBe('receipt_only')
    expect(harness.operation.verified.value).toBe(false)
    gate.resolve({ status: 500, body: null })
    await confirming
    expect(harness.posts()).toHaveLength(1)
    expect(harness.gets()).toHaveLength(2)
    expect(harness.operation.phase.value).toBe('committed')
    expect(harness.operation.verified.value).toBe(false)
    await harness.operation.lookup()
    expect(harness.operation.phase.value).toBe('committed')
    expect(harness.operation.verified.value).toBe(false)
    expect(harness.posts()).toHaveLength(1)
  })

  it('reloads a matching pending id with one GET and no POST', async () => {
    const storage = memoryStorage()
    storage.setItem(ADMIN_AUTHORIZATION_PENDING_STORAGE_KEY, JSON.stringify({
      formatVersion: 1,
      entries: [
        { principalId: PRINCIPAL, targetId: TARGET, clientOperationId: OPERATION_ID },
        {
          principalId: 'principal-2',
          targetId: TARGET,
          clientOperationId: '22222222-2222-4222-8222-222222222222',
        },
      ],
    }))
    const harness = createHarness({
      storage,
      handler: (request) => {
        if (request.method !== 'GET') throw new Error(`unexpected ${request.method} ${request.path}`)
        return { status: 200, body: { status: 'unknown_or_pending', clientOperationId: OPERATION_ID } }
      },
    })
    await harness.operation.whenSettled()
    expect(harness.posts()).toHaveLength(0)
    expect(harness.gets()).toHaveLength(1)
    expect(harness.operation.phase.value).toBe('pending')
    expect(harness.operation.verified.value).toBe(false)
    await harness.operation.confirm()
    expect(harness.posts()).toHaveLength(0)
    expect(harness.storage.getItem(ADMIN_AUTHORIZATION_PENDING_STORAGE_KEY)).toContain('principal-2')
  })

  it('ignores a late commit after the principal or target changes', async () => {
    const storage = memoryStorage()
    const gate = deferred<AdminAuthorizationTransportResponse>()
    const harness = createHarness({
      storage,
      handler: (request) => {
        if (request.path === ADMIN_AUTHORIZATION_PREVIEW_PATH) return previewResponse()
        if (request.method === 'POST') return gate.promise
        return { status: 200, body: { status: 'unknown_or_pending', clientOperationId: OPERATION_ID } }
      },
    })
    await previewed(harness)
    const confirming = harness.operation.confirm()
    expect(harness.posts()).toHaveLength(1)
    harness.setPrincipal('principal-2')
    gate.resolve(committedBody())
    await confirming
    expect(harness.operation.phase.value).toBe('idle')
    expect(harness.operation.verified.value).toBe(false)
    expect(harness.operation.receipt.value).toBeNull()
    expect(JSON.parse(harness.storage.getItem(ADMIN_AUTHORIZATION_PENDING_STORAGE_KEY) ?? '{}')).toEqual({
      formatVersion: 1,
      entries: [{ principalId: PRINCIPAL, targetId: TARGET, clientOperationId: OPERATION_ID }],
    })

    harness.setTarget('target-2')
    harness.operation.syncContext()
    await harness.operation.whenSettled()
    expect(harness.operation.phase.value).toBe('idle')
    expect(harness.posts()).toHaveLength(1)

    harness.setPrincipal(PRINCIPAL)
    harness.setTarget(TARGET)
    harness.operation.syncContext()
    await harness.operation.whenSettled()
    expect(harness.posts()).toHaveLength(1)
    expect(harness.gets()).toHaveLength(1)
    expect(harness.operation.phase.value).toBe('pending')
    expect(harness.operation.verified.value).toBe(false)
  })

  it('shows validation failure for 409 and allows an explicit new preview', async () => {
    let commits = 0
    const harness = createHarness({
      handler: (request) => {
        if (request.path === ADMIN_AUTHORIZATION_PREVIEW_PATH) return previewResponse()
        commits += 1
        if (commits === 1) return { status: 409, body: { error: 'version' } }
        return committedBody()
      },
    })
    await previewed(harness)
    await harness.operation.confirm()
    expect(harness.operation.phase.value).toBe('validation_failed')
    expect(harness.operation.detail.value).toBe('needs_repreview')
    expect(harness.operation.verified.value).toBe(false)
    expect(harness.operation.receipt.value).toBeNull()
    expect(JSON.parse(harness.storage.getItem(ADMIN_AUTHORIZATION_PENDING_STORAGE_KEY) ?? '{"entries":[]}')).toEqual({
      formatVersion: 1,
      entries: [],
    })
    await harness.operation.confirm()
    expect(harness.posts()).toHaveLength(1)
    await previewed(harness)
    await harness.operation.confirm()
    expect(harness.posts()).toHaveLength(2)
    expect(harness.operation.phase.value).toBe('committed')
    expect(harness.operation.verified.value).toBe(false)
  })

  it('shows no access for commit 403 and does not mark the operation verified', async () => {
    const harness = createHarness({
      handler: (request) => {
        if (request.path === ADMIN_AUTHORIZATION_PREVIEW_PATH) return previewResponse()
        return { status: 403, body: { error: 'forbidden' } }
      },
    })
    await previewed(harness)
    await harness.operation.confirm()
    expect(harness.operation.phase.value).toBe('forbidden')
    expect(harness.operation.detail.value).toBe('no_access')
    expect(harness.operation.verified.value).toBe(false)
    expect(harness.operation.receipt.value).toBeNull()
    expect(harness.posts()).toHaveLength(1)
  })

  it('keeps a malformed committed body pending instead of showing success', async () => {
    const harness = createHarness({
      handler: (request) => {
        if (request.path === ADMIN_AUTHORIZATION_PREVIEW_PATH) return previewResponse()
        return {
          status: 200,
          body: {
            status: 'committed',
            clientOperationId: OPERATION_ID,
            receipt: { targetUserId: TARGET, resultVersion: 'version-2' },
          },
        }
      },
    })
    await previewed(harness)
    await harness.operation.confirm()
    expect(harness.operation.phase.value).toBe('pending')
    expect(harness.operation.detail.value).toBe('pending')
    expect(harness.operation.verified.value).toBe(false)
    expect(harness.operation.receipt.value).toBeNull()
    expect(harness.storage.getItem(ADMIN_AUTHORIZATION_PENDING_STORAGE_KEY)).toContain(OPERATION_ID)
    await harness.operation.confirm()
    expect(harness.posts()).toHaveLength(1)
  })

  it('reports an unverified missing read when lookup returns 403 or 404', async () => {
    const storage = memoryStorage()
    storage.setItem(ADMIN_AUTHORIZATION_PENDING_STORAGE_KEY, JSON.stringify({
      formatVersion: 1,
      entries: [{ principalId: PRINCIPAL, targetId: TARGET, clientOperationId: OPERATION_ID }],
    }))
    const forbidden = createHarness({
      storage,
      handler: () => ({ status: 403, body: {} }),
    })
    await forbidden.operation.whenSettled()
    expect(forbidden.operation.phase.value).toBe('unverified_no_read')
    expect(forbidden.operation.detail.value).toBe('unverified_no_read')
    expect(forbidden.operation.verified.value).toBe(false)
    expect(forbidden.posts()).toHaveLength(0)

    const missingStorage = memoryStorage()
    missingStorage.setItem(ADMIN_AUTHORIZATION_PENDING_STORAGE_KEY, JSON.stringify({
      formatVersion: 1,
      entries: [{ principalId: PRINCIPAL, targetId: TARGET, clientOperationId: OPERATION_ID }],
    }))
    const missing = createHarness({
      storage: missingStorage,
      handler: (request) => {
        if (request.method !== 'GET') throw new Error(`unexpected ${request.method}`)
        return { status: 404, body: {} }
      },
    })
    await missing.operation.whenSettled()
    expect(missing.operation.phase.value).toBe('pending')
    expect(missing.operation.verified.value).toBe(false)
    expect(missing.posts()).toHaveLength(0)
  })

  it('keeps a failed live read unverified until the live read returns true', async () => {
    const live = createHarness({
      verifyLive: async () => false,
      handler: (request) => {
        if (request.path === ADMIN_AUTHORIZATION_PREVIEW_PATH) return previewResponse()
        return committedBody()
      },
    })
    await previewed(live)
    await live.operation.confirm()
    await live.operation.verify()
    expect(live.operation.phase.value).toBe('committed')
    expect(live.operation.detail.value).toBe('receipt_only')
    expect(live.operation.verified.value).toBe(false)
    expect(live.storage.getItem(ADMIN_AUTHORIZATION_PENDING_STORAGE_KEY)).toContain(OPERATION_ID)
    live.setVerifyLive(async () => {
      throw new Error('live read failed')
    })
    await live.operation.verify()
    expect(live.operation.verified.value).toBe(false)
    expect(live.operation.phase.value).toBe('committed')
    live.setVerifyLive(async () => true)
    await live.operation.verify()
    expect(live.operation.phase.value).toBe('verified')
    expect(live.operation.verified.value).toBe(true)
    expect(live.operation.detail.value).toBe('verified')
    expect(JSON.parse(live.storage.getItem(ADMIN_AUTHORIZATION_PENDING_STORAGE_KEY) ?? '{}')).toEqual({
      formatVersion: 1,
      entries: [],
    })
  })

  it('accepts a profile source on synthetic platform-admin access and still requires a live read', async () => {
    const profileOnly = createHarness({
      handler: (request) => {
        if (request.path === ADMIN_AUTHORIZATION_PREVIEW_PATH) {
          return {
            status: 200,
            body: {
              expectedVersion: 'version-1',
              impact: impact([grant('*:*', [{ kind: 'profile', id: null }])]),
            },
          }
        }
        return {
          status: 200,
          body: {
            status: 'committed',
            clientOperationId: OPERATION_ID,
            receipt: {
              targetUserId: TARGET,
              action: { kind: 'role.assign', roleId: 'role-1' },
              impact: impact([grant('*:*', [{ kind: 'profile', id: null }])]),
              resultVersion: 'version-2',
            },
          },
        }
      },
    })
    await previewed(profileOnly)
    expect(profileOnly.operation.impact.value?.effectiveAfter).toEqual([
      { code: '*:*', sources: [{ kind: 'profile', id: null }], effective: true },
    ])
    await profileOnly.operation.confirm()
    expect(profileOnly.operation.phase.value).toBe('committed')
    expect(profileOnly.operation.detail.value).toBe('receipt_only')
    expect(profileOnly.operation.verified.value).toBe(false)
    expect(profileOnly.operation.receipt.value?.impact.effectiveAfter[0]?.sources).toEqual([
      { kind: 'profile', id: null },
    ])

    const both = createHarness({
      handler: (request) => {
        if (request.path === ADMIN_AUTHORIZATION_PREVIEW_PATH) return previewResponse()
        return committedBody()
      },
    })
    await previewed(both)
    await both.operation.confirm()
    expect(both.operation.phase.value).toBe('committed')
    expect(both.operation.verified.value).toBe(false)
    expect(both.operation.receipt.value?.impact.effectiveAfter).toEqual([
      { code: '*:*', sources: platformAdminSources(), effective: true },
    ])
  })

  it('does not treat a profile source with an id as a committed receipt', async () => {
    const harness = createHarness({
      handler: (request) => {
        if (request.path === ADMIN_AUTHORIZATION_PREVIEW_PATH) return previewResponse()
        return {
          status: 200,
          body: {
            status: 'committed',
            clientOperationId: OPERATION_ID,
            receipt: {
              targetUserId: TARGET,
              action: { kind: 'role.assign', roleId: 'role-1' },
              impact: {
                ...impact(),
                effectiveAfter: [{ code: '*:*', sources: [{ kind: 'profile', id: 'admin' }], effective: true }],
              },
              resultVersion: 'version-2',
            },
          },
        }
      },
    })
    await previewed(harness)
    await harness.operation.confirm()
    expect(harness.operation.phase.value).toBe('pending')
    expect(harness.operation.verified.value).toBe(false)
    expect(harness.operation.receipt.value).toBeNull()
    expect(harness.posts()).toHaveLength(1)
  })

  it('does not send the commit when storing the pending marker throws', async () => {
    let writes = 0
    const harness = createHarness({
      storage: {
        getItem: () => null,
        setItem: () => {
          writes += 1
          throw new Error('storage unavailable')
        },
      },
      handler: (request) => {
        if (request.path === ADMIN_AUTHORIZATION_PREVIEW_PATH) return previewResponse()
        return committedBody()
      },
    })
    await previewed(harness)
    await harness.operation.confirm()
    expect(writes).toBe(1)
    expect(harness.posts()).toHaveLength(0)
    expect(harness.operation.clientOperationId.value).toBeNull()
    expect(harness.operation.phase.value).toBe('pending')
    expect(harness.operation.detail.value).toBe('storage_blocked')
    expect(harness.operation.verified.value).toBe(false)
    expect(harness.operation.receipt.value).toBeNull()
    await harness.operation.confirm()
    expect(harness.posts()).toHaveLength(0)
    expect(writes).toBe(1)
  })

  it('keeps the later preview when an earlier preview response arrives afterwards', async () => {
    const earlier = deferred<AdminAuthorizationTransportResponse>()
    const later = deferred<AdminAuthorizationTransportResponse>()
    const harness = createHarness({
      handler: (request) => {
        if (request.path === ADMIN_AUTHORIZATION_PREVIEW_PATH) {
          return roleIdOf(request) === 'role-b' ? later.promise : earlier.promise
        }
        return committedBody()
      },
    })
    const pendingEarlier = harness.operation.preview(operationRequest('role-a'))
    const pendingLater = harness.operation.preview(operationRequest('role-b'))
    expect(harness.calls.filter((call) => call.path === ADMIN_AUTHORIZATION_PREVIEW_PATH)).toHaveLength(2)
    later.resolve(previewFor('role-b', 'version-b'))
    await pendingLater
    expect(harness.operation.phase.value).toBe('awaiting_confirmation')
    expect(harness.operation.expectedVersion.value).toBe('version-b')
    expect(harness.operation.impact.value?.effectiveAfter).toEqual([
      { code: 'role-b:use', sources: [{ kind: 'role', id: 'role-b' }], effective: true },
    ])
    earlier.resolve(previewFor('role-a', 'version-a'))
    await pendingEarlier
    expect(harness.operation.phase.value).toBe('awaiting_confirmation')
    expect(harness.operation.expectedVersion.value).toBe('version-b')
    expect(harness.operation.impact.value?.effectiveAfter).toEqual([
      { code: 'role-b:use', sources: [{ kind: 'role', id: 'role-b' }], effective: true },
    ])
    await harness.operation.confirm()
    expect(harness.posts()).toHaveLength(1)
    expect(harness.posts()[0]?.body).toEqual({
      ...operationRequest('role-b'),
      clientOperationId: OPERATION_ID,
      expectedVersion: 'version-b',
    })
    expect(harness.operation.phase.value).toBe('committed')
    expect(harness.operation.verified.value).toBe(false)
  })

  it('does not post again when a late preview arrives after a lost commit is read back', async () => {
    const earlier = deferred<AdminAuthorizationTransportResponse>()
    const later = deferred<AdminAuthorizationTransportResponse>()
    const lostCommit = deferred<AdminAuthorizationTransportResponse>()
    const harness = createHarness({
      handler: (request) => {
        if (request.path === ADMIN_AUTHORIZATION_PREVIEW_PATH) {
          return roleIdOf(request) === 'role-b' ? later.promise : earlier.promise
        }
        if (request.method === 'POST') return lostCommit.promise
        return committedBody()
      },
    })
    const pendingEarlier = harness.operation.preview(operationRequest('role-a'))
    const pendingLater = harness.operation.preview(operationRequest('role-b'))
    later.resolve(previewFor('role-b', 'version-b'))
    await pendingLater
    const confirming = harness.operation.confirm()
    expect(harness.posts()).toHaveLength(1)
    expect(harness.posts()[0]?.body).toEqual({
      ...operationRequest('role-b'),
      clientOperationId: OPERATION_ID,
      expectedVersion: 'version-b',
    })
    lostCommit.reject(new Error('response lost'))
    await confirming
    expect(harness.operation.phase.value).toBe('pending')
    expect(harness.posts()).toHaveLength(1)
    await harness.operation.lookup()
    expect(harness.gets()).toHaveLength(1)
    expect(harness.gets()[0]?.path).toBe(adminAuthorizationOperationLookupPath(OPERATION_ID))
    expect(harness.operation.phase.value).toBe('committed')
    expect(harness.operation.detail.value).toBe('receipt_only')
    expect(harness.operation.verified.value).toBe(false)
    expect(harness.operation.clientOperationId.value).toBe(OPERATION_ID)
    expect(harness.operation.receipt.value?.resultVersion).toBe('version-2')
    earlier.resolve(previewFor('role-a', 'version-a'))
    await pendingEarlier
    expect(harness.operation.phase.value).toBe('committed')
    expect(harness.operation.detail.value).toBe('receipt_only')
    expect(harness.operation.expectedVersion.value).toBe('version-b')
    expect(harness.operation.clientOperationId.value).toBe(OPERATION_ID)
    expect(harness.operation.impact.value?.effectiveAfter).toEqual(impact().effectiveAfter)
    await harness.operation.confirm()
    expect(harness.posts()).toHaveLength(1)
    expect(harness.operation.phase.value).toBe('committed')
    expect(harness.operation.verified.value).toBe(false)
    expect(JSON.parse(harness.storage.getItem(ADMIN_AUTHORIZATION_PENDING_STORAGE_KEY) ?? '{}')).toEqual({
      formatVersion: 1,
      entries: [{ principalId: PRINCIPAL, targetId: TARGET, clientOperationId: OPERATION_ID }],
    })
  })

  it('does not let a second instance replace a pending id that it did not submit', async () => {
    const storage = memoryStorage()
    const lostCommit = deferred<AdminAuthorizationTransportResponse>()
    const first = createHarness({
      storage,
      handler: (request) => {
        if (request.path === ADMIN_AUTHORIZATION_PREVIEW_PATH) return previewResponse()
        if (request.method === 'POST') return lostCommit.promise
        throw new Error(`unexpected ${request.method} ${request.path}`)
      },
    })
    const second = createHarness({
      storage,
      createClientOperationId: () => OTHER_OPERATION_ID,
      handler: (request) => {
        if (request.path === ADMIN_AUTHORIZATION_PREVIEW_PATH) return previewResponse()
        if (request.method === 'GET') {
          return { status: 200, body: { status: 'unknown_or_pending', clientOperationId: OPERATION_ID } }
        }
        return committedBody(OTHER_OPERATION_ID)
      },
    })
    await previewed(first)
    await previewed(second)
    const confirming = first.operation.confirm()
    expect(first.posts()).toHaveLength(1)
    const adopting = second.operation.confirm()
    expect(second.posts()).toHaveLength(0)
    expect(second.operation.phase.value).toBe('pending')
    expect(second.operation.clientOperationId.value).toBe(OPERATION_ID)
    expect(JSON.parse(storage.getItem(ADMIN_AUTHORIZATION_PENDING_STORAGE_KEY) ?? '{}')).toEqual({
      formatVersion: 1,
      entries: [{ principalId: PRINCIPAL, targetId: TARGET, clientOperationId: OPERATION_ID }],
    })
    lostCommit.reject(new Error('response lost'))
    await confirming
    await adopting
    expect(first.operation.phase.value).toBe('pending')
    expect(first.posts()).toHaveLength(1)
    expect(second.posts()).toHaveLength(0)
    expect(second.gets()).toHaveLength(1)
    expect(second.gets()[0]?.path).toBe(adminAuthorizationOperationLookupPath(OPERATION_ID))
    expect(second.operation.phase.value).toBe('pending')
    expect(second.operation.detail.value).toBe('pending')
    expect(second.operation.verified.value).toBe(false)
    expect(second.operation.clientOperationId.value).toBe(OPERATION_ID)
    expect(storage.getItem(ADMIN_AUTHORIZATION_PENDING_STORAGE_KEY)).not.toContain(OTHER_OPERATION_ID)
  })

  it('blocks an empty stored record and still posts on a null first use', async () => {
    let blankWrites = 0
    const blank = createHarness({
      storage: {
        getItem: () => '',
        setItem: () => {
          blankWrites += 1
        },
      },
      handler: (request) => {
        if (request.path === ADMIN_AUTHORIZATION_PREVIEW_PATH) return previewResponse()
        return committedBody()
      },
    })
    expect(blank.operation.phase.value).toBe('pending')
    expect(blank.operation.detail.value).toBe('storage_blocked')
    expect(blank.operation.verified.value).toBe(false)
    await blank.operation.preview(operationRequest())
    await blank.operation.confirm()
    expect(blank.calls.filter((call) => call.path === ADMIN_AUTHORIZATION_PREVIEW_PATH)).toHaveLength(0)
    expect(blank.posts()).toHaveLength(0)
    expect(blankWrites).toBe(0)
    expect(blank.operation.detail.value).toBe('storage_blocked')
    expect(blank.operation.clientOperationId.value).toBeNull()

    const freshStorage = memoryStorage()
    expect(freshStorage.getItem(ADMIN_AUTHORIZATION_PENDING_STORAGE_KEY)).toBeNull()
    const fresh = createHarness({
      storage: freshStorage,
      handler: (request) => {
        if (request.path === ADMIN_AUTHORIZATION_PREVIEW_PATH) return previewResponse()
        return committedBody()
      },
    })
    expect(fresh.operation.phase.value).toBe('idle')
    expect(fresh.operation.detail.value).toBe('none')
    await previewed(fresh)
    await fresh.operation.confirm()
    expect(fresh.posts()).toHaveLength(1)
    expect(fresh.operation.phase.value).toBe('committed')
    expect(fresh.operation.detail.value).toBe('receipt_only')
    expect(fresh.operation.verified.value).toBe(false)
    expect(fresh.operation.clientOperationId.value).toBe(OPERATION_ID)
    expect(JSON.parse(freshStorage.getItem(ADMIN_AUTHORIZATION_PENDING_STORAGE_KEY) ?? '{}')).toEqual({
      formatVersion: 1,
      entries: [{ principalId: PRINCIPAL, targetId: TARGET, clientOperationId: OPERATION_ID }],
    })
  })
})

describe('admin authorization operation dto', () => {
  it('keeps a false effective flag and accepts direct and legacy sources', async () => {
    const after = [
      grant('sheet:write', [{ kind: 'direct', id: null }], false),
      grant('sheet:read', [
        { kind: 'legacy', id: null },
        { kind: 'role', id: 'role-1' },
      ], true),
    ]
    const harness = createHarness({
      handler: (request) => {
        if (request.path === ADMIN_AUTHORIZATION_PREVIEW_PATH) {
          return { status: 200, body: { expectedVersion: 'version-1', impact: impact(after) } }
        }
        return {
          status: 200,
          body: {
            status: 'committed',
            clientOperationId: OPERATION_ID,
            receipt: {
              targetUserId: TARGET,
              action: { kind: 'direct.grant', code: 'sheet:write' },
              impact: impact(after),
              resultVersion: 'version-2',
            },
          },
        }
      },
    })
    await previewed(harness)
    expect(harness.operation.impact.value?.effectiveBefore).toEqual(impact().effectiveBefore)
    expect(harness.operation.impact.value?.effectiveAfter).toEqual(after)
    expect(harness.operation.impact.value?.retainedOtherGrants).toEqual(impact().retainedOtherGrants)
    await harness.operation.confirm()
    expect(harness.operation.phase.value).toBe('committed')
    expect(harness.operation.verified.value).toBe(false)
    expect(harness.operation.receipt.value?.action).toEqual({ kind: 'direct.grant', code: 'sheet:write' })
    expect(harness.operation.receipt.value?.impact.effectiveAfter[0]?.effective).toBe(false)
  })

  it('does not treat a direct or legacy source with an id as success', async () => {
    const preview = createHarness({
      handler: () => ({
        status: 200,
        body: {
          expectedVersion: 'version-1',
          impact: {
            ...impact(),
            effectiveAfter: [
              { code: 'sheet:write', sources: [{ kind: 'direct', id: 'grant-1' }], effective: true },
            ],
          },
        },
      }),
    })
    await preview.operation.preview(operationRequest())
    expect(preview.operation.phase.value).toBe('idle')
    expect(preview.operation.detail.value).toBe('preview_failed')
    expect(preview.operation.impact.value).toBeNull()

    const commit = createHarness({
      handler: (request) => {
        if (request.path === ADMIN_AUTHORIZATION_PREVIEW_PATH) return previewResponse()
        return {
          status: 200,
          body: {
            status: 'committed',
            clientOperationId: OPERATION_ID,
            receipt: {
              targetUserId: TARGET,
              action: { kind: 'legacy.revoke', code: 'sheet:read' },
              impact: {
                ...impact(),
                effectiveAfter: [
                  { code: 'sheet:read', sources: [{ kind: 'legacy', id: 'old-1' }], effective: false },
                ],
              },
              resultVersion: 'version-2',
            },
          },
        }
      },
    })
    await previewed(commit)
    await commit.operation.confirm()
    expect(commit.operation.phase.value).toBe('pending')
    expect(commit.operation.verified.value).toBe(false)
    expect(commit.operation.receipt.value).toBeNull()
    expect(commit.posts()).toHaveLength(1)
  })

  it('accepts direct, legacy, and template actions and rejects mixed fields', () => {
    expect(readAdminAuthorizationAction({ kind: 'admission.set' })).toEqual({ kind: 'admission.set' })
    expect(readAdminAuthorizationAction({ kind: 'role.revoke', roleId: 'role-1' })).toEqual({
      kind: 'role.revoke',
      roleId: 'role-1',
    })
    expect(readAdminAuthorizationRequest({
      targetUserId: TARGET,
      action: { kind: 'direct.revoke', code: 'sheet:write' },
      admissionChanges: [],
    })?.action).toEqual({ kind: 'direct.revoke', code: 'sheet:write' })
    expect(readAdminAuthorizationReceipt({
      targetUserId: TARGET,
      action: { kind: 'legacy.revoke', code: 'sheet:read' },
      impact: impact(),
      resultVersion: 'version-2',
    })?.action).toEqual({ kind: 'legacy.revoke', code: 'sheet:read' })
    expect(readAdminAuthorizationReceipt({
      targetUserId: TARGET,
      action: { kind: 'template.apply', templateId: 'template-1' },
      impact: impact(),
      resultVersion: 'version-2',
    })?.action).toEqual({ kind: 'template.apply', templateId: 'template-1' })

    expect(readAdminAuthorizationAction({ kind: 'role.assign', roleId: 'role-1', code: 'sheet:write' })).toBeNull()
    expect(readAdminAuthorizationAction({ kind: 'direct.grant', code: 'sheet:write', roleId: 'role-1' })).toBeNull()
    expect(readAdminAuthorizationAction({ kind: 'direct.revoke', code: 'sheet:write', templateId: 'template-1' })).toBeNull()
    expect(readAdminAuthorizationAction({ kind: 'legacy.revoke', code: 'sheet:read', roleId: 'role-1' })).toBeNull()
    expect(readAdminAuthorizationAction({ kind: 'template.apply', templateId: 'template-1', code: 'sheet:write' })).toBeNull()
    expect(readAdminAuthorizationAction({ kind: 'admission.set', roleId: 'role-1' })).toBeNull()
    expect(readAdminAuthorizationAction({ kind: 'direct.grant', code: ' ' })).toBeNull()
    expect(readAdminAuthorizationAction({ kind: 'template.apply', templateId: '' })).toBeNull()
    expect(readAdminAuthorizationAction({ kind: 'role.assign' })).toBeNull()
  })

  it('rejects malformed impact elements and missing effective flags', () => {
    const base = impact()
    expect(readAdminAuthorizationImpact(base)).toEqual(base)
    expect(readAdminAuthorizationImpact({
      ...base,
      sourceChanges: [{ source: 'profile', id: 'admin', operation: 'assign', changed: true }],
    })).toBeNull()
    expect(readAdminAuthorizationImpact({
      ...base,
      sourceChanges: [{ source: 'role', id: 'admin', operation: 'assign' }],
    })).toBeNull()
    expect(readAdminAuthorizationImpact({
      ...base,
      admissionChanges: [{ namespace: 'attendance', before: null, after: true }],
    })).toBeNull()
    expect(readAdminAuthorizationImpact({
      ...base,
      admissionChanges: [{ namespace: 'attendance', before: 'yes', after: true, cause: 'explicit' }],
    })).toBeNull()
    expect(readAdminAuthorizationImpact({
      ...base,
      scopeCleanup: [{ namespace: 'attendance', kind: 'user', id: 'user-1' }],
    })).toBeNull()
    expect(readAdminAuthorizationImpact({ ...base, warnings: ['kept', 1] })).toBeNull()
    expect(readAdminAuthorizationImpact({ ...base, warnings: 'kept' })).toBeNull()
    expect(readAdminAuthorizationImpact({
      ...base,
      retainedOtherGrants: [{ code: 'sheet:read', sources: [] }],
    })).toBeNull()
    expect(readAdminAuthorizationImpact({
      ...base,
      effectiveAfter: [{ code: '*:*', sources: [{ kind: 'role', id: 'admin' }], effective: 'true' }],
    })).toBeNull()
    expect(readAdminAuthorizationImpact({
      ...base,
      effectiveBefore: [{ code: 'sheet:write', sources: [{ kind: 'direct', id: null }] }],
    })).toBeNull()
    const missingSourceChanges: Record<string, unknown> = { ...base }
    delete missingSourceChanges.sourceChanges
    expect(readAdminAuthorizationImpact(missingSourceChanges)).toBeNull()
  })
})

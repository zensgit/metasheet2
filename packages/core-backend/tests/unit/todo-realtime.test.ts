import { afterEach, describe, expect, it, vi } from 'vitest'
import { publishTodoCountsUpdate, type TodoCountFetcher } from '../../src/services/todo-realtime'
import { pendingSourceRegistry, type PendingViewer } from '../../src/services/pending-source-registry'

describe('todo realtime count publisher (B-2)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Gate `impl-gate-B2-round1-20260918.md` P1-1: every case further below INJECTS
  // `countPendingForUser`, so none of them ever execute `defaultCountPendingForUser` — the ONLY
  // branch production actually takes (`routes/approvals.ts` never passes `countPendingForUser`).
  // Proven by mutation: replacing `defaultCountPendingForUser`'s body with a divergent
  // implementation left those 5 cases (and the full default-config `vitest run`) all green — the
  // P1's own reproduction, `cp`-restored after. This case closes that gap by NOT injecting a
  // fetcher, so it runs the real default path, and by asserting on the shared singleton itself
  // (`pendingSourceRegistry.countPendingForUser`) rather than on a substitute — that's the one call
  // production can reach.
  it('the DEFAULT path (no injected fetcher) calls pendingSourceRegistry.countPendingForUser — the same singleton GET /api/todo/count reads — and forwards its result verbatim', async () => {
    const broadcastTo = vi.fn()
    const registrySpy = vi
      .spyOn(pendingSourceRegistry, 'countPendingForUser')
      .mockResolvedValue({ count: 5, sources: { approval: 'ok' } })

    await publishTodoCountsUpdate({
      collabService: { broadcastTo },
      userId: 'u6',
      roles: ['finance'],
      permissions: ['attendance:approve'],
      reason: 'decide',
      // no countPendingForUser: exercises `defaultCountPendingForUser`
    })

    expect(registrySpy).toHaveBeenCalledTimes(1)
    expect(registrySpy).toHaveBeenCalledWith({
      actorId: 'u6',
      roles: ['finance'],
      permissions: ['attendance:approve'],
    })
    expect(broadcastTo).toHaveBeenCalledWith('auth-user:u6', 'todo:counts-updated', expect.objectContaining({
      count: 5,
      sources: { approval: 'ok' },
    }))
  })
  it('named sources are forwarded as the second argument, on the default path and to an injected fetcher', async () => {
    const broadcastTo = vi.fn()
    const registrySpy = vi
      .spyOn(pendingSourceRegistry, 'countPendingForUser')
      .mockResolvedValue({ count: 2, sources: { approval: 'ok' } })

    await publishTodoCountsUpdate({
      collabService: { broadcastTo },
      userId: 'u7',
      reason: 'decide',
      sources: ['approval'],
    })
    expect(registrySpy).toHaveBeenCalledTimes(1)
    expect(registrySpy).toHaveBeenCalledWith(
      { actorId: 'u7', roles: [], permissions: [] },
      { sources: ['approval'] },
    )

    const injected = vi.fn(async () => ({ count: 0, sources: {} }))
    await publishTodoCountsUpdate({
      collabService: { broadcastTo },
      userId: 'u8',
      reason: 'decide',
      sources: ['approval'],
      countPendingForUser: injected as TodoCountFetcher,
    })
    expect(injected).toHaveBeenCalledWith(
      { actorId: 'u8', roles: [], permissions: [] },
      { sources: ['approval'] },
    )
  })

  it('without named sources an injected fetcher receives the viewer alone', async () => {
    const injected = vi.fn(async () => ({ count: 0, sources: {} }))
    await publishTodoCountsUpdate({
      collabService: { broadcastTo: vi.fn() },
      userId: 'u9',
      reason: 'decide',
      countPendingForUser: injected as TodoCountFetcher,
    })
    expect(injected.mock.calls[0]).toEqual([{ actorId: 'u9', roles: [], permissions: [] }])
  })

  it('reuses the injected countPendingForUser fetcher — the SAME shape pendingSourceRegistry.countPendingForUser returns — never computing a count itself', async () => {
    const broadcastTo = vi.fn()
    let receivedViewer: PendingViewer | undefined
    const countPendingForUser: TodoCountFetcher = vi.fn(async (viewer) => {
      receivedViewer = viewer
      return { count: 3, sources: { approval: 'ok' } }
    })

    await publishTodoCountsUpdate({
      collabService: { broadcastTo },
      userId: 'u1',
      roles: ['finance'],
      permissions: ['attendance:approve'],
      reason: 'decide',
      countPendingForUser,
    })

    expect(countPendingForUser).toHaveBeenCalledTimes(1)
    expect(receivedViewer).toEqual({ actorId: 'u1', roles: ['finance'], permissions: ['attendance:approve'] })
    expect(broadcastTo).toHaveBeenCalledWith('auth-user:u1', 'todo:counts-updated', expect.objectContaining({
      count: 3,
      sources: { approval: 'ok' },
      reason: 'decide',
    }))
  })

  it('defaults roles/permissions to empty arrays rather than throwing when the trigger site does not carry them', async () => {
    const broadcastTo = vi.fn()
    let receivedViewer: PendingViewer | undefined
    const countPendingForUser: TodoCountFetcher = vi.fn(async (viewer) => {
      receivedViewer = viewer
      return { count: 0, sources: {} }
    })

    await publishTodoCountsUpdate({
      collabService: { broadcastTo },
      userId: 'u2',
      reason: 'mark-read',
      countPendingForUser,
    })

    expect(receivedViewer).toEqual({ actorId: 'u2', roles: [], permissions: [] })
    expect(broadcastTo).toHaveBeenCalledWith('auth-user:u2', 'todo:counts-updated', expect.objectContaining({
      count: 0,
      sources: {},
    }))
  })

  it('carries the per-source ok/unavailable status map through verbatim (fail-closed discriminability, lock §3)', async () => {
    const broadcastTo = vi.fn()
    const countPendingForUser: TodoCountFetcher = vi.fn(async () => ({
      count: 1,
      sources: { approval: 'unavailable' },
    }))

    await publishTodoCountsUpdate({
      collabService: { broadcastTo },
      userId: 'u3',
      reason: 'decide',
      countPendingForUser,
    })

    expect(broadcastTo).toHaveBeenCalledWith('auth-user:u3', 'todo:counts-updated', expect.objectContaining({
      sources: { approval: 'unavailable' },
    }))
  })

  it('suppresses publish failures behind logger.warn, same as the pre-existing approval:counts-updated publisher', async () => {
    const warn = vi.fn()
    const broadcastTo = vi.fn()
    const countPendingForUser: TodoCountFetcher = vi.fn(async () => {
      throw new Error('registry exploded')
    })

    await expect(publishTodoCountsUpdate({
      collabService: { broadcastTo },
      logger: { warn },
      userId: 'u4',
      reason: 'decide',
      countPendingForUser,
    })).resolves.toBeUndefined()

    expect(broadcastTo).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('no-ops without throwing when no collabService is available (mirrors publishApprovalCountsUpdate)', async () => {
    const countPendingForUser: TodoCountFetcher = vi.fn()

    await expect(publishTodoCountsUpdate({
      userId: 'u5',
      reason: 'decide',
      countPendingForUser,
    })).resolves.toBeUndefined()

    expect(countPendingForUser).not.toHaveBeenCalled()
  })
})

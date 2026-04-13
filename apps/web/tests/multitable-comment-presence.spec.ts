import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MultitableApiClient } from '../src/multitable/api/client'
import { useMultitableCommentPresence } from '../src/multitable/composables/useMultitableCommentPresence'

function createMockClient() {
  return new MultitableApiClient({
    fetchFn: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 })),
  })
}

function createDeferred<T = unknown>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createRealtimeHarness() {
  let scope: { containerId: string; targetIds: string[] } | null = null
  let handlers: {
    onCommentCreated: (payload: Record<string, unknown>) => void
    onCommentResolved: (payload: Record<string, unknown>) => void
  } | null = null
  const unsubscribe = vi.fn()
  const subscribe = vi.fn((nextScope: typeof scope, nextHandlers: typeof handlers) => {
    scope = nextScope
    handlers = nextHandlers
    return unsubscribe
  })

  return {
    subscribe,
    unsubscribe,
    getScope() {
      return scope
    },
    emitCreated(payload: Record<string, unknown>) {
      handlers?.onCommentCreated(payload)
    },
    emitResolved(payload: Record<string, unknown>) {
      handlers?.onCommentResolved(payload)
    },
  }
}

describe('useMultitableCommentPresence', () => {
  let client: MultitableApiClient

  beforeEach(() => {
    client = createMockClient()
  })

  it('loads unresolved presence summaries', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: {
        items: [{
          spreadsheetId: 'sheet_orders',
          rowId: 'rec_1',
          unresolvedCount: 2,
          fieldCounts: { fld_title: 2 },
          mentionedCount: 1,
          mentionedFieldCounts: { fld_title: 1 },
        }],
      },
    }), { status: 200 }))
    ;(client as any).fetch = fetch
    const state = useMultitableCommentPresence(client)

    await state.loadPresence({ containerId: 'sheet_orders', targetIds: ['rec_1'] })

    expect(fetch).toHaveBeenCalledWith('/api/comments/summary?spreadsheetId=sheet_orders&rowIds=rec_1')
    expect(state.presenceByRecordId.value.rec_1).toMatchObject({
      targetId: 'rec_1',
      unresolvedCount: 2,
      fieldCounts: { fld_title: 2 },
      mentionedCount: 1,
      mentionedFieldCounts: { fld_title: 1 },
    })
  })

  it('merges realtime create and resolve events for tracked rows', async () => {
    const realtime = createRealtimeHarness()
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        data: {
          items: [{
            spreadsheetId: 'sheet_orders',
            rowId: 'rec_1',
            unresolvedCount: 1,
            fieldCounts: { fld_title: 1 },
            mentionedCount: 0,
            mentionedFieldCounts: {},
          }],
        },
      }), { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify({
        ok: true,
        data: {
          items: [{
            spreadsheetId: 'sheet_orders',
            rowId: 'rec_1',
            unresolvedCount: 1,
            fieldCounts: { fld_title: 1 },
            mentionedCount: 0,
            mentionedFieldCounts: {},
          }],
        },
      }), { status: 200 }))
    ;(client as any).fetch = fetch
    const state = useMultitableCommentPresence(client, { subscribeRealtime: realtime.subscribe as any })

    await state.loadPresence({ containerId: 'sheet_orders', targetIds: ['rec_1'] })

    realtime.emitCreated({
      spreadsheetId: 'sheet_orders',
      comment: {
        id: 'c_new',
        spreadsheetId: 'sheet_orders',
        rowId: 'rec_1',
        targetFieldId: 'fld_title',
        authorId: 'u1',
        content: 'reply',
        resolved: false,
        createdAt: '2026-03-29T00:00:00.000Z',
      },
    })

    await vi.waitFor(() => {
      expect(state.presenceByRecordId.value.rec_1?.unresolvedCount).toBe(2)
      expect(state.presenceByRecordId.value.rec_1?.fieldCounts).toEqual({ fld_title: 2 })
    })

    realtime.emitResolved({
      spreadsheetId: 'sheet_orders',
      rowId: 'rec_1',
      fieldId: 'fld_title',
      commentId: 'c_new',
    })

    await vi.waitFor(() => {
      expect(state.presenceByRecordId.value.rec_1?.unresolvedCount).toBe(1)
      expect(state.presenceByRecordId.value.rec_1?.fieldCounts).toEqual({ fld_title: 1 })
    })
  })

  it('ignores stale loads after scope changes and tears down realtime on clear', async () => {
    const realtime = createRealtimeHarness()
    const firstLoad = createDeferred<Response>()
    const secondLoad = createDeferred<Response>()
    const fetch = vi.fn()
      .mockImplementationOnce(() => firstLoad.promise)
      .mockImplementationOnce(() => secondLoad.promise)
    ;(client as any).fetch = fetch
    const state = useMultitableCommentPresence(client, { subscribeRealtime: realtime.subscribe as any })

    const firstPromise = state.loadPresence({ containerId: 'sheet_orders', targetIds: ['rec_1'] })
    const secondPromise = state.loadPresence({ containerId: 'sheet_orders', targetIds: ['rec_2'] })

    secondLoad.resolve(new Response(JSON.stringify({
      ok: true,
      data: {
        items: [{
          spreadsheetId: 'sheet_orders',
          rowId: 'rec_2',
          unresolvedCount: 1,
          fieldCounts: {},
          mentionedCount: 0,
          mentionedFieldCounts: {},
        }],
      },
    }), { status: 200 }))
    await secondPromise

    expect(realtime.getScope()).toEqual({ containerId: 'sheet_orders', targetIds: ['rec_2'] })

    firstLoad.resolve(new Response(JSON.stringify({
      ok: true,
      data: {
        items: [{
          spreadsheetId: 'sheet_orders',
          rowId: 'rec_1',
          unresolvedCount: 5,
          fieldCounts: {},
          mentionedCount: 0,
          mentionedFieldCounts: {},
        }],
      },
    }), { status: 200 }))
    await firstPromise

    expect(state.presenceByRecordId.value).toEqual({
      rec_2: expect.objectContaining({ targetId: 'rec_2', unresolvedCount: 1 }),
    })

    state.clearPresence()

    expect(state.presenceByRecordId.value).toEqual({})
    expect(realtime.unsubscribe).toHaveBeenCalled()
  })
})

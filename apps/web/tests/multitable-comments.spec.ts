import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useMultitableComments } from '../src/multitable/composables/useMultitableComments'
import { MultitableApiClient } from '../src/multitable/api/client'

function createMockClient() {
  return new MultitableApiClient({
    fetchFn: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 })),
  })
}

describe('useMultitableComments', () => {
  let client: MultitableApiClient

  beforeEach(() => { client = createMockClient() })

  it('loads comments', async () => {
    const comments = [{ id: 'c1', spreadsheetId: 's1', rowId: 'r1', fieldId: null, mentions: [], authorId: 'u1', content: 'hello', resolved: false, createdAt: '2026-01-01' }]
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { comments } }), { status: 200 }))
    ;(client as any).fetch = fetch
    const state = useMultitableComments(client)
    await state.loadComments({ containerId: 's1', targetId: 'r1' })
    expect(fetch).toHaveBeenCalledWith('/api/comments?spreadsheetId=s1&rowId=r1')
    expect(state.comments.value).toHaveLength(1)
    expect(state.comments.value[0].containerId).toBe('s1')
    expect(state.comments.value[0].targetId).toBe('r1')
    expect(state.comments.value[0].content).toBe('hello')
  })

  it('loads comments from an existing commentsScope object', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { items: [] } }), { status: 200 }))
    ;(client as any).fetch = fetch
    const state = useMultitableComments(client)
    await state.loadComments({
      containerType: 'meta_sheet',
      containerId: 'sheet_scope',
      targetType: 'meta_record',
      targetId: 'rec_scope',
      targetFieldId: 'fld_notes',
    })
    expect(fetch).toHaveBeenCalledWith('/api/comments?spreadsheetId=sheet_scope&rowId=rec_scope')
  })

  it('adds comment and prepends', async () => {
    const newComment = { id: 'c2', spreadsheetId: 's1', rowId: 'r1', fieldId: null, mentions: [], authorId: 'u1', content: 'new', resolved: false, createdAt: '2026-01-02' }
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { comment: newComment } }), { status: 200 }))
    ;(client as any).fetch = fetch
    const state = useMultitableComments(client)
    state.comments.value = [{ id: 'c1', containerId: 's1', targetId: 'r1', fieldId: null, mentions: [], authorId: 'u1', content: 'old', resolved: false, createdAt: '2026-01-01' }]
    await state.addComment({ containerId: 's1', targetId: 'r1', content: 'new' })
    expect(fetch).toHaveBeenCalledWith('/api/comments', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ spreadsheetId: 's1', rowId: 'r1', content: 'new' }),
    }))
    expect(state.comments.value[0].id).toBe('c2')
    expect(state.comments.value[0].containerId).toBe('s1')
    expect(state.comments.value[0].targetId).toBe('r1')
  })

  it('passes targetFieldId when creating a comment from commentsScope', async () => {
    const newComment = { id: 'c3', containerId: 's1', targetId: 'r1', fieldId: 'fld_notes', mentions: [], authorId: 'u1', content: 'field note', resolved: false, createdAt: '2026-01-03' }
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { comment: newComment } }), { status: 200 }))
    ;(client as any).fetch = fetch
    const state = useMultitableComments(client)
    await state.addComment({
      containerType: 'meta_sheet',
      containerId: 'sheet_scope',
      targetType: 'meta_record',
      targetId: 'rec_scope',
      targetFieldId: 'fld_notes',
      content: 'field note',
    })
    expect(fetch).toHaveBeenCalledWith('/api/comments', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        spreadsheetId: 'sheet_scope',
        rowId: 'rec_scope',
        fieldId: 'fld_notes',
        content: 'field note',
      }),
    }))
  })

  it('forwards explicit mentions when adding comments', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: {
        comment: {
          id: 'c4',
          spreadsheetId: 's1',
          rowId: 'r1',
          mentions: ['user_2'],
          authorId: 'u1',
          content: 'ping @Jamie',
          resolved: false,
          createdAt: '2026-01-04',
        },
      },
    }), { status: 200 }))
    ;(client as any).fetch = fetch
    const state = useMultitableComments(client)

    await state.addComment({ containerId: 's1', targetId: 'r1', content: 'ping @Jamie', mentions: ['user_2'] })

    expect(fetch).toHaveBeenCalledWith('/api/comments', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        spreadsheetId: 's1',
        rowId: 'r1',
        fieldId: undefined,
        content: 'ping @Jamie',
        parentId: undefined,
        mentions: ['user_2'],
      }),
    }))
    expect(state.comments.value[0].mentions).toEqual(['user_2'])
  })

  it('resolves comment in-place', async () => {
    ;(client as any).fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    const state = useMultitableComments(client)
    state.comments.value = [{ id: 'c1', containerId: 's1', targetId: 'r1', fieldId: null, mentions: [], authorId: 'u1', content: 'hello', resolved: false, createdAt: '2026-01-01' }]
    await state.resolveComment('c1')
    expect(state.comments.value[0].resolved).toBe(true)
  })

  it('rethrows add comment errors while keeping draft state in caller', async () => {
    ;(client as any).fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: { message: 'comment failed' } }), { status: 500 }))
    const state = useMultitableComments(client)
    await expect(state.addComment({ containerId: 's1', targetId: 'r1', content: 'new' })).rejects.toThrow('comment failed')
    expect(state.error.value).toBe('comment failed')
    expect(state.submitting.value).toBe(false)
  })

  it('clearComments empties list', () => {
    const state = useMultitableComments(client)
    state.comments.value = [{ id: 'c1', containerId: 's1', targetId: 'r1', fieldId: null, mentions: [], authorId: 'u1', content: 'x', resolved: false, createdAt: '2026-01-01' }]
    state.clearComments()
    expect(state.comments.value).toHaveLength(0)
  })

  it('handles load error', async () => {
    ;(client as any).fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: { message: 'fail' } }), { status: 500 }))
    const state = useMultitableComments(client)
    await state.loadComments({ containerId: 's1', targetId: 'r1' })
    expect(state.error.value).toBeTruthy()
  })
})

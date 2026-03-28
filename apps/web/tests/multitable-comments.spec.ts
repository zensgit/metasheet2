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
    const comments = [{ id: 'c1', containerId: 's1', targetId: 'r1', authorId: 'u1', content: 'hello', resolved: false, createdAt: '2026-01-01' }]
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { comments } }), { status: 200 }))
    ;(client as any).fetch = fetch
    const state = useMultitableComments(client)
    await state.loadComments({ containerId: 's1', targetId: 'r1' })
    expect(fetch).toHaveBeenCalledWith('/api/comments?spreadsheetId=s1&rowId=r1')
    expect(state.comments.value).toHaveLength(1)
    expect(state.comments.value[0].content).toBe('hello')
  })

  it('adds comment and prepends', async () => {
    const newComment = { id: 'c2', containerId: 's1', targetId: 'r1', authorId: 'u1', content: 'new', resolved: false, createdAt: '2026-01-02' }
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { comment: newComment } }), { status: 200 }))
    ;(client as any).fetch = fetch
    const state = useMultitableComments(client)
    state.comments.value = [{ id: 'c1', containerId: 's1', targetId: 'r1', authorId: 'u1', content: 'old', resolved: false, createdAt: '2026-01-01' }]
    await state.addComment({ containerId: 's1', targetId: 'r1', content: 'new' })
    expect(fetch).toHaveBeenCalledWith('/api/comments', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ spreadsheetId: 's1', rowId: 'r1', content: 'new' }),
    }))
    expect(state.comments.value[0].id).toBe('c2')
  })

  it('resolves comment in-place', async () => {
    ;(client as any).fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    const state = useMultitableComments(client)
    state.comments.value = [{ id: 'c1', containerId: 's1', targetId: 'r1', authorId: 'u1', content: 'hello', resolved: false, createdAt: '2026-01-01' }]
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
    state.comments.value = [{ id: 'c1', containerId: 's1', targetId: 'r1', authorId: 'u1', content: 'x', resolved: false, createdAt: '2026-01-01' }]
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

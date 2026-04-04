import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { MultitableApiClient, parseRetryAfterMs } from '../src/multitable/api/client'

describe('MultitableApiClient', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('handles resolveComment 204 responses', async () => {
    const client = new MultitableApiClient({
      fetchFn: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    })

    await expect(client.resolveComment('c1')).resolves.toBeUndefined()
  })

  it('loads inbox and unread counters from comment endpoints', async () => {
    const fetchFn = vi.fn(async (input: string) => {
      if (input.startsWith('/api/comments/inbox')) {
        return new Response(JSON.stringify({
          ok: true,
          data: {
            items: [{
              id: 'c1',
              containerId: 'sheet_1',
              targetId: 'row_1',
              fieldId: 'field_1',
              baseId: 'base_1',
              sheetId: 'sheet_1',
              viewId: 'view_1',
              recordId: 'row_1',
              mentions: ['user_2'],
              authorId: 'user_1',
              authorName: 'Amy',
              content: 'Hello',
              resolved: false,
              createdAt: '2026-03-25T12:00:00.000Z',
              unread: true,
              mentioned: true,
            }],
            total: 1,
            limit: 50,
            offset: 0,
          },
        }), { status: 200 })
      }
      if (input === '/api/comments/unread-count') {
        return new Response(JSON.stringify({ ok: true, data: { count: 7 } }), { status: 200 })
      }
      if (input === '/api/comments/c1/read') {
        return new Response(null, { status: 204 })
      }
      throw new Error(`Unexpected request: ${input}`)
    })

    const client = new MultitableApiClient({ fetchFn })

    await expect(client.listCommentInbox()).resolves.toEqual({
      items: [{
        id: 'c1',
        containerId: 'sheet_1',
        targetId: 'row_1',
        fieldId: 'field_1',
        targetFieldId: null,
        baseId: 'base_1',
        sheetId: 'sheet_1',
        viewId: 'view_1',
        recordId: 'row_1',
        spreadsheetId: undefined,
        rowId: undefined,
        parentId: undefined,
        mentions: ['user_2'],
        authorId: 'user_1',
        authorName: 'Amy',
        content: 'Hello',
        resolved: false,
        createdAt: '2026-03-25T12:00:00.000Z',
        updatedAt: undefined,
        unread: true,
        mentioned: true,
      }],
      total: 1,
      limit: 50,
      offset: 0,
    })
    await expect(client.getCommentUnreadCount()).resolves.toBe(7)
    await expect(client.markCommentRead('c1')).resolves.toBeUndefined()

    expect(fetchFn.mock.calls[0]?.[0]).toBe('/api/comments/inbox')
    expect(fetchFn.mock.calls[1]?.[0]).toBe('/api/comments/unread-count')
    expect(fetchFn).toHaveBeenCalledWith('/api/comments/c1/read', expect.objectContaining({ method: 'POST' }))
  })

  it('surfaces first field error for submitForm failures', async () => {
    const client = new MultitableApiClient({
      fetchFn: vi.fn().mockResolvedValue(new Response(JSON.stringify({
        ok: false,
        error: {
          code: 'FIELD_READONLY',
          message: 'Readonly field update rejected',
          fieldErrors: {
            fld_title: 'Field is readonly',
            fld_status: 'Unknown field',
          },
        },
      }), { status: 403 })),
    })

    const error = await client.submitForm('view_form', { data: { fld_title: 'Nope' } }).catch((err) => err)

    expect(error.message).toBe('Field is readonly')
    expect(error.code).toBe('FIELD_READONLY')
    expect(error.fieldErrors).toEqual({
      fld_title: 'Field is readonly',
      fld_status: 'Unknown field',
    })
  })

  it('prepares a person field preset', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: {
        targetSheet: {
          id: 'sheet_people',
          baseId: 'base_ops',
          name: 'People',
          description: '__metasheet_system:people__',
        },
        fieldProperty: {
          foreignSheetId: 'sheet_people',
          limitSingleRecord: true,
          refKind: 'user',
        },
      },
    }), { status: 200 }))
    const client = new MultitableApiClient({ fetchFn })

    await expect(client.preparePersonField('sheet_ops')).resolves.toEqual({
      targetSheet: {
        id: 'sheet_people',
        baseId: 'base_ops',
        name: 'People',
        description: '__metasheet_system:people__',
      },
      fieldProperty: {
        foreignSheetId: 'sheet_people',
        limitSingleRecord: true,
        refKind: 'user',
      },
    })
    expect(fetchFn).toHaveBeenCalledWith('/api/multitable/person-fields/prepare', expect.objectContaining({ method: 'POST' }))
  })

  it('unwraps nested attachment payloads', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: {
        attachment: {
          id: 'att_1',
          filename: 'spec.pdf',
          mimeType: 'application/pdf',
          size: 1024,
          url: 'https://files.example.com/spec.pdf',
          thumbnailUrl: null,
          uploadedAt: '2026-03-25T08:00:00.000Z',
        },
      },
    }), { status: 200 }))
    const client = new MultitableApiClient({ fetchFn })

    const file = new File(['spec'], 'spec.pdf', { type: 'application/pdf' })
    await expect(client.uploadAttachment(file, { sheetId: 'sheet_orders', fieldId: 'fld_file' })).resolves.toEqual({
      id: 'att_1',
      filename: 'spec.pdf',
      mimeType: 'application/pdf',
      size: 1024,
      url: 'https://files.example.com/spec.pdf',
      thumbnailUrl: null,
      uploadedAt: '2026-03-25T08:00:00.000Z',
    })
  })

  it('forwards AbortSignal to createRecord requests', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: { record: { id: 'rec_1', version: 1, data: {} } },
    }), { status: 200 }))
    const client = new MultitableApiClient({ fetchFn })
    const controller = new AbortController()

    await client.createRecord({
      sheetId: 'sheet_orders',
      viewId: 'view_grid',
      data: { fld_name: 'Alpha' },
    }, { signal: controller.signal })

    expect(fetchFn).toHaveBeenCalledWith('/api/multitable/records', expect.objectContaining({
      method: 'POST',
      signal: controller.signal,
    }))
  })

  it('parses Retry-After seconds and http-date values', () => {
    expect(parseRetryAfterMs('2')).toBe(2000)
    expect(parseRetryAfterMs('Wed, 25 Mar 2026 12:00:05 GMT')).toBe(5000)
  })

  it('normalizes inbox comment payloads from backend naming', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: {
        items: [{
          id: 'cmt_1',
          spreadsheetId: 'sheet_comments',
          rowId: 'rec_1',
          baseId: 'base_comments',
          sheetId: 'sheet_comments',
          viewId: 'view_comments',
          recordId: 'rec_1',
          authorId: 'user_2',
          content: 'hello',
          resolved: false,
          mentions: ['user_1'],
          createdAt: '2026-03-25T12:00:00.000Z',
          unread: true,
          mentioned: false,
        }],
        total: 1,
        limit: 50,
        offset: 0,
      },
    }), { status: 200 }))
    const client = new MultitableApiClient({ fetchFn })

    await expect(client.listCommentInbox()).resolves.toEqual({
      items: [{
        id: 'cmt_1',
        containerId: 'sheet_comments',
        targetId: 'rec_1',
        fieldId: null,
        targetFieldId: null,
        baseId: 'base_comments',
        sheetId: 'sheet_comments',
        viewId: 'view_comments',
        recordId: 'rec_1',
        spreadsheetId: 'sheet_comments',
        rowId: 'rec_1',
        parentId: undefined,
        mentions: ['user_1'],
        authorId: 'user_2',
        authorName: undefined,
        content: 'hello',
        resolved: false,
        createdAt: '2026-03-25T12:00:00.000Z',
        updatedAt: undefined,
        unread: true,
        mentioned: false,
      }],
      total: 1,
      limit: 50,
      offset: 0,
    })
  })

  it('reads unread count from the comments inbox endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: { count: 3 },
    }), { status: 200 }))
    const client = new MultitableApiClient({ fetchFn })

    await expect(client.getCommentUnreadCount()).resolves.toBe(3)
  })

  it('ignores invalid Retry-After values', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined()
    expect(parseRetryAfterMs('')).toBeUndefined()
    expect(parseRetryAfterMs('not-a-delay')).toBeUndefined()
  })
})

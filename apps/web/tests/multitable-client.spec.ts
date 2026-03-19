import { describe, it, expect, vi } from 'vitest'
import { MultitableApiClient } from '../src/multitable/api/client'

describe('MultitableApiClient', () => {
  it('handles resolveComment 204 responses', async () => {
    const client = new MultitableApiClient({
      fetchFn: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    })

    await expect(client.resolveComment('c1')).resolves.toBeUndefined()
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

  it('normalizes comment list responses that use items', async () => {
    const client = new MultitableApiClient({
      fetchFn: vi.fn().mockResolvedValue(new Response(JSON.stringify({
        ok: true,
        data: {
          items: [
            { id: 'c1', targetId: 'r1', containerId: 's1', authorId: 'u1', content: 'hello', resolved: false, createdAt: '2026-01-01' },
          ],
        },
      }), { status: 200 })),
    })

    await expect(client.listComments({ containerId: 's1', targetId: 'r1' })).resolves.toEqual({
      comments: [
        { id: 'c1', targetId: 'r1', containerId: 's1', authorId: 'u1', content: 'hello', resolved: false, createdAt: '2026-01-01' },
      ],
    })
  })

  it('unwraps nested attachment payloads from uploadAttachment', async () => {
    const client = new MultitableApiClient({
      fetchFn: vi.fn().mockResolvedValue(new Response(JSON.stringify({
        ok: true,
        data: {
          attachment: {
            id: 'att_1',
            filename: 'brief.txt',
            mimeType: 'text/plain',
            size: 11,
            url: '/api/multitable/attachments/att_1',
            thumbnailUrl: null,
            uploadedAt: '2026-03-19T10:30:00.000Z',
          },
        },
      }), { status: 201 })),
    })

    const file = new File(['hello world'], 'brief.txt', { type: 'text/plain' })

    await expect(client.uploadAttachment(file, { sheetId: 'sheet_ops', fieldId: 'fld_files' })).resolves.toEqual({
      id: 'att_1',
      filename: 'brief.txt',
      mimeType: 'text/plain',
      size: 11,
      url: '/api/multitable/attachments/att_1',
      thumbnailUrl: null,
      uploadedAt: '2026-03-19T10:30:00.000Z',
    })
  })
})

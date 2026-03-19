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
})

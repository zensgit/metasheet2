import { describe, expect, it, vi } from 'vitest'
import { canReadEveryYjsFieldForUser } from '../../src/collab/yjs-field-read-access'
import type { QueryFn } from '../../src/multitable/permission-service'

const capabilities = {
  canEditRecord: false,
  canCreateRecord: false,
}

function makeQuery(input: {
  fields: Array<{ id: string; type?: string; property?: Record<string, unknown> }>
  fieldScopes?: Array<{ field_id: string; visible: boolean; read_only: boolean }>
}): QueryFn {
  return vi.fn(async (sql: string) => {
    if (sql.includes('FROM meta_fields')) {
      return {
        rows: input.fields.map((field, index) => ({
          id: field.id,
          type: field.type ?? 'string',
          property: field.property ?? {},
          order: index + 1,
        })),
      }
    }
    if (sql.includes('FROM field_permissions')) {
      return { rows: input.fieldScopes ?? [] }
    }
    return { rows: [] }
  }) as unknown as QueryFn
}

describe('canReadEveryYjsFieldForUser', () => {
  it('allows Yjs when every field is readable', async () => {
    const query = makeQuery({
      fields: [
        { id: 'fld_public' },
        { id: 'fld_readonly' },
      ],
      fieldScopes: [
        { field_id: 'fld_readonly', visible: true, read_only: true },
      ],
    })

    await expect(canReadEveryYjsFieldForUser(query, 'sheet_1', 'user_1', capabilities))
      .resolves.toBe(true)
  })

  it('fails closed when a subject-scoped field permission hides any field', async () => {
    const query = makeQuery({
      fields: [
        { id: 'fld_public' },
        { id: 'fld_secret' },
      ],
      fieldScopes: [
        { field_id: 'fld_secret', visible: false, read_only: false },
      ],
    })

    await expect(canReadEveryYjsFieldForUser(query, 'sheet_1', 'user_1', capabilities))
      .resolves.toBe(false)
  })

  it('fails closed when a static hidden field exists on the sheet', async () => {
    const query = makeQuery({
      fields: [
        { id: 'fld_public' },
        { id: 'fld_static_secret', property: { hidden: true } },
      ],
    })

    await expect(canReadEveryYjsFieldForUser(query, 'sheet_1', 'user_1', capabilities))
      .resolves.toBe(false)
  })

  it('fails closed for the Yjs bridge permissionHidden marker', async () => {
    const query = makeQuery({
      fields: [
        { id: 'fld_public' },
        { id: 'fld_permission_hidden', property: { permissionHidden: true } },
      ],
    })

    await expect(canReadEveryYjsFieldForUser(query, 'sheet_1', 'user_1', capabilities))
      .resolves.toBe(false)
  })

  it('fails closed without a trusted user or sheet id', async () => {
    const query = makeQuery({ fields: [{ id: 'fld_public' }] })

    await expect(canReadEveryYjsFieldForUser(query, '', 'user_1', capabilities))
      .resolves.toBe(false)
    await expect(canReadEveryYjsFieldForUser(query, 'sheet_1', '', capabilities))
      .resolves.toBe(false)
  })
})

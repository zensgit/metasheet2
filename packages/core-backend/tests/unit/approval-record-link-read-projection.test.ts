/**
 * FWB-0 Layer 2 P1-1 — formSnapshot record-link projection for viewers.
 *
 * Discriminating tests: unauthorized viewers must not see stored record ids;
 * null/malformed schema fails closed (schema-free redaction); positive controls keep ids.
 */
import { describe, expect, it, vi } from 'vitest'

const permissionState = vi.hoisted(() => ({
  isRecordReadDeniedForUserStrict: vi.fn(async () => false),
}))

vi.mock('../../src/multitable/permission-service', async () => {
  const actual = await vi.importActual<typeof import('../../src/multitable/permission-service')>(
    '../../src/multitable/permission-service',
  )
  return {
    ...actual,
    isRecordReadDeniedForUserStrict: permissionState.isRecordReadDeniedForUserStrict,
  }
})

import {
  RECORD_LINK_INACCESSIBLE_VALUE,
  isRecordLinkShapedValue,
  projectRecordLinkFormSnapshotForViewer,
  projectRecordLinkFormSnapshotsForViewerBatch,
  redactRecordLinkShapedValuesWithoutSchema,
} from '../../src/services/approval-record-link-read-projection'
import type { FormSchema } from '../../src/types/approval-product'

const schema: FormSchema = {
  fields: [
    {
      id: 'linked',
      type: 'record-link',
      label: '关联',
      props: { baseId: 'base-1', sheetId: 'sheet-1' },
    },
    { id: 'title', type: 'text', label: '标题' },
  ],
}

function queryFnAuthorized(opts: { exists?: boolean; ownerId?: string; perms?: string[] } = {}) {
  const exists = opts.exists !== false
  const ownerId = opts.ownerId ?? 'viewer-ok'
  const perms = opts.perms ?? ['multitable:read']
  return vi.fn(async (sql: string, params?: unknown[]) => {
    const q = sql.replace(/\s+/g, ' ')
    if (q.includes('permission_code') || q.includes('user_permissions')) {
      return { rows: perms.map((code) => ({ code })) }
    }
    if (q.includes('pg_advisory_xact_lock')) return { rows: [{ pg_advisory_xact_lock: '' }] }
    if (q.includes('FOR UPDATE') && q.includes('FROM meta_bases')) return { rows: [{ id: 'base-1' }] }
    if (q.includes('FOR UPDATE') && q.includes('FROM meta_sheets')) return { rows: [{ id: 'sheet-1' }] }
    if (q.includes('FOR UPDATE') && q.includes('FROM role_permissions')) return { rows: [] }
    if (q.includes('FOR UPDATE') && q.includes('user_permissions')) {
      return { rows: perms.map((code) => ({ permission_code: code })) }
    }
    if (q.includes('FOR UPDATE') && q.includes('user_roles')) return { rows: [] }
    if (q.includes('FOR UPDATE') && q.includes('FROM users')) return { rows: [{ id: ownerId }] }
    if (q.includes('FOR UPDATE') && q.includes('platform_member_group_members')) return { rows: [] }
    if (q.includes('FOR UPDATE') && q.includes('spreadsheet_permissions')) return { rows: [] }
    if (q.includes('FOR UPDATE') && q.includes('record_permissions')) return { rows: [] }
    if (q.includes('FROM user_roles') && !q.includes('role_permissions')) return { rows: [] }
    if (q.includes('FROM meta_sheets') && q.includes('base_id')) {
      return { rows: [{ id: 'sheet-1', base_id: 'base-1' }] }
    }
    if (q.includes('FROM meta_bases')) {
      return { rows: [{ owner_id: ownerId }] }
    }
    if (q.includes('FROM users')) return { rows: [{ permissions: [] }] }
    if (q.includes('spreadsheet_permissions')) return { rows: [] }
    if (q.includes('FROM meta_records')) {
      const requested = Array.isArray(params?.[1]) ? params[1] as unknown[] : ['rec-secret']
      return { rows: exists ? requested.map((id) => ({ id: String(id) })) : [] }
    }
    return { rows: [] }
  })
}

describe('redactRecordLinkShapedValuesWithoutSchema', () => {
  it('redacts top-level and nested detail-row record-link shapes without schema', () => {
    const snap = {
      linked: { recordId: 'rec-secret' },
      title: 'ok',
      items: [
        { name: 'a', ref: { recordId: 'nested-secret' } },
        { name: 'b' },
      ],
    }
    const out = redactRecordLinkShapedValuesWithoutSchema(snap)
    expect(out.linked).toEqual(RECORD_LINK_INACCESSIBLE_VALUE)
    expect(out.title).toBe('ok')
    expect((out.items as Array<Record<string, unknown>>)[0].ref).toEqual(RECORD_LINK_INACCESSIBLE_VALUE)
    expect(JSON.stringify(out)).not.toContain('rec-secret')
    expect(JSON.stringify(out)).not.toContain('nested-secret')
  })
})

describe('projectRecordLinkFormSnapshotForViewer', () => {
  it('positive control: authorized viewer keeps canonical { recordId }', async () => {
    permissionState.isRecordReadDeniedForUserStrict.mockResolvedValue(false)
    const snapshot = { linked: { recordId: 'rec-secret' }, title: 'ok' }
    const projected = await projectRecordLinkFormSnapshotForViewer(
      snapshot,
      schema,
      'viewer-ok',
      queryFnAuthorized({ ownerId: 'viewer-ok' }),
    )
    expect(projected).toEqual({ linked: { recordId: 'rec-secret' }, title: 'ok' })
    expect(JSON.stringify(projected)).toContain('rec-secret')
  })

  it('redacts stored recordId when viewer lacks sheet/base/row read', async () => {
    permissionState.isRecordReadDeniedForUserStrict.mockResolvedValue(false)
    const snapshot = { linked: { recordId: 'rec-secret' }, title: 'ok' }
    const projected = await projectRecordLinkFormSnapshotForViewer(
      snapshot,
      schema,
      'viewer-denied',
      queryFnAuthorized({ ownerId: 'someone-else', perms: [] }),
    )
    expect(projected?.linked).toEqual(RECORD_LINK_INACCESSIBLE_VALUE)
    expect(JSON.stringify(projected)).not.toContain('rec-secret')
  })

  it('P1-1 null schema: fail-closed redacts record-link shapes (does not return snapshot unchanged)', async () => {
    const snapshot = {
      linked: { recordId: 'rec-secret' },
      items: [{ cell: { recordId: 'nested-id' } }],
    }
    const projected = await projectRecordLinkFormSnapshotForViewer(
      snapshot,
      null,
      'viewer-ok',
      queryFnAuthorized(),
    )
    expect(projected).not.toBe(snapshot)
    expect(projected?.linked).toEqual(RECORD_LINK_INACCESSIBLE_VALUE)
    expect(JSON.stringify(projected)).not.toContain('rec-secret')
    expect(JSON.stringify(projected)).not.toContain('nested-id')
  })

  it('P1-1 malformed schema: fail-closed schema-free redaction', async () => {
    const snapshot = { linked: { recordId: 'rec-secret' } }
    const projected = await projectRecordLinkFormSnapshotForViewer(
      snapshot,
      { fields: null as unknown as FormSchema['fields'] },
      'viewer-ok',
      queryFnAuthorized(),
    )
    expect(projected?.linked).toEqual(RECORD_LINK_INACCESSIBLE_VALUE)
    expect(JSON.stringify(projected)).not.toContain('rec-secret')
  })

  it('fail-closed redacts when viewer identity is missing', async () => {
    const snapshot = { linked: { recordId: 'rec-secret' } }
    const projected = await projectRecordLinkFormSnapshotForViewer(
      snapshot,
      schema,
      null,
      queryFnAuthorized(),
    )
    expect(JSON.stringify(projected)).not.toContain('rec-secret')
    expect(projected?.linked).toEqual(RECORD_LINK_INACCESSIBLE_VALUE)
  })

  it('row-level deny redacts even when base+sheet are readable', async () => {
    permissionState.isRecordReadDeniedForUserStrict.mockResolvedValue(true)
    const snapshot = { linked: { recordId: 'rec-secret' } }
    const projected = await projectRecordLinkFormSnapshotForViewer(
      snapshot,
      schema,
      'viewer-ok',
      queryFnAuthorized({ ownerId: 'viewer-ok' }),
    )
    expect(JSON.stringify(projected)).not.toContain('rec-secret')
  })
})

describe('projectRecordLinkFormSnapshotsForViewerBatch — null schema list', () => {
  it('list rows with null template version / seeded null schema fail-closed (positive control keeps id when schema present)', async () => {
    permissionState.isRecordReadDeniedForUserStrict.mockResolvedValue(false)
    const queryFn = queryFnAuthorized({ ownerId: 'viewer-ok' })
    const schemaMap = new Map<string, FormSchema | null>([
      ['ver-null', null],
      ['ver-ok', schema],
    ])
    const out = await projectRecordLinkFormSnapshotsForViewerBatch(
      [
        { formSnapshot: { linked: { recordId: 'list-secret-1' } }, templateVersionId: null },
        { formSnapshot: { linked: { recordId: 'list-secret-2' } }, templateVersionId: 'ver-null' },
        { formSnapshot: { linked: { recordId: 'list-ok' } }, templateVersionId: 'ver-ok' },
      ],
      'viewer-ok',
      queryFn,
      schemaMap,
    )
    expect(JSON.stringify(out[0])).not.toContain('list-secret-1')
    expect(out[0]?.linked).toEqual(RECORD_LINK_INACCESSIBLE_VALUE)
    expect(JSON.stringify(out[1])).not.toContain('list-secret-2')
    // Positive control: well-formed schema + auth → keep id.
    expect(out[2]).toEqual({ linked: { recordId: 'list-ok' } })
  })

  it('batches distinct linked records by pinned target instead of repeating full auth/deny scans', async () => {
    const queryFn = queryFnAuthorized({ ownerId: 'viewer-ok' })
    const rows = Array.from({ length: 40 }, (_, index) => ({
      formSnapshot: { linked: { recordId: `rec-${index}` } },
      templateVersionId: 'ver-ok',
    }))
    const out = await projectRecordLinkFormSnapshotsForViewerBatch(
      rows,
      'viewer-ok',
      queryFn,
      new Map([['ver-ok', schema]]),
    )

    expect(out).toHaveLength(40)
    expect(out[0]).toEqual({ linked: { recordId: 'rec-0' } })
    expect(out[39]).toEqual({ linked: { recordId: 'rec-39' } })

    const calls = queryFn.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' '))
    expect(calls.filter((sql) => sql.includes('FROM meta_records'))).toHaveLength(1)
    expect(calls.filter((sql) => sql.includes('FROM meta_bases'))).toHaveLength(1)
    expect(calls.filter((sql) => sql.includes('FROM spreadsheet_permissions'))).toHaveLength(1)
  })

  it('redacts only row-denied records while retaining readable records from the same target batch', async () => {
    const baseQuery = queryFnAuthorized({ ownerId: 'viewer-ok' })
    const queryFn = vi.fn(async (sql: string, params?: unknown[]) => {
      const q = sql.replace(/\s+/g, ' ')
      if (q.includes('row_level_read_permissions_enabled AS enabled')) {
        return { rows: [{ enabled: true, base_id: 'base-1' }] }
      }
      if (q.includes('SELECT DISTINCT rp.record_id')) {
        return { rows: [{ record_id: 'rec-denied' }] }
      }
      if (q.includes('SELECT conditional_read_rules AS rules')) {
        return { rows: [{ rules: null }] }
      }
      return baseQuery(sql, params)
    })
    const out = await projectRecordLinkFormSnapshotsForViewerBatch(
      [
        { formSnapshot: { linked: { recordId: 'rec-ok' } }, templateVersionId: 'ver-ok' },
        { formSnapshot: { linked: { recordId: 'rec-denied' } }, templateVersionId: 'ver-ok' },
      ],
      'viewer-ok',
      queryFn,
      new Map([['ver-ok', schema]]),
    )

    expect(out[0]).toEqual({ linked: { recordId: 'rec-ok' } })
    expect(out[1]?.linked).toEqual(RECORD_LINK_INACCESSIBLE_VALUE)
    expect(JSON.stringify(out[1])).not.toContain('rec-denied')
  })

  it('fails the whole pinned target closed when strict row-auth loading errors', async () => {
    const baseQuery = queryFnAuthorized({ ownerId: 'viewer-ok' })
    const queryFn = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('row_level_read_permissions_enabled AS enabled')) {
        throw new Error('db_unavailable')
      }
      return baseQuery(sql, params)
    })
    const out = await projectRecordLinkFormSnapshotsForViewerBatch(
      [
        { formSnapshot: { linked: { recordId: 'rec-a' } }, templateVersionId: 'ver-ok' },
        { formSnapshot: { linked: { recordId: 'rec-b' } }, templateVersionId: 'ver-ok' },
      ],
      'viewer-ok',
      queryFn,
      new Map([['ver-ok', schema]]),
    )

    expect(out[0]?.linked).toEqual(RECORD_LINK_INACCESSIBLE_VALUE)
    expect(out[1]?.linked).toEqual(RECORD_LINK_INACCESSIBLE_VALUE)
    expect(JSON.stringify(out)).not.toContain('rec-a')
    expect(JSON.stringify(out)).not.toContain('rec-b')
  })
})

describe('isRecordLinkShapedValue', () => {
  it('accepts only canonical { recordId }', () => {
    expect(isRecordLinkShapedValue({ recordId: 'x' })).toBe(true)
    expect(isRecordLinkShapedValue({ recordId: 'x', extra: 1 })).toBe(false)
    expect(isRecordLinkShapedValue('x')).toBe(false)
  })
})

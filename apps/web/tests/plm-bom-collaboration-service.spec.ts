import { beforeEach, describe, expect, it, vi } from 'vitest'
const apiFetch = vi.hoisted(() => vi.fn())
vi.mock('../src/utils/api', () => ({ apiFetch }))
import {
  changePlmBomCollaboration, createPlmBomCollaboration, listPlmBomCollaborationBases,
  listPlmBomCollaborations, previewPlmBomCollaboration,
  getBomNotifications, saveBomNotifications, searchBomNotificationRecipients,
} from '../src/services/plm/plmBomCollaboration'
const root = '/api/plm-bom-reviews'
const input = { dataSourceId: 'source', partId: 'part', baseId: 'base', name: 'BOM review' }
const preview = { previewId: 'preview', expiresAt: '2030-01-01T00:15:00Z', snapshotHash: 'hash', snapshotAt: '2026-10-01T00:00:00Z', part: { partId: 'part', itemNumber: null, name: 'Assembly' }, lineCount: 2, occurrenceCount: 3, source: { tenantId: 'tenant', orgId: 'org', authUserId: 'actor', partId: 'part' } }
const binding = { id: 'binding', version: 1, dataSourceId: 'source', partId: 'part', baseId: 'base', sheetId: 'sheet', viewId: 'view', name: 'BOM review', status: 'active', lastSyncedAt: '2026-10-01T00:00:00Z', sourceSnapshotHash: 'hash', lineCount: 2, occurrenceCount: 3, navigationPath: '/multitable/sheet/view', canRefresh: true, canDisable: true }
function reply(data: unknown, status = 200) { return new Response(JSON.stringify({ ok: true, data }), { status }) }
beforeEach(() => apiFetch.mockReset())
describe('BOM collaboration transport', () => {
  it('validates notification responses and never retains undeclared fields', async () => {
    const notifications = { issue: { enabled: false, recipientStrategy: null },
      reminder: { enabled: false, recipientStrategy: null, leadMinutes: null },
      escalation: { enabled: false, slaMinutes: null, recipientUserIds: [] } }
    apiFetch.mockResolvedValueOnce(reply({ version: 1, notifications, secret: 'drop' }))
    expect(await getBomNotifications('id/one')).toEqual({ version: 1, notifications })
    expect(apiFetch.mock.calls[0][0]).toBe(`${root}/id%2Fone/notifications`)
    apiFetch.mockResolvedValueOnce(reply({ version: 0, notifications: null }))
    await expect(saveBomNotifications('id',{ expectedVersion: 0, notifications })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    apiFetch.mockResolvedValueOnce(reply({ items: [{ id: 'reader', name: 'Reviewer', credential: 'drop' }] }))
    expect(await searchBomNotificationRecipients('id','a&b')).toEqual([{ id: 'reader', name: 'Reviewer' }])
    expect(apiFetch.mock.calls.at(-1)?.[0]).toContain('q=a%26b')
  })
  it('uses fixed JWT routes and receipt-only confirmation, with no client snapshot or grant', async () => {
    const signal = new AbortController().signal
    apiFetch.mockResolvedValueOnce(reply({ items: [{ id: 'base', name: 'Engineering' }] }))
      .mockResolvedValueOnce(reply(preview)).mockResolvedValueOnce(reply(binding, 201))
      .mockResolvedValueOnce(reply({ items: [binding] })).mockResolvedValueOnce(reply({ ...binding, id: 'binding/one' }))
    expect(await listPlmBomCollaborationBases(signal)).toEqual([{ id: 'base', name: 'Engineering' }])
    expect(await previewPlmBomCollaboration(input, signal)).toEqual(preview)
    expect(await createPlmBomCollaboration('preview', 'request', signal)).toEqual(binding)
    expect(await listPlmBomCollaborations('source', 'part', signal)).toEqual([binding])
    await changePlmBomCollaboration('binding/one', 'disable', 1, signal)
    const options = { signal, cache: 'no-store', suppressUnauthorizedRedirect: true }
    expect(apiFetch.mock.calls).toEqual([
      [`${root}/bases`, { ...options, method: 'GET' }],
      [`${root}/preview`, { ...options, method: 'POST', body: JSON.stringify(input) }],
      [root, { ...options, method: 'POST', body: JSON.stringify({ previewId: 'preview', requestId: 'request' }) }],
      [`${root}?dataSourceId=source&partId=part`, { ...options, method: 'GET' }],
      [`${root}/binding%2Fone/disable`, { ...options, method: 'POST', body: JSON.stringify({ expectedVersion: 1 }) }],
    ])
  })
  it('projects only declared data and cannot preserve unexpected credentials', async () => {
    apiFetch.mockResolvedValue(reply({ items: [{ ...binding, secret: 'must-not-survive' }] }))
    expect(await listPlmBomCollaborations('source', 'part')).toEqual([binding])
  })
  it.each([
    { ...binding, canRefresh: 'true' }, { ...binding, version: 0 }, { ...binding, status: 'unknown' },
    { ...binding, occurrenceCount: -1 }, { ...binding, lastSyncedAt: 'invalid' }, { ...binding, partId: 'other' },
  ])('rejects malformed or mismatched bindings', async (row) => {
    apiFetch.mockResolvedValue(reply({ items: [row] }))
    await expect(listPlmBomCollaborations('source', 'part')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it.each([
    { ...preview, previewId: '' }, { ...preview, expiresAt: 'invalid' },
    { ...preview, source: { ...preview.source, partId: 'other' } },
  ])('rejects invalid preview receipts or scope', async (row) => {
    apiFetch.mockResolvedValue(reply(row))
    await expect(previewPlmBomCollaboration(input)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it.each(['SOURCE_CHANGED', 'PREVIEW_EXPIRED', 'FORBIDDEN', 'SOURCE_FORBIDDEN', 'PLM_BOM_REVIEW_DISABLED', 'VERSION_CONFLICT'])('maps %s without provider exception text', async (code) => {
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ ok: false, error: { code, message: 'private-provider-detail' } }), { status: 409 }))
    await expect(createPlmBomCollaboration('preview', 'request')).rejects.toMatchObject({ code })
    await expect(createPlmBomCollaboration('preview', 'request')).rejects.not.toThrow('private-provider-detail')
  })
  it('sanitizes transport and non-JSON failures', async () => {
    apiFetch.mockRejectedValueOnce(new Error('private-provider-detail')).mockResolvedValueOnce(new Response('private-provider-detail'))
    for (let i = 0; i < 2; i++) await expect(listPlmBomCollaborationBases()).rejects.not.toThrow('private-provider-detail')
  })
})

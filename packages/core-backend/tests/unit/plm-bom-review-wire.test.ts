import { describe, expect, it } from 'vitest'
import {
  parseShareSnapshot,
  projectBomRows,
  snapshotHash,
  previewInput,
  confirmInput,
  LOCAL_FIELDS,
  notificationInput,
  completionWebhookInput,
  BOM_COMPLETION_EVENT_TYPES,
} from '../../src/multitable/plm-bom-review-wire'
import { serializeFieldRow, classifySelectCellValue } from '../../src/multitable/field-codecs'

import { shareSnapshot } from '../plm-bom-review/fixture'

describe('BOM collaboration share contract', () => {
  it('requires explicit review granularity and the PLM authority source for enabled rules', () => {
    for (const granularity of ['bom', 'row']) for (const source of ['bom_line_writeback', 'eco_batch_apply']) {
      const input = { expectedVersion: 0,webhooks: {
        reviewCompleted: { enabled: true,webhookId: 'review',granularity },
        plmChangeApplied: { enabled: true,webhookId: 'plm',source },
      } }
      expect(completionWebhookInput.parse(input)).toEqual(input)
      for (const bad of [null,undefined,'whole','applied']) {
        expect(completionWebhookInput.safeParse({ ...input,webhooks: { ...input.webhooks,
          reviewCompleted: { ...input.webhooks.reviewCompleted,granularity: bad } } }).success).toBe(false)
        expect(completionWebhookInput.safeParse({ ...input,webhooks: { ...input.webhooks,
          plmChangeApplied: { ...input.webhooks.plmChangeApplied,source: bad } } }).success).toBe(false)
      }
    }
    expect(completionWebhookInput.safeParse({ expectedVersion: 0,webhooks: {
      reviewCompleted: { enabled: false,webhookId: null },plmChangeApplied: { enabled: false,webhookId: null },
    } }).success).toBe(true)
  })
  it('keeps review and PLM success policies distinct without accepting caller event authority', () => {
    const input = { expectedVersion: 0,webhooks: {
      reviewCompleted: { enabled: true,webhookId: 'review-target',granularity: 'row' },
      plmChangeApplied: { enabled: true,webhookId: 'plm-target',source: 'bom_line_writeback' },
    } }
    expect(completionWebhookInput.parse(input)).toEqual(input)
    expect(BOM_COMPLETION_EVENT_TYPES.reviewCompleted).not.toBe(BOM_COMPLETION_EVENT_TYPES.plmChangeApplied)
    for (const bad of [null,{ ...input,event_type: 'bom.plm_change.applied' },
      { ...input,expectedVersion: -1 },
      { ...input,webhooks: { ...input.webhooks,reviewCompleted: { enabled: true,webhookId: null,granularity: 'row' } } }])
      expect(completionWebhookInput.safeParse(bad).success).toBe(false)
  })
  it('requires explicit bounded timings and independent issue/reminder recipient strategies', () => {
    const input = { expectedVersion: 0, notifications: {
      issue: { enabled: true, recipientStrategy: 'event_owner' },
      reminder: { enabled: true, recipientStrategy: 'current_owner', leadMinutes: 0 },
      escalation: { enabled: true, slaMinutes: 30, recipientUserIds: ['owner'] },
    } }
    expect(notificationInput.parse(input)).toEqual(input)
    for (const leadMinutes of [null, -1, 0.5, '30', Number.MAX_SAFE_INTEGER])
      expect(notificationInput.safeParse({ ...input, notifications: { ...input.notifications,
        reminder: { ...input.notifications.reminder, leadMinutes } } }).success).toBe(false)
    for (const escalation of [
      { enabled: true, slaMinutes: 0, recipientUserIds: ['owner'] },
      { enabled: true, slaMinutes: 30, recipientUserIds: [] },
      { enabled: true, slaMinutes: 30, recipientUserIds: ['owner','owner'] },
    ]) expect(notificationInput.safeParse({ ...input, notifications: { ...input.notifications, escalation } }).success).toBe(false)
    expect(notificationInput.safeParse({ ...input, actorId: 'forged' }).success).toBe(false)
  })
  it('provisions the ratified review states as valid native select values', () => {
    const descriptor = LOCAL_FIELDS.find((field) => field.id === 'status')!
    const field = serializeFieldRow({ ...descriptor, order: 0 })
    const options = (field.options ?? []).map((option) => option.value)
    expect(options).toEqual(['待评审', '评审中', '有问题', '已完成'])
    for (const value of options)
      expect(classifySelectCellValue(value, options)).toBe('ok')
    expect(classifySelectCellValue('approved', options)).toBe('not_in_options')
  })
  it('keeps logical relationship records with both ancestor-relation occurrences', () => {
    const snapshot = parseShareSnapshot(shareSnapshot(), 'P')
    expect(snapshot.source.auth_user_id).toBe('9007199254740999')
    const rows = projectBomRows(snapshot)
    expect(rows.size).toBe(3)
    expect(rows.get('RC')?.occurrences.map((o) => o.relations)).toEqual([
      ['RA1', 'RC'],
      ['RA2', 'RC'],
    ])
    expect(rows.get('RC')?.cells.quantity).toBe('2')
  })
  it('accepts legitimate null labels and preserves them', () => {
    const raw = shareSnapshot() as any
    raw.context.lines[1].path_labels = [null, 'A']
    const rows = projectBomRows(parseShareSnapshot(raw, 'P'))
    expect(rows.get('RC')?.occurrences[0].pathLabels).toEqual([null, 'A'])
  })
  it('rejects non-snapshot source status', () => {
    const raw = shareSnapshot()
    raw.context.lines[0].sync_status = 'stale'
    expect(() => parseShareSnapshot(raw, 'P')).toThrow()
  })
  it('hashes content and authority rather than the time of the fetch', () => {
    const first = shareSnapshot(),
      second = shareSnapshot()
    second.snapshot_at = '2026-10-01T02:00:00Z'
    expect(snapshotHash(parseShareSnapshot(first, 'P'))).toBe(
      snapshotHash(parseShareSnapshot(second, 'P')),
    )
    second.context.lines[0].quantity = 9
    expect(snapshotHash(parseShareSnapshot(first, 'P'))).not.toBe(
      snapshotHash(parseShareSnapshot(second, 'P')),
    )
  })
  it.each([
    null,
    {},
    { ...shareSnapshot(), entitled: false, source: null, context: null },
  ])('rejects absent or unentitled authority', (value) => {
    expect(() => parseShareSnapshot(value, 'P')).toThrow()
  })
  it('rejects a different root, unsafe numeric authority and conflicting duplicate relationships', () => {
    expect(() => parseShareSnapshot(shareSnapshot(), 'OTHER')).toThrow()
    const bad = shareSnapshot()
    bad.context.lines[0].quantity = 9007199254740992
    expect(() => parseShareSnapshot(bad, 'P')).toThrow()
    const conflict = shareSnapshot()
    conflict.context.lines[3].quantity = 3
    expect(() => projectBomRows(parseShareSnapshot(conflict, 'P'))).toThrow()
  })
  it('binds previews to a selected target and disallows client authority on confirm', () => {
    expect(
      previewInput.parse({
        dataSourceId: 'ds',
        partId: 'P',
        baseId: 'b',
        name: 'Review',
      }),
    ).toBeTruthy()
    expect(() =>
      previewInput.parse({
        dataSourceId: 'ds',
        partId: 'P',
        baseId: 'b',
        name: 'Review',
        actorId: 'someone',
      }),
    ).toThrow()
    expect(() =>
      confirmInput.parse({
        previewId: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        source: {},
      }),
    ).toThrow()
  })
})

import { describe, expect, it, vi } from 'vitest'

import {
  getRecordSubscriptionStatus,
  insertRecordSubscriptionNotifications,
  listRecordSubscriptionNotifications,
  listRecordSubscriptions,
  notifyRecordSubscribers,
  notifyRecordSubscribersBestEffort,
  subscribeRecord,
  unsubscribeRecord,
} from '../../src/multitable/record-subscription-service'

describe('record-subscription-service', () => {
  it('upserts record subscriptions', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        id: 'sub_1',
        sheet_id: 'sheet_1',
        record_id: 'rec_1',
        user_id: 'user_1',
        created_at: '2026-05-05T00:00:00.000Z',
        updated_at: '2026-05-05T00:00:00.000Z',
      }],
    })

    const subscription = await subscribeRecord(query, {
      sheetId: 'sheet_1',
      recordId: 'rec_1',
      userId: 'user_1',
    })

    expect(subscription).toEqual(expect.objectContaining({
      id: 'sub_1',
      sheetId: 'sheet_1',
      recordId: 'rec_1',
      userId: 'user_1',
    }))
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (sheet_id, record_id, user_id)'),
      [expect.any(String), 'sheet_1', 'rec_1', 'user_1'],
    )
  })

  it('deletes current user subscription', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 })

    await expect(unsubscribeRecord(query, {
      sheetId: 'sheet_1',
      recordId: 'rec_1',
      userId: 'user_1',
    })).resolves.toBe(true)
  })

  it('lists subscriptions and current user status', async () => {
    const row = {
      id: 'sub_1',
      sheet_id: 'sheet_1',
      record_id: 'rec_1',
      user_id: 'user_1',
      created_at: new Date('2026-05-05T00:00:00.000Z'),
      updated_at: new Date('2026-05-05T00:00:00.000Z'),
    }
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [row] })

    await expect(listRecordSubscriptions(query, {
      sheetId: 'sheet_1',
      recordId: 'rec_1',
    })).resolves.toHaveLength(1)
    await expect(getRecordSubscriptionStatus(query, {
      sheetId: 'sheet_1',
      recordId: 'rec_1',
      userId: 'user_1',
    })).resolves.toEqual({
      subscribed: true,
      subscription: expect.objectContaining({ userId: 'user_1' }),
    })
  })

  it('notifies watchers while suppressing the actor', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ user_id: 'watcher_1' }, { user_id: 'watcher_2' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 2 })

    const result = await notifyRecordSubscribers(query, {
      sheetId: 'sheet_1',
      recordId: 'rec_1',
      eventType: 'record.updated',
      actorId: 'actor_1',
      revisionId: '11111111-1111-1111-1111-111111111111',
    })

    expect(result).toEqual({ inserted: 2, userIds: ['watcher_1', 'watcher_2'] })
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('user_id <> $3::text'), [
      'sheet_1',
      'rec_1',
      'actor_1',
    ])
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('INSERT INTO meta_record_subscription_notifications'), [
      expect.stringContaining('"event_type":"record.updated"'),
    ])
    // NO-REGRESS (B1-S1 D0-A writer-seam refactor): the watcher INSERT must still
    // carry revision_id round-trip AND a NULL message — a count-only assertion would
    // green-light the regression where the new writer drops revision/comment columns.
    const insertPayload = JSON.parse((query.mock.calls[1] as unknown[])[1] as string[][0] as unknown as string)
    expect(insertPayload).toEqual([
      expect.objectContaining({ user_id: 'watcher_1', event_type: 'record.updated', revision_id: '11111111-1111-1111-1111-111111111111', comment_id: null, message: null }),
      expect.objectContaining({ user_id: 'watcher_2', event_type: 'record.updated', revision_id: '11111111-1111-1111-1111-111111111111', comment_id: null, message: null }),
    ])
  })

  it('insertRecordSubscriptionNotifications writes notification.sent with a custom message', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 2 })
    const result = await insertRecordSubscriptionNotifications(query, {
      userIds: ['u1', 'u2'],
      sheetId: 'sheet_1',
      recordId: 'rec_1',
      eventType: 'notification.sent',
      message: 'Ship it',
      actorId: 'actor_1',
    })
    expect(result).toEqual({ inserted: 2 })
    const payload = JSON.parse((query.mock.calls[0] as unknown[])[1] as unknown as string[][0] as unknown as string)
    expect(payload).toEqual([
      expect.objectContaining({ user_id: 'u1', event_type: 'notification.sent', message: 'Ship it', revision_id: null, comment_id: null }),
      expect.objectContaining({ user_id: 'u2', event_type: 'notification.sent', message: 'Ship it', revision_id: null, comment_id: null }),
    ])
  })

  it('insertRecordSubscriptionNotifications is a no-op for an empty recipient set', async () => {
    const query = vi.fn()
    await expect(insertRecordSubscriptionNotifications(query, {
      userIds: [],
      sheetId: 'sheet_1',
      eventType: 'notification.sent',
      message: 'x',
    })).resolves.toEqual({ inserted: 0 })
    expect(query).not.toHaveBeenCalled()
  })

  it('serializes a notification.sent row WITH its message (no coercion to record.updated)', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        id: 'note_sent',
        sheet_id: 'sheet_1',
        record_id: 'rec_1',
        user_id: 'user_1',
        event_type: 'notification.sent',
        actor_id: 'actor_1',
        revision_id: null,
        comment_id: null,
        message: 'Custom body',
        created_at: '2026-06-16T00:00:00.000Z',
        read_at: null,
      }],
    })
    await expect(listRecordSubscriptionNotifications(query, { userId: 'user_1' })).resolves.toEqual([
      expect.objectContaining({ id: 'note_sent', eventType: 'notification.sent', message: 'Custom body' }),
    ])
    // The list SELECT must include the `message` column or the row's body is lost.
    expect(query).toHaveBeenCalledWith(expect.stringContaining('message'), expect.anything())
  })

  it('keeps watcher notification enqueue best-effort for write paths', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const query = vi.fn().mockRejectedValue(new Error('meta_record_subscriptions missing'))

    await expect(notifyRecordSubscribersBestEffort(query, {
      sheetId: 'sheet_1',
      recordId: 'rec_1',
      eventType: 'record.updated',
      actorId: 'actor_1',
      revisionId: '11111111-1111-1111-1111-111111111111',
    }, 'test-record-write')).resolves.toBeNull()

    expect(warnSpy).toHaveBeenCalledWith(
      '[test-record-write] Failed to notify record subscribers',
      expect.any(Error),
    )
    warnSpy.mockRestore()
  })

  it('lists current user record subscription notifications', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        id: 'note_1',
        sheet_id: 'sheet_1',
        record_id: 'rec_1',
        user_id: 'user_1',
        event_type: 'comment.created',
        actor_id: 'actor_1',
        revision_id: null,
        comment_id: 'cmt_1',
        created_at: '2026-05-05T00:00:00.000Z',
        read_at: null,
      }],
    })

    await expect(listRecordSubscriptionNotifications(query, {
      userId: 'user_1',
      sheetId: 'sheet_1',
      recordId: 'rec_1',
    })).resolves.toEqual([
      expect.objectContaining({
        id: 'note_1',
        eventType: 'comment.created',
        commentId: 'cmt_1',
      }),
    ])
  })
})

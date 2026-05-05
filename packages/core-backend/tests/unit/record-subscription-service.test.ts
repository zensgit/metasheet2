import { describe, expect, it, vi } from 'vitest'

import {
  getRecordSubscriptionStatus,
  listRecordSubscriptionNotifications,
  listRecordSubscriptions,
  notifyRecordSubscribers,
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

import { describe, expect, it } from 'vitest'

import {
  projectCancelRoundDeliveryRowV1,
  type CancelRoundDeliveryLedgerRowV1,
} from '../../src/approvals/approval-cancel-round-entry-port'

/**
 * Cancel-round product entry, phase C — P-5 = (iii) Full delivery, 「Full status, no raw ids/errors
 * (Recommended)」: the ledger-state → three-value mapping of the round summary's `deliveries`.
 *
 * The ratified text names the three values (delivered / pending / failed), the channel TYPE, the
 * attempt count and timestamps; the mapping from each ledger's own vocabulary is an implementation
 * choice recorded in the design MD. This table pins EVERY state of both ledgers' CHECK vocabularies
 * so the choice cannot drift silently, and pins the item's exact key set (values-free: nothing else
 * can ride along).
 */

const T0 = new Date('2026-09-29T01:00:00.000Z')
const T1 = new Date('2026-09-29T01:05:00.000Z')
const T2 = new Date('2026-09-29T01:09:00.000Z')

function card(status: string): CancelRoundDeliveryLedgerRowV1 {
  return { channel_type: 'dingtalk_approval_card', ledger_status: status, attempt_count: null, created_at: T0, last_attempt_at: null, updated_at: T2 }
}
function todo(status: string, attempts: number): CancelRoundDeliveryLedgerRowV1 {
  return { channel_type: 'dingtalk_todo', ledger_status: status, attempt_count: attempts, created_at: T0, last_attempt_at: attempts > 0 ? T1 : null, updated_at: T2 }
}

describe('cancel-round summary deliveries — ledger state → delivered / pending / failed', () => {
  it.each([
    ['sent', 'delivered'],
    ['failed', 'failed'],
    ['pending', 'pending'],
    ['outcome_unknown', 'pending'],
  ])('approval card send_status %s ⇒ %s, one attempt at the row\'s creation time', (ledger, expected) => {
    expect(projectCancelRoundDeliveryRowV1(card(ledger))).toEqual({
      channelType: 'dingtalk_approval_card',
      status: expected,
      attempts: 1,
      createdAt: T0.toISOString(),
      lastAttemptAt: T0.toISOString(),
      updatedAt: T2.toISOString(),
    })
  })

  it.each([
    ['created', 1, 'delivered'],
    ['completing', 0, 'delivered'],
    ['completed', 2, 'delivered'],
    ['pending', 0, 'pending'],
    ['pending', 2, 'pending'],
    ['sending', 1, 'pending'],
    ['outcome_unknown', 1, 'pending'],
    ['failed', 5, 'failed'],
    ['superseded', 2, 'failed'],
    ['skipped', 1, 'failed'],
  ])('todo mirror status %s with %i attempt(s) ⇒ %s', (ledger, attempts, expected) => {
    expect(projectCancelRoundDeliveryRowV1(todo(ledger, attempts))).toEqual({
      channelType: 'dingtalk_todo',
      status: expected,
      attempts,
      createdAt: T0.toISOString(),
      lastAttemptAt: attempts > 0 ? T1.toISOString() : null,
      updatedAt: T2.toISOString(),
    })
  })

  it.each(['superseded', 'skipped'])(
    'todo mirror %s with NO attempt is omitted (retired before any send: nothing was delivered or attempted)',
    (ledger) => {
      expect(projectCancelRoundDeliveryRowV1(todo(ledger, 0))).toBeNull()
    },
  )

  it('an unknown ledger state or channel is never guessed into a status', () => {
    expect(projectCancelRoundDeliveryRowV1(card('acted'))).toBeNull()
    expect(projectCancelRoundDeliveryRowV1(todo('something_new', 3))).toBeNull()
    expect(projectCancelRoundDeliveryRowV1({ ...card('sent'), channel_type: 'email' })).toBeNull()
  })

  it('values-free: every projected item carries exactly the six ratified keys', () => {
    const items = [projectCancelRoundDeliveryRowV1(card('failed')), projectCancelRoundDeliveryRowV1(todo('failed', 2))]
    for (const item of items) {
      expect(Object.keys(item ?? {}).sort()).toEqual(['attempts', 'channelType', 'createdAt', 'lastAttemptAt', 'status', 'updatedAt'])
    }
  })
})

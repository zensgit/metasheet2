import { describe, expect, it, vi } from 'vitest'
import type { ApprovalEntry, ApprovalHistoryEntry } from '../src/views/plm/plmPanelModels'
import {
  canActOnPlmApproval,
  getPlmApprovalApproverId,
  resolvePlmApprovalActorIds,
} from '../src/views/plm/plmApprovalActionability'

function createJwt(payload: object) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `header.${encode(payload)}.signature`
}

describe('plmApprovalActionability', () => {
  it('resolves actor ids from available auth tokens and de-duplicates claims', () => {
    const storage = {
      getItem: vi.fn((key: string) => {
        if (key === 'plm_token') {
          return createJwt({
            userId: 'user-1',
            preferred_username: 'approver-a',
            exp: Math.floor(Date.now() / 1000) + 3600,
          })
        }
        if (key === 'auth_token') {
          return createJwt({
            sub: 'user-1',
            user_id: 'user-2',
            exp: Math.floor(Date.now() / 1000) + 3600,
          })
        }
        if (key === 'jwt') {
          return createJwt({
            username: 'approver-a',
            email: 'approver@example.test',
            exp: Math.floor(Date.now() / 1000) + 3600,
          })
        }
        return ''
      }),
    }

    expect(resolvePlmApprovalActorIds(storage)).toEqual([
      'user-1',
      'approver-a',
      'user-2',
      'approver@example.test',
    ])
  })

  it('reads approver identity from approval entries and history rows', () => {
    expect(getPlmApprovalApproverId({ approver_id: 'approver-1' } as ApprovalEntry)).toBe('approver-1')
    expect(getPlmApprovalApproverId({ user_id: 'approver-2' } as ApprovalHistoryEntry)).toBe('approver-2')
  })

  it('allows approval actions when the current actor matches the direct approver id', () => {
    expect(
      canActOnPlmApproval(
        {
          id: 'approval-1',
          status: 'pending',
          approver_id: 'approver-1',
        },
        ['approver-1', 'fallback-user'],
      ),
    ).toBe(true)
  })

  it('falls back to pending approval history when the list row omits approver metadata', () => {
    expect(
      canActOnPlmApproval(
        {
          id: 'approval-1',
          status: 'pending',
        },
        ['approver-2'],
        [
          {
            id: 'history-1',
            status: 'pending',
            user_id: 'approver-2',
          },
          {
            id: 'history-2',
            status: 'approved',
            user_id: 'approver-3',
          },
        ],
      ),
    ).toBe(true)
  })

  it('blocks approval actions when the row is not pending or the actor does not match', () => {
    expect(
      canActOnPlmApproval(
        {
          id: 'approval-1',
          status: 'approved',
          approver_id: 'approver-1',
        },
        ['approver-1'],
      ),
    ).toBe(false)

    expect(
      canActOnPlmApproval(
        {
          id: 'approval-2',
          status: 'pending',
          approver_id: 'approver-1',
        },
        ['approver-9'],
        [
          {
            id: 'history-3',
            status: 'pending',
            user_id: 'approver-8',
          },
        ],
      ),
    ).toBe(false)
  })
})

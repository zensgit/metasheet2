import { describe, expect, it } from 'vitest'
import {
  evaluateDirectorySyncLocalAccountGate,
  resolveDirectorySyncMembershipWrite,
  type DirectorySyncLocalAccountSnapshot,
  type DirectorySyncMembershipWriteInput,
} from '../../src/directory/directory-sync-membership-gate'

/**
 * Directory sync confirms an active organisation membership only for a local account that
 * passes the shared user authentication gate. Every local-account case below starts from the
 * passing baseline and changes exactly one field, and asserts the literal denial code, so a
 * mapping that drops any one field makes its own case fail.
 */
const passingUser: DirectorySyncLocalAccountSnapshot = {
  isActive: true,
  role: 'user',
  activationStatus: 'activated',
  deletedAt: null,
  purgedAt: null,
}

const passingInput: DirectorySyncMembershipWriteInput = {
  linkStatus: 'linked',
  localUserId: 'user-1',
  accountActive: true,
  preservesOpenRehireEvidence: false,
  localUser: passingUser,
}

describe('directory sync membership write decision', () => {
  it('confirms the membership for a linked, active account whose local account passes the gate', () => {
    expect(resolveDirectorySyncMembershipWrite(passingInput)).toEqual({ write: true })
  })

  it('R0: a link that is not linked, or has no local user, writes nothing', () => {
    expect(resolveDirectorySyncMembershipWrite({ ...passingInput, linkStatus: 'pending' })).toEqual({
      write: false,
      reason: 'not_linked',
    })
    expect(resolveDirectorySyncMembershipWrite({ ...passingInput, linkStatus: 'unmatched' })).toEqual({
      write: false,
      reason: 'not_linked',
    })
    expect(resolveDirectorySyncMembershipWrite({ ...passingInput, localUserId: null })).toEqual({
      write: false,
      reason: 'not_linked',
    })
  })

  it('R1: an inactive directory account writes nothing', () => {
    expect(resolveDirectorySyncMembershipWrite({ ...passingInput, accountActive: false })).toEqual({
      write: false,
      reason: 'account_inactive',
    })
  })

  it('R2: an account carrying open-rehire evidence writes nothing', () => {
    expect(
      resolveDirectorySyncMembershipWrite({ ...passingInput, preservesOpenRehireEvidence: true }),
    ).toEqual({ write: false, reason: 'open_rehire_evidence' })
  })

  it('R4: a missing local row fails closed', () => {
    expect(resolveDirectorySyncMembershipWrite({ ...passingInput, localUser: undefined })).toEqual({
      write: false,
      reason: 'local_user_missing',
    })
  })

  describe('R5: single-field local-account denials carry the shared gate code', () => {
    const cases: Array<[string, Partial<DirectorySyncLocalAccountSnapshot>, string]> = [
      ['is_active=false', { isActive: false }, 'ACCOUNT_INACTIVE'],
      ["role='disabled'", { role: 'disabled' }, 'ACCOUNT_INACTIVE'],
      ['deleted_at set', { deletedAt: '2026-01-01T00:00:00.000Z' }, 'ACCOUNT_DELETED'],
      ['purged_at set', { purgedAt: '2026-01-01T00:00:00.000Z' }, 'ACCOUNT_DELETED'],
      ['pending_activation', { activationStatus: 'pending_activation' }, 'ACCOUNT_PENDING_ACTIVATION'],
      ['activation_status null', { activationStatus: null }, 'ACCOUNT_ACTIVATION_INVALID'],
      ['activation_status unknown', { activationStatus: 'something_else' }, 'ACCOUNT_ACTIVATION_INVALID'],
    ]

    for (const [label, change, code] of cases) {
      it(`${label} → ${code}`, () => {
        const localUser = { ...passingUser, ...change }
        expect(evaluateDirectorySyncLocalAccountGate(localUser)).toEqual({ code })
        expect(resolveDirectorySyncMembershipWrite({ ...passingInput, localUser })).toEqual({
          write: false,
          reason: 'local_account_gate',
          code,
        })
      })
    }

    it('a null role is not a denial on its own', () => {
      expect(evaluateDirectorySyncLocalAccountGate({ ...passingUser, role: null })).toBeNull()
    })
  })

  it('rule order: link, account and open-rehire conditions are decided before the local account', () => {
    const denied = { ...passingUser, isActive: false }
    expect(resolveDirectorySyncMembershipWrite({ ...passingInput, linkStatus: 'pending', localUser: denied })).toEqual({
      write: false,
      reason: 'not_linked',
    })
    expect(resolveDirectorySyncMembershipWrite({ ...passingInput, accountActive: false, localUser: denied })).toEqual({
      write: false,
      reason: 'account_inactive',
    })
    expect(
      resolveDirectorySyncMembershipWrite({ ...passingInput, preservesOpenRehireEvidence: true, localUser: denied }),
    ).toEqual({ write: false, reason: 'open_rehire_evidence' })
  })
})

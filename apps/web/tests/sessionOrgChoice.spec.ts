import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearSessionOrgChoice,
  isDefaultSessionOrgId,
  persistSessionOrgChoice,
  readHistoryFilterOrgSeed,
  readSessionOrgChoice,
  sessionOrgChoiceForUser,
  tenantHintForLoginRequest,
} from '../src/utils/sessionOrgChoice'

describe('sessionOrgChoice (D6 R1 / F1)', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    window.localStorage.clear()
  })

  it('does not treat a persisted default hint as a history-filter choice', () => {
    window.localStorage.setItem('tenantId', 'default')
    window.localStorage.setItem('workspaceId', 'default')

    expect(isDefaultSessionOrgId('default')).toBe(true)
    expect(readHistoryFilterOrgSeed()).toBe('')
    expect(tenantHintForLoginRequest('default')).toBeNull()
  })

  it('keeps a non-default injected hint as a history-filter seed', () => {
    window.localStorage.setItem('tenantId', 'tenant_42')

    expect(readHistoryFilterOrgSeed()).toBe('tenant_42')
    expect(tenantHintForLoginRequest('tenant_42')).toBe('tenant_42')
  })

  it('persists an explicit switcher choice bound to the user, including default', () => {
    persistSessionOrgChoice('user-1', 'default')

    expect(readSessionOrgChoice()).toEqual({ userId: 'user-1', orgId: 'default' })
    expect(sessionOrgChoiceForUser('user-1')).toBe('default')
    expect(sessionOrgChoiceForUser('user-2')).toBeNull()
    expect(window.localStorage.getItem('tenantId')).toBeNull()
  })

  it('does not let another user inherit an explicit choice', () => {
    persistSessionOrgChoice('user-1', 'tenant_42')
    expect(sessionOrgChoiceForUser('user-9')).toBeNull()
    clearSessionOrgChoice()
    expect(readSessionOrgChoice()).toBeNull()
  })

  it('does not enable ATTENDANCE_SELF_SERVICE_ORG_RESOLUTION_V1', () => {
    expect(process.env.ATTENDANCE_SELF_SERVICE_ORG_RESOLUTION_V1).not.toBe('shadow')
    expect(process.env.ATTENDANCE_SELF_SERVICE_ORG_RESOLUTION_V1).not.toBe('enforce')
  })
})

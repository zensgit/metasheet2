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

  it('strips a persisted default hint from login, not from the history-filter seed', () => {
    window.localStorage.setItem('tenantId', 'default')
    window.localStorage.setItem('workspaceId', 'default')

    expect(isDefaultSessionOrgId('default')).toBe(true)
    expect(readHistoryFilterOrgSeed()).toBe('default')
    expect(tenantHintForLoginRequest('default')).toBeNull()
  })

  it('keeps a non-default injected hint as a history-filter seed', () => {
    window.localStorage.setItem('tenantId', 'tenant_42')

    expect(readHistoryFilterOrgSeed()).toBe('tenant_42')
    expect(tenantHintForLoginRequest('tenant_42')).toBe('tenant_42')
  })

  it('does not seed the history-filter org box from an explicit switcher choice', () => {
    persistSessionOrgChoice('user-1', 'org-b')
    expect(readHistoryFilterOrgSeed()).toBe('')
    expect(readSessionOrgChoice()).toEqual({ userId: 'user-1', orgId: 'org-b' })
  })

  it('prefers the injected hint over an explicit switcher choice for the history-filter box', () => {
    window.localStorage.setItem('tenantId', 'default')
    persistSessionOrgChoice('user-1', 'org-b')
    expect(readHistoryFilterOrgSeed()).toBe('default')
    expect(readSessionOrgChoice()).toEqual({ userId: 'user-1', orgId: 'org-b' })
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

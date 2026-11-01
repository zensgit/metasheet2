import { beforeEach, describe, expect, it, vi } from 'vitest'
const apiFetch = vi.hoisted(() => vi.fn())
vi.mock('../src/utils/api', () => ({ apiFetch }))
import {
  bindPlmApprovalGrant, getPlmApprovalBindings, reconcilePlmApprovalCommands,
  syncPlmApprovalTasks, unbindPlmApprovalGrant,
} from '../src/services/plm/plmApprovalBindings'

const binding = {
  id: 'binding-1', connectionId: 'plm', subjectId: 'person-1', tenantId: 'tenant', orgId: 'org',
  grantId: 'grant-1', expiresAt: '2030-01-01T00:00:00Z', bound: true, unresolvedCount: 2,
}
const listed = { ...binding, canUse: true }
const state = { connection: { id: 'plm', label: 'Yuantus', grantManagementUrl: 'https://yuantus.test/personal-approval-grants' }, bindings: [listed] }
function reply(data: unknown, status = 200) { return new Response(JSON.stringify({ ok: true, data }), { status }) }
beforeEach(() => apiFetch.mockReset())

describe('personal Yuantus binding transport', () => {
  it('uses only fixed self routes, exact bodies, fresh responses and existing JWT transport', async () => {
    const signal = new AbortController().signal
    apiFetch.mockResolvedValueOnce(reply(state))
      .mockResolvedValueOnce(reply(binding, 201))
      .mockResolvedValueOnce(reply({ taskCount: 3, retiredCount: 1 }))
      .mockResolvedValueOnce(reply({ settled: 1, pending: 0, admissionRequired: 1 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    expect(await getPlmApprovalBindings(signal)).toEqual(state)
    expect(await bindPlmApprovalGrant('plm', 'fixture-personal-grant', signal)).toEqual(binding)
    expect(await syncPlmApprovalTasks('binding/1', signal)).toEqual({ taskCount: 3, retiredCount: 1 })
    expect(await reconcilePlmApprovalCommands('binding/1', signal)).toEqual({ settled: 1, pending: 0, admissionRequired: 1 })
    await unbindPlmApprovalGrant('binding/1', signal)
    const base = '/api/me/plm-approval-bindings'
    const options = { signal, cache: 'no-store', suppressUnauthorizedRedirect: true }
    expect(apiFetch.mock.calls).toEqual([
      [base, { ...options, method: 'GET' }],
      [base, { ...options, method: 'POST', body: JSON.stringify({ connectionId: 'plm', grant: 'fixture-personal-grant' }) }],
      [`${base}/binding%2F1/sync`, { ...options, method: 'POST', body: '{}' }],
      [`${base}/binding%2F1/reconcile`, { ...options, method: 'POST', body: '{}' }],
      [`${base}/binding%2F1`, { ...options, method: 'DELETE' }],
    ])
  })

  it('projects metadata and cannot retain an unexpected credential in its response', async () => {
    apiFetch.mockResolvedValue(reply({
      ...state,
      bindings: [{ ...listed, grant: 'must-not-survive', secret: 'must-not-survive', encrypted_grant: 'must-not-survive' }],
    }))
    const result = await getPlmApprovalBindings()
    expect(result).toEqual(state)
    expect(JSON.stringify(result)).not.toContain('must-not-survive')
  })

  it.each([
    null, { ...state, connection: null }, { ...state, bindings: {} },
    { ...state, bindings: [{ ...listed, bound: 'true' }] },
    { ...state, bindings: [{ ...listed, expiresAt: 'invalid' }] },
    { ...state, bindings: [{ ...listed, unresolvedCount: -1 }] },
    { ...state, bindings: [{ ...listed, connectionId: 'another-provider' }] },
  ])('rejects malformed metadata without presenting bound status', async (data) => {
    apiFetch.mockResolvedValue(reply(data))
    await expect(getPlmApprovalBindings()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it.each([
    ['PLM_CARD_DISABLED', 404], ['PLM_CARD_UNAUTHORIZED', 401], ['PLM_BINDING_REQUIRED', 409],
    ['PLM_BINDING_CONFLICT', 409], ['PLM_PROVIDER_UNAVAILABLE', 503],
    ['PLM_PROVIDER_FORBIDDEN', 403], ['PLM_CARD_INVALID_INPUT', 422],
  ])('maps %s to a fixed message without echoing exception text', async (code, status) => {
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ ok: false, error: { code, message: 'fixture-secret' } }), { status: Number(status) }))
    await expect(getPlmApprovalBindings()).rejects.toMatchObject({ code })
    await expect(getPlmApprovalBindings()).rejects.not.toThrow('fixture-secret')
  })

  it('does not expose unknown provider errors, JSON or transport text', async () => {
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'fixture-secret' } }), { status: 500 }))
      .mockResolvedValueOnce(new Response('fixture-secret'))
      .mockRejectedValueOnce(new Error('fixture-secret'))
    for (let i = 0; i < 3; i++) await expect(getPlmApprovalBindings()).rejects.not.toThrow('fixture-secret')
  })

  it.each(['javascript:alert(1)', '/personal-approval-grants', 'https://user:secret@yuantus.test/personal-approval-grants', 'https://yuantus.test/personal-approval-grants?token=secret', 'https://yuantus.test/other'])('rejects unsafe management links %s', async (grantManagementUrl) => {
    apiFetch.mockResolvedValue(reply({ ...state, connection: { ...state.connection, grantManagementUrl } }))
    await expect(getPlmApprovalBindings()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('rejects invalid reconciliation counts rather than calling them resolved', async () => {
    apiFetch.mockResolvedValue(reply({ settled: '1', pending: 0, admissionRequired: 0 }))
    await expect(reconcilePlmApprovalCommands('binding-1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it.each([undefined, null, 'true', 'false', 1, 0])('rejects non-boolean canUse %s', async (canUse) => {
    apiFetch.mockResolvedValue(reply({ ...state, bindings: [{ ...listed, canUse }] }))
    await expect(getPlmApprovalBindings()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('rejects canUse true for a mismatched connection, an unbound row, or a null management URL', async () => {
    const cases = [
      { ...state, bindings: [{ ...listed, connectionId: 'old-plm', canUse: true }] },
      { ...state, bindings: [{ ...listed, bound: false, canUse: true }] },
      { ...state, connection: { ...state.connection, grantManagementUrl: null }, bindings: [{ ...listed, canUse: true }] },
    ]
    for (const data of cases) {
      apiFetch.mockResolvedValue(reply(data))
      await expect(getPlmApprovalBindings()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    }
  })

  it.each([undefined, '', 'notaurl'])('rejects a missing or unparseable management URL %s', async (grantManagementUrl) => {
    apiFetch.mockResolvedValue(reply({
      ...state,
      connection: { ...state.connection, grantManagementUrl },
      bindings: [{ ...listed, canUse: false }],
    }))
    await expect(getPlmApprovalBindings()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('accepts an old connection and an explicit null management URL when canUse is false', async () => {
    const legacy = {
      connection: { id: 'plm', label: 'Yuantus', grantManagementUrl: null },
      bindings: [
        { ...binding, id: 'binding-old', connectionId: 'old-plm', canUse: false },
        { ...binding, canUse: false },
      ],
    }
    apiFetch.mockResolvedValue(reply(legacy))
    expect(await getPlmApprovalBindings()).toEqual(legacy)
    const staleWithUrl = { ...state, bindings: [{ ...binding, connectionId: 'old-plm', canUse: false }] }
    apiFetch.mockResolvedValue(reply(staleWithUrl))
    expect(await getPlmApprovalBindings()).toEqual(staleWithUrl)
  })

  it('keeps POST bind on the basic DTO without canUse or credentials', async () => {
    apiFetch.mockResolvedValue(reply({ ...binding, canUse: true, grant: 'must-not-survive', encrypted_grant: 'must-not-survive' }, 201))
    expect(await bindPlmApprovalGrant('plm', 'fixture-personal-grant')).toEqual(binding)
  })
})

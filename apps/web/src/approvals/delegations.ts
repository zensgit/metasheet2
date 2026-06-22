// Delegation (委托) config client — talks to /api/approval-delegations.
// A user manages only their own delegations (the backend keys on the authenticated
// actor as delegator), so no delegator field is sent from the client.
import { apiGet, apiPost, apiFetch } from '../utils/api'

const USE_MOCK = import.meta.env.DEV || (globalThis as { __APPROVAL_MOCK__?: boolean }).__APPROVAL_MOCK__ === true

export interface DelegationRecord {
  id: string
  delegatorUserId: string
  delegateeUserId: string
  scope: 'all' | 'template'
  scopeTemplateId: string | null
  startAt: string
  endAt: string
  active: boolean
}

export interface CreateDelegationPayload {
  delegatorUserId: string
  delegateeUserId: string
  scope: 'all' | 'template'
  scopeTemplateId?: string | null
  startAt: string
  endAt: string
}

export interface UpdateDelegationPayload {
  delegateeUserId?: string
  scope?: 'all' | 'template'
  scopeTemplateId?: string | null
  startAt?: string
  endAt?: string
  active?: boolean
}

const mockDelegations: DelegationRecord[] = []

export async function listDelegations(): Promise<DelegationRecord[]> {
  if (USE_MOCK) return mockDelegations.filter((d) => d.active)
  const res = await apiGet<{ data: DelegationRecord[] }>('/api/approval-delegations')
  return res.data ?? []
}

export async function createDelegation(payload: CreateDelegationPayload): Promise<DelegationRecord> {
  if (USE_MOCK) {
    const rec: DelegationRecord = {
      id: `mock-${mockDelegations.length + 1}`,
      delegatorUserId: payload.delegatorUserId,
      delegateeUserId: payload.delegateeUserId,
      scope: payload.scope,
      scopeTemplateId: payload.scope === 'template' ? payload.scopeTemplateId ?? null : null,
      startAt: payload.startAt,
      endAt: payload.endAt,
      active: true,
    }
    mockDelegations.push(rec)
    return rec
  }
  const res = await apiPost<{ data: DelegationRecord }>('/api/approval-delegations', payload)
  return res.data
}

export async function updateDelegation(id: string, patch: UpdateDelegationPayload): Promise<DelegationRecord | null> {
  if (USE_MOCK) {
    const d = mockDelegations.find((x) => x.id === id)
    if (!d) return null
    const scope = patch.scope ?? d.scope
    Object.assign(d, {
      delegateeUserId: patch.delegateeUserId ?? d.delegateeUserId,
      scope,
      scopeTemplateId: scope === 'template' ? patch.scopeTemplateId ?? d.scopeTemplateId : null,
      startAt: patch.startAt ?? d.startAt,
      endAt: patch.endAt ?? d.endAt,
      active: patch.active ?? d.active,
    })
    return d
  }
  const res = await apiFetch(`/api/approval-delegations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })
  if (!res.ok) throw new Error(`Failed to update delegation (${res.status})`)
  return ((await res.json()) as { data: DelegationRecord }).data
}

export async function disableDelegation(id: string): Promise<void> {
  if (USE_MOCK) {
    const d = mockDelegations.find((x) => x.id === id)
    if (d) d.active = false
    return
  }
  const res = await apiFetch(`/api/approval-delegations/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`Failed to disable delegation (${res.status})`)
}

// Form helpers (testable, used by the 委托设置 dialog). Validation returns a zh
// message or null; buildCreatePayload normalizes to the API shape.
export interface DelegationForm {
  delegatorUserId: string
  delegateeUserId: string
  scope: 'all' | 'template'
  scopeTemplateId: string
  startAt: string
  endAt: string
}

export function validateDelegationForm(form: DelegationForm): string | null {
  if (!form.delegatorUserId.trim()) return '请填写委托人'
  if (!form.delegateeUserId.trim()) return '请填写被委托人'
  if (form.delegatorUserId.trim() === form.delegateeUserId.trim()) return '委托人与被委托人不能相同'
  if (form.scope === 'template' && !form.scopeTemplateId.trim()) return '指定模板范围需要选择模板'
  if (!form.startAt || !form.endAt) return '请填写时间窗'
  if (new Date(form.endAt).getTime() <= new Date(form.startAt).getTime()) return '结束时间必须晚于开始时间'
  return null
}

export function buildCreatePayload(form: DelegationForm): CreateDelegationPayload {
  return {
    delegatorUserId: form.delegatorUserId.trim(),
    delegateeUserId: form.delegateeUserId.trim(),
    scope: form.scope,
    scopeTemplateId: form.scope === 'template' ? form.scopeTemplateId.trim() : null,
    startAt: new Date(form.startAt).toISOString(),
    endAt: new Date(form.endAt).toISOString(),
  }
}

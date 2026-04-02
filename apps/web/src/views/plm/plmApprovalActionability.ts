import type { ApprovalEntry, ApprovalHistoryEntry } from './plmPanelModels'
import { decodeJwtPayload } from './usePlmAuthStatus'

type ApprovalActionStorage = Pick<Storage, 'getItem'>

const PLM_APPROVAL_TOKEN_KEYS = ['plm_token', 'auth_token', 'jwt'] as const
const PLM_APPROVAL_ACTOR_CLAIM_KEYS = [
  'userId',
  'user_id',
  'sub',
  'id',
  'uid',
  'username',
  'preferred_username',
  'email',
] as const

function normalizeApprovalIdentity(value: unknown): string {
  return String(value ?? '').trim()
}

function collectApprovalIdentity(value: unknown, identities: Set<string>) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectApprovalIdentity(item, identities))
    return
  }
  const normalized = normalizeApprovalIdentity(value)
  if (normalized) {
    identities.add(normalized)
  }
}

export function isPlmApprovalPendingStatus(value: unknown): boolean {
  return normalizeApprovalIdentity(value).toLowerCase() === 'pending'
}

export function getPlmApprovalApproverId(entry: ApprovalEntry | ApprovalHistoryEntry): string {
  const record = entry as Record<string, unknown>
  return normalizeApprovalIdentity(
    record.approver_id ?? record.approverId ?? record.user_id ?? record.userId,
  )
}

export function resolvePlmApprovalActorIds(storage?: ApprovalActionStorage | null): string[] {
  const identities = new Set<string>()

  for (const key of PLM_APPROVAL_TOKEN_KEYS) {
    const token = storage?.getItem(key) || ''
    if (!token) continue

    const payload = decodeJwtPayload(token)
    if (!payload) continue

    for (const claimKey of PLM_APPROVAL_ACTOR_CLAIM_KEYS) {
      collectApprovalIdentity(payload[claimKey], identities)
    }
  }

  return [...identities]
}

export function canActOnPlmApproval(
  entry: ApprovalEntry,
  actorIds: readonly string[],
  historyEntries: readonly ApprovalHistoryEntry[] = [],
): boolean {
  if (!isPlmApprovalPendingStatus(entry.status ?? entry.state)) {
    return false
  }

  const normalizedActorIds = actorIds
    .map((actorId) => normalizeApprovalIdentity(actorId))
    .filter(Boolean)
  if (!normalizedActorIds.length) {
    return false
  }

  const actorIdSet = new Set(normalizedActorIds)
  const approverId = getPlmApprovalApproverId(entry)
  if (approverId) {
    return actorIdSet.has(approverId)
  }

  return historyEntries.some((historyEntry) => {
    if (!isPlmApprovalPendingStatus(historyEntry.status ?? historyEntry.state)) {
      return false
    }
    const historyApproverId = getPlmApprovalApproverId(historyEntry)
    return Boolean(historyApproverId) && actorIdSet.has(historyApproverId)
  })
}

import type { ApprovalHistoryEntry } from './plmPanelModels'

function normalizeText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function normalizeVersion(value: unknown): string {
  const normalized = normalizeText(value)
  if (!normalized) return ''
  const parsed = Number(normalized)
  if (Number.isInteger(parsed) && parsed >= 0) {
    return String(parsed)
  }
  return normalized
}

export function resolvePlmApprovalHistoryActorLabel(entry: ApprovalHistoryEntry): string {
  return (
    normalizeText(entry?.actor_name) ||
    normalizeText(entry?.approver_name) ||
    normalizeText(entry?.user_name) ||
    normalizeText(entry?.username) ||
    normalizeText(entry?.actor_id) ||
    normalizeText(entry?.approver_id) ||
    normalizeText(entry?.user_id) ||
    '-'
  )
}

export function resolvePlmApprovalHistoryVersionLabel(entry: ApprovalHistoryEntry): string {
  const fromVersion = normalizeVersion(entry?.from_version ?? entry?.fromVersion)
  const toVersion = normalizeVersion(entry?.to_version ?? entry?.toVersion ?? entry?.version)
  if (fromVersion && toVersion) {
    return fromVersion === toVersion ? toVersion : `${fromVersion} -> ${toVersion}`
  }
  return toVersion || fromVersion || '-'
}

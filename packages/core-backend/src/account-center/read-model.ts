export type AccountCenterContext = 'selected' | 'selection_required'
export type AccountCenterGrant = 'enabled' | 'disabled' | 'revoked' | 'absent' | 'legacy_default'
export type AccountCenterNoticeReason = 'state_unreadable' | 'store_not_confirmed' | 'other_org' | 'unsupported_provider'

export interface AccountCenterRecordFact {
  kind: 'record'
  provider: 'dingtalk'
  source: 'legacy' | 'strict'
  label: string
  binding: 'bound' | 'not_bound'
  directoryManaged: boolean
  boundAt: string | null
  activeGrants: { enabled: boolean }[]
  hasRevokedHistory: boolean
  grantMode: 'records' | 'legacy_default'
}

export type AccountCenterFact = AccountCenterRecordFact
  | { kind: 'notice'; reason: 'state_unreadable' | 'store_not_confirmed' }
  | { kind: 'other_org' }
  | { kind: 'unsupported_provider' }

export interface AccountCenterFacts {
  context: AccountCenterContext
  items: AccountCenterFact[]
}

export type AccountCenterCard = {
  kind: 'record'
  key: string
  provider: 'dingtalk'
  source: 'legacy' | 'strict'
  label: string
  binding: 'bound' | 'not_bound'
  grant: AccountCenterGrant
  directoryManaged: boolean
  boundAt: string | null
} | { kind: 'notice'; key: string; reason: AccountCenterNoticeReason }

export interface AccountCenterResponse {
  ok: true
  data: { version: 2; context: AccountCenterContext; cards: AccountCenterCard[] }
}

function requireValid(valid: boolean): asserts valid {
  if (!valid) throw new Error('ACCOUNT_CENTER_STATE_UNREADABLE')
}

function exactKeys(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  requireValid(value !== null && typeof value === 'object' && !Array.isArray(value))
  const actual = Reflect.ownKeys(value as object)
  requireValid(actual.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key)))
}

function validTimestamp(value: unknown): boolean {
  if (value === null) return true
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

function validateRecord(item: AccountCenterRecordFact, context: AccountCenterContext): void {
  exactKeys(item, ['kind', 'provider', 'source', 'label', 'binding', 'directoryManaged', 'boundAt', 'activeGrants', 'hasRevokedHistory', 'grantMode'])
  requireValid(item.provider === 'dingtalk' && (item.source === 'legacy' || item.source === 'strict'))
  requireValid(typeof item.label === 'string' && (item.binding === 'bound' || item.binding === 'not_bound'))
  requireValid(typeof item.directoryManaged === 'boolean' && validTimestamp(item.boundAt))
  requireValid(typeof item.hasRevokedHistory === 'boolean' && Array.isArray(item.activeGrants))
  requireValid(item.grantMode === 'records' || item.grantMode === 'legacy_default')
  requireValid(item.source !== 'strict' || item.grantMode === 'records')
  requireValid(context !== 'selection_required' || item.source === 'legacy')
  requireValid(!(item.source === 'legacy' || context === 'selection_required') || item.directoryManaged === false)
  requireValid(item.binding !== 'not_bound' || item.boundAt === null)
  for (const grant of item.activeGrants) {
    exactKeys(grant, ['enabled'])
    requireValid(typeof grant.enabled === 'boolean')
  }
}

function grantFor(item: AccountCenterRecordFact): AccountCenterGrant | null {
  if (item.binding === 'not_bound') return 'absent'
  if (item.activeGrants.length > 1) return null
  if (item.activeGrants.length === 1) return item.activeGrants[0].enabled ? 'enabled' : 'disabled'
  if (item.hasRevokedHistory) return 'revoked'
  if (item.source === 'legacy' && item.grantMode === 'legacy_default') return 'legacy_default'
  return 'absent'
}

export function mapAccountCenterFacts(facts: AccountCenterFacts): AccountCenterResponse {
  exactKeys(facts, ['context', 'items'])
  requireValid(facts.context === 'selected' || facts.context === 'selection_required')
  requireValid(Array.isArray(facts.items))
  const cards: AccountCenterCard[] = []
  const aggregated = new Set<string>()
  for (const item of facts.items) {
    requireValid(item !== null && typeof item === 'object')
    const key = `card-${cards.length + 1}`
    if (item.kind === 'record') {
      validateRecord(item, facts.context)
      const grant = grantFor(item)
      if (grant === null) {
        cards.push({ kind: 'notice', key, reason: 'state_unreadable' })
        continue
      }
      const trimmed = item.label.trim()
      const label = item.source === 'legacy' ? '钉钉关联'
        : trimmed.length >= 1 && trimmed.length <= 120 ? trimmed : '钉钉连接'
      cards.push({
        kind: 'record', key, provider: 'dingtalk', source: item.source, label,
        binding: item.binding, grant, directoryManaged: item.directoryManaged, boundAt: item.boundAt,
      })
    } else if (item.kind === 'notice') {
      exactKeys(item, ['kind', 'reason'])
      requireValid(item.reason === 'state_unreadable' || item.reason === 'store_not_confirmed')
      cards.push({ kind: 'notice', key, reason: item.reason })
    } else {
      exactKeys(item, ['kind'])
      requireValid(item.kind === 'other_org' || item.kind === 'unsupported_provider')
      requireValid(item.kind !== 'other_org' || facts.context === 'selected')
      if (aggregated.has(item.kind)) continue
      aggregated.add(item.kind)
      cards.push({ kind: 'notice', key, reason: item.kind })
    }
  }
  requireValid(new Set(cards.map(card => card.key)).size === cards.length)
  return { ok: true, data: { version: 2, context: facts.context, cards } }
}

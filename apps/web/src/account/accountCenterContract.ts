export type AccountCenterContext = 'selected' | 'selection_required'
export type AccountCenterGrant = 'enabled' | 'disabled' | 'revoked' | 'absent' | 'legacy_default'
export type AccountCenterNoticeReason = 'state_unreadable' | 'store_not_confirmed' | 'other_org' | 'unsupported_provider'

export interface AccountCenterRecord {
  kind: 'record'
  key: string
  provider: 'dingtalk'
  source: 'legacy' | 'strict'
  label: string
  binding: 'bound' | 'not_bound'
  grant: AccountCenterGrant
  directoryManaged: boolean
  boundAt: string | null
}

export interface AccountCenterNotice {
  kind: 'notice'
  key: string
  reason: AccountCenterNoticeReason
}

export type AccountCenterCard = AccountCenterRecord | AccountCenterNotice

export interface AccountCenterResponse {
  ok: true
  data: {
    version: 2
    context: AccountCenterContext
    cards: AccountCenterCard[]
  }
}

// All objects have exactly the declared keys. Keys are unique response-local
// card-1, card-2, ... strings (1–128 UTF-16 units); labels have 1–120 UTF-16 units.
// boundAt is null or a valid YYYY-MM-DDTHH:mm:ss.SSSZ value with an exact ISO round trip.
// strict excludes legacy_default; not_bound requires absent and a null boundAt.
// legacy and selection_required records have directoryManaged=false.
// selection_required contains only global legacy records and applicable notices,
// never strict records or other_org. Any invalid field or combination returns null.
export type AccountCenterResponseParser = (value: unknown) => AccountCenterResponse | null

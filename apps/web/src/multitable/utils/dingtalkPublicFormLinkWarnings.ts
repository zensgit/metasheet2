export interface DingTalkPublicFormLinkView {
  id: string
  name?: string
  type?: string
  config?: Record<string, unknown> | undefined
}

export interface DingTalkPublicFormLinkWarningOptions {
  nowMs?: number
  warnWhenFullyPublic?: boolean
  warnWhenProtectedWithoutAllowlist?: boolean
}

export type DingTalkPublicFormLinkAccessLevel =
  | 'none'
  | 'unavailable'
  | 'public'
  | 'dingtalk'
  | 'dingtalk_granted'

export interface DingTalkPublicFormLinkAccessState {
  audienceSummary: string
  hasSelection: boolean
  level: DingTalkPublicFormLinkAccessLevel
  summary: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function publicFormLabel(view: DingTalkPublicFormLinkView | undefined, fallback: string): string {
  const name = typeof view?.name === 'string' ? view.name.trim() : ''
  return name || fallback
}

function parseExpiryMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function normalizeWarningOptions(value: number | DingTalkPublicFormLinkWarningOptions | undefined): DingTalkPublicFormLinkWarningOptions {
  if (typeof value === 'number') return { nowMs: value }
  return value ?? {}
}

function normalizeAccessMode(value: unknown): 'public' | 'dingtalk' | 'dingtalk_granted' {
  return value === 'dingtalk' || value === 'dingtalk_granted' ? value : 'public'
}

function hasAllowlistIds(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => typeof item === 'string' && item.trim())
}

function countAllowlistIds(value: unknown): number {
  if (!Array.isArray(value)) return 0
  return new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean),
  ).size
}

function describeAllowlistCounts(userCount: number, memberGroupCount: number): string {
  const parts: string[] = []
  if (userCount > 0) {
    parts.push(`${userCount} ${userCount === 1 ? 'local user' : 'local users'}`)
  }
  if (memberGroupCount > 0) {
    parts.push(`${memberGroupCount} ${memberGroupCount === 1 ? 'local member group' : 'local member groups'}`)
  }
  return parts.join(' and ')
}

export function describeDingTalkPublicFormLinkAudience(
  viewId: unknown,
  views: readonly DingTalkPublicFormLinkView[],
  optionsOrNowMs?: number | DingTalkPublicFormLinkWarningOptions,
): string {
  const options = normalizeWarningOptions(optionsOrNowMs)
  const nowMs = options.nowMs ?? Date.now()
  const id = typeof viewId === 'string' ? viewId.trim() : ''
  if (!id) return 'No public form link'

  const view = views.find((item) => item.id === id)
  if (!view || view.type !== 'form') return 'Allowed audience unavailable'

  const publicForm = isRecord(view.config?.publicForm) ? view.config.publicForm : null
  if (!publicForm || publicForm.enabled !== true) return 'Allowed audience unavailable'

  const publicToken = typeof publicForm.publicToken === 'string' ? publicForm.publicToken.trim() : ''
  if (!publicToken) return 'Allowed audience unavailable'

  const expiryMs = parseExpiryMs(publicForm.expiresAt ?? publicForm.expiresOn)
  if (expiryMs !== null && nowMs >= expiryMs) return 'Allowed audience unavailable'

  const accessMode = normalizeAccessMode(publicForm.accessMode)
  if (accessMode === 'public') return 'Anyone with the link can submit'

  const userCount = countAllowlistIds(publicForm.allowedUserIds)
  const memberGroupCount = countAllowlistIds(publicForm.allowedMemberGroupIds)
  if (userCount === 0 && memberGroupCount === 0) {
    return accessMode === 'dingtalk_granted'
      ? 'No local allowlist limits are set; all authorized DingTalk users can submit'
      : 'No local allowlist limits are set; all bound DingTalk users can submit'
  }

  return `${describeAllowlistCounts(userCount, memberGroupCount)} can submit after DingTalk checks`
}

export function describeDingTalkPublicFormLinkAccess(
  viewId: unknown,
  views: readonly DingTalkPublicFormLinkView[],
  optionsOrNowMs?: number | DingTalkPublicFormLinkWarningOptions,
): string {
  const options = normalizeWarningOptions(optionsOrNowMs)
  const nowMs = options.nowMs ?? Date.now()
  const id = typeof viewId === 'string' ? viewId.trim() : ''
  if (!id) return 'No public form link'

  const view = views.find((item) => item.id === id)
  if (!view) return 'View unavailable in this sheet'
  if (view.type !== 'form') return 'Selected view is not a form'

  const publicForm = isRecord(view.config?.publicForm) ? view.config.publicForm : null
  if (!publicForm) return 'Public form sharing is not configured'
  if (publicForm.enabled !== true) return 'Public form sharing is disabled'

  const publicToken = typeof publicForm.publicToken === 'string' ? publicForm.publicToken.trim() : ''
  if (!publicToken) return 'Public form sharing is missing a public token'

  const expiryMs = parseExpiryMs(publicForm.expiresAt ?? publicForm.expiresOn)
  if (expiryMs !== null && nowMs >= expiryMs) return 'Public form sharing has expired'

  const hasUserAllowlist = hasAllowlistIds(publicForm.allowedUserIds)
  const hasGroupAllowlist = hasAllowlistIds(publicForm.allowedMemberGroupIds)
  const hasAllowlist = hasUserAllowlist || hasGroupAllowlist
  const accessMode = normalizeAccessMode(publicForm.accessMode)

  if (accessMode === 'dingtalk') {
    return hasAllowlist ? 'DingTalk-bound users in allowlist can submit' : 'All bound DingTalk users can submit'
  }
  if (accessMode === 'dingtalk_granted') {
    return hasAllowlist ? 'Authorized DingTalk users in allowlist can submit' : 'All authorized DingTalk users can submit'
  }
  return 'Fully public; anyone with the link can submit'
}

export function getDingTalkPublicFormLinkAccessLevel(
  viewId: unknown,
  views: readonly DingTalkPublicFormLinkView[],
  optionsOrNowMs?: number | DingTalkPublicFormLinkWarningOptions,
): DingTalkPublicFormLinkAccessLevel {
  const options = normalizeWarningOptions(optionsOrNowMs)
  const nowMs = options.nowMs ?? Date.now()
  const id = typeof viewId === 'string' ? viewId.trim() : ''
  if (!id) return 'none'

  const view = views.find((item) => item.id === id)
  if (!view || view.type !== 'form') return 'unavailable'

  const publicForm = isRecord(view.config?.publicForm) ? view.config.publicForm : null
  if (!publicForm || publicForm.enabled !== true) return 'unavailable'

  const publicToken = typeof publicForm.publicToken === 'string' ? publicForm.publicToken.trim() : ''
  if (!publicToken) return 'unavailable'

  const expiryMs = parseExpiryMs(publicForm.expiresAt ?? publicForm.expiresOn)
  if (expiryMs !== null && nowMs >= expiryMs) return 'unavailable'

  return normalizeAccessMode(publicForm.accessMode)
}

export function getDingTalkPublicFormLinkAccessState(
  viewId: unknown,
  views: readonly DingTalkPublicFormLinkView[],
  optionsOrNowMs?: number | DingTalkPublicFormLinkWarningOptions,
): DingTalkPublicFormLinkAccessState {
  const options = normalizeWarningOptions(optionsOrNowMs)
  const stableOptions = { ...options, nowMs: options.nowMs ?? Date.now() }
  const id = typeof viewId === 'string' ? viewId.trim() : ''
  return {
    audienceSummary: describeDingTalkPublicFormLinkAudience(id, views, stableOptions),
    hasSelection: Boolean(id),
    level: getDingTalkPublicFormLinkAccessLevel(id, views, stableOptions),
    summary: describeDingTalkPublicFormLinkAccess(id, views, stableOptions),
  }
}

export function listDingTalkPublicFormLinkBlockingErrors(
  viewId: unknown,
  views: readonly DingTalkPublicFormLinkView[],
  optionsOrNowMs?: number | DingTalkPublicFormLinkWarningOptions,
): string[] {
  const options = normalizeWarningOptions(optionsOrNowMs)
  const nowMs = options.nowMs ?? Date.now()
  const id = typeof viewId === 'string' ? viewId.trim() : ''
  if (!id) return []

  const view = views.find((item) => item.id === id)
  if (!view) {
    return [`Public form view "${id}" is not available in this sheet; DingTalk messages may not include a working fill link.`]
  }
  if (view.type !== 'form') {
    return [`Selected public form view "${publicFormLabel(view, id)}" is not a form view; choose a form view before sending this DingTalk fill link.`]
  }

  const publicForm = isRecord(view.config?.publicForm) ? view.config.publicForm : null
  if (!publicForm) {
    return [`Public form sharing is not configured for "${publicFormLabel(view, id)}"; enable sharing before sending this DingTalk fill link.`]
  }
  if (publicForm.enabled !== true) {
    return [`Public form sharing is disabled for "${publicFormLabel(view, id)}"; enable sharing before sending this DingTalk fill link.`]
  }

  const publicToken = typeof publicForm.publicToken === 'string' ? publicForm.publicToken.trim() : ''
  if (!publicToken) {
    return [`Public form sharing for "${publicFormLabel(view, id)}" is missing a public token; re-enable sharing before sending this DingTalk fill link.`]
  }

  const expiryMs = parseExpiryMs(publicForm.expiresAt ?? publicForm.expiresOn)
  if (expiryMs !== null && nowMs >= expiryMs) {
    return [`Public form sharing for "${publicFormLabel(view, id)}" has expired; renew sharing before sending this DingTalk fill link.`]
  }

  return []
}

export function listDingTalkPublicFormLinkWarnings(
  viewId: unknown,
  views: readonly DingTalkPublicFormLinkView[],
  optionsOrNowMs?: number | DingTalkPublicFormLinkWarningOptions,
): string[] {
  const options = normalizeWarningOptions(optionsOrNowMs)
  const id = typeof viewId === 'string' ? viewId.trim() : ''
  if (!id) return []

  const blockingErrors = listDingTalkPublicFormLinkBlockingErrors(id, views, options)
  if (blockingErrors.length) return blockingErrors

  const view = views.find((item) => item.id === id)
  const publicForm = isRecord(view?.config?.publicForm) ? view.config.publicForm : null
  if (!publicForm) return []

  const accessMode = normalizeAccessMode(publicForm.accessMode)
  if (options.warnWhenFullyPublic && accessMode === 'public') {
    return [`Public form sharing for "${publicFormLabel(view, id)}" is fully public; everyone who can open the DingTalk message link can submit. Use DingTalk-protected access and an allowlist when only selected users should fill.`]
  }
  if (
    options.warnWhenProtectedWithoutAllowlist
    && (accessMode === 'dingtalk' || accessMode === 'dingtalk_granted')
    && !hasAllowlistIds(publicForm.allowedUserIds)
    && !hasAllowlistIds(publicForm.allowedMemberGroupIds)
  ) {
    const audience = accessMode === 'dingtalk_granted' ? 'authorized DingTalk users' : 'bound DingTalk users'
    return [`Public form sharing for "${publicFormLabel(view, id)}" allows all ${audience} to submit; add allowed users or member groups when only selected users should fill.`]
  }

  return []
}

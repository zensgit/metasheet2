import {
  automationDingTalkAllowlistSummary,
  automationLabel,
} from './meta-automation-labels'

export interface DingTalkPublicFormLinkView {
  id: string
  name?: string
  type?: string
  config?: Record<string, unknown> | undefined
}

export interface DingTalkPublicFormLinkWarningOptions {
  isZh?: boolean
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

function label(key: Parameters<typeof automationLabel>[0], isZh: boolean): string {
  return automationLabel(key, isZh)
}

export function describeDingTalkPublicFormLinkAudience(
  viewId: unknown,
  views: readonly DingTalkPublicFormLinkView[],
  optionsOrNowMs?: number | DingTalkPublicFormLinkWarningOptions,
): string {
  const options = normalizeWarningOptions(optionsOrNowMs)
  const nowMs = options.nowMs ?? Date.now()
  const isZh = options.isZh === true
  const id = typeof viewId === 'string' ? viewId.trim() : ''
  if (!id) return label('dingtalk.noPublicFormLink', isZh)

  const view = views.find((item) => item.id === id)
  if (!view || view.type !== 'form') return label('dingtalk.allowedAudienceUnavailable', isZh)

  const publicForm = isRecord(view.config?.publicForm) ? view.config.publicForm : null
  if (!publicForm || publicForm.enabled !== true) return label('dingtalk.allowedAudienceUnavailable', isZh)

  const publicToken = typeof publicForm.publicToken === 'string' ? publicForm.publicToken.trim() : ''
  if (!publicToken) return label('dingtalk.allowedAudienceUnavailable', isZh)

  const expiryMs = parseExpiryMs(publicForm.expiresAt ?? publicForm.expiresOn)
  if (expiryMs !== null && nowMs >= expiryMs) return label('dingtalk.allowedAudienceUnavailable', isZh)

  const accessMode = normalizeAccessMode(publicForm.accessMode)
  if (accessMode === 'public') return isZh ? '任何获得链接的人都可提交' : 'Anyone with the link can submit'

  const userCount = countAllowlistIds(publicForm.allowedUserIds)
  const memberGroupCount = countAllowlistIds(publicForm.allowedMemberGroupIds)
  if (userCount === 0 && memberGroupCount === 0) {
    return accessMode === 'dingtalk_granted'
      ? (isZh ? '未设置本地 allowlist 限制；所有已授权钉钉用户都可提交' : 'No local allowlist limits are set; all authorized DingTalk users can submit')
      : (isZh ? '未设置本地 allowlist 限制；所有已绑定钉钉用户都可提交' : 'No local allowlist limits are set; all bound DingTalk users can submit')
  }

  return isZh
    ? `${automationDingTalkAllowlistSummary(userCount, memberGroupCount, true)}通过钉钉检查后可提交`
    : `${automationDingTalkAllowlistSummary(userCount, memberGroupCount, false)} can submit after DingTalk checks`
}

export function describeDingTalkPublicFormLinkAccess(
  viewId: unknown,
  views: readonly DingTalkPublicFormLinkView[],
  optionsOrNowMs?: number | DingTalkPublicFormLinkWarningOptions,
): string {
  const options = normalizeWarningOptions(optionsOrNowMs)
  const nowMs = options.nowMs ?? Date.now()
  const isZh = options.isZh === true
  const id = typeof viewId === 'string' ? viewId.trim() : ''
  if (!id) return label('dingtalk.noPublicFormLink', isZh)

  const view = views.find((item) => item.id === id)
  if (!view) return label('dingtalk.viewUnavailable', isZh)
  if (view.type !== 'form') return label('dingtalk.selectedViewNotForm', isZh)

  const publicForm = isRecord(view.config?.publicForm) ? view.config.publicForm : null
  if (!publicForm) return label('dingtalk.publicFormNotConfigured', isZh)
  if (publicForm.enabled !== true) return label('dingtalk.publicFormDisabled', isZh)

  const publicToken = typeof publicForm.publicToken === 'string' ? publicForm.publicToken.trim() : ''
  if (!publicToken) return label('dingtalk.publicFormMissingToken', isZh)

  const expiryMs = parseExpiryMs(publicForm.expiresAt ?? publicForm.expiresOn)
  if (expiryMs !== null && nowMs >= expiryMs) return label('dingtalk.publicFormExpired', isZh)

  const hasUserAllowlist = hasAllowlistIds(publicForm.allowedUserIds)
  const hasGroupAllowlist = hasAllowlistIds(publicForm.allowedMemberGroupIds)
  const hasAllowlist = hasUserAllowlist || hasGroupAllowlist
  const accessMode = normalizeAccessMode(publicForm.accessMode)

  if (accessMode === 'dingtalk') {
    return hasAllowlist
      ? (isZh ? 'allowlist 中已绑定钉钉的用户可提交' : 'DingTalk-bound users in allowlist can submit')
      : (isZh ? '所有已绑定钉钉用户都可提交' : 'All bound DingTalk users can submit')
  }
  if (accessMode === 'dingtalk_granted') {
    return hasAllowlist
      ? (isZh ? 'allowlist 中已授权的钉钉用户可提交' : 'Authorized DingTalk users in allowlist can submit')
      : (isZh ? '所有已授权钉钉用户都可提交' : 'All authorized DingTalk users can submit')
  }
  return isZh ? '完全公开；任何获得链接的人都可提交' : 'Fully public; anyone with the link can submit'
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
  const isZh = options.isZh === true
  const id = typeof viewId === 'string' ? viewId.trim() : ''
  if (!id) return []

  const view = views.find((item) => item.id === id)
  if (!view) {
    return [isZh
      ? `公开表单视图 "${id}" 在此表中不可用；钉钉消息可能不包含可用的填写链接。`
      : `Public form view "${id}" is not available in this sheet; DingTalk messages may not include a working fill link.`]
  }
  if (view.type !== 'form') {
    return [isZh
      ? `所选公开表单视图 "${publicFormLabel(view, id)}" 不是表单视图；发送此钉钉填写链接前请选择表单视图。`
      : `Selected public form view "${publicFormLabel(view, id)}" is not a form view; choose a form view before sending this DingTalk fill link.`]
  }

  const publicForm = isRecord(view.config?.publicForm) ? view.config.publicForm : null
  if (!publicForm) {
    return [isZh
      ? `未为 "${publicFormLabel(view, id)}" 配置公开表单分享；发送此钉钉填写链接前请先启用分享。`
      : `Public form sharing is not configured for "${publicFormLabel(view, id)}"; enable sharing before sending this DingTalk fill link.`]
  }
  if (publicForm.enabled !== true) {
    return [isZh
      ? `"${publicFormLabel(view, id)}" 的公开表单分享已停用；发送此钉钉填写链接前请先启用分享。`
      : `Public form sharing is disabled for "${publicFormLabel(view, id)}"; enable sharing before sending this DingTalk fill link.`]
  }

  const publicToken = typeof publicForm.publicToken === 'string' ? publicForm.publicToken.trim() : ''
  if (!publicToken) {
    return [isZh
      ? `"${publicFormLabel(view, id)}" 的公开表单分享缺少公开令牌；发送此钉钉填写链接前请重新启用分享。`
      : `Public form sharing for "${publicFormLabel(view, id)}" is missing a public token; re-enable sharing before sending this DingTalk fill link.`]
  }

  const expiryMs = parseExpiryMs(publicForm.expiresAt ?? publicForm.expiresOn)
  if (expiryMs !== null && nowMs >= expiryMs) {
    return [isZh
      ? `"${publicFormLabel(view, id)}" 的公开表单分享已过期；发送此钉钉填写链接前请续期分享。`
      : `Public form sharing for "${publicFormLabel(view, id)}" has expired; renew sharing before sending this DingTalk fill link.`]
  }

  return []
}

export function listDingTalkPublicFormLinkWarnings(
  viewId: unknown,
  views: readonly DingTalkPublicFormLinkView[],
  optionsOrNowMs?: number | DingTalkPublicFormLinkWarningOptions,
): string[] {
  const options = normalizeWarningOptions(optionsOrNowMs)
  const isZh = options.isZh === true
  const id = typeof viewId === 'string' ? viewId.trim() : ''
  if (!id) return []

  const blockingErrors = listDingTalkPublicFormLinkBlockingErrors(id, views, options)
  if (blockingErrors.length) return blockingErrors

  const view = views.find((item) => item.id === id)
  const publicForm = isRecord(view?.config?.publicForm) ? view.config.publicForm : null
  if (!publicForm) return []

  const accessMode = normalizeAccessMode(publicForm.accessMode)
  if (options.warnWhenFullyPublic && accessMode === 'public') {
    return [isZh
      ? `"${publicFormLabel(view, id)}" 的公开表单分享完全公开；所有能打开钉钉消息链接的人都可提交。若仅允许指定用户填写，请使用钉钉保护访问和 allowlist。`
      : `Public form sharing for "${publicFormLabel(view, id)}" is fully public; everyone who can open the DingTalk message link can submit. Use DingTalk-protected access and an allowlist when only selected users should fill.`]
  }
  if (
    options.warnWhenProtectedWithoutAllowlist
    && (accessMode === 'dingtalk' || accessMode === 'dingtalk_granted')
    && !hasAllowlistIds(publicForm.allowedUserIds)
    && !hasAllowlistIds(publicForm.allowedMemberGroupIds)
  ) {
    const audience = accessMode === 'dingtalk_granted'
      ? (isZh ? '已授权钉钉用户' : 'authorized DingTalk users')
      : (isZh ? '已绑定钉钉用户' : 'bound DingTalk users')
    return [isZh
      ? `"${publicFormLabel(view, id)}" 的公开表单分享允许所有${audience}提交；若仅允许指定用户填写，请添加允许的用户或成员组。`
      : `Public form sharing for "${publicFormLabel(view, id)}" allows all ${audience} to submit; add allowed users or member groups when only selected users should fill.`]
  }

  return []
}

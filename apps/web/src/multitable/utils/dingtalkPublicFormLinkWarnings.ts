export interface DingTalkPublicFormLinkView {
  id: string
  name?: string
  type?: string
  config?: Record<string, unknown> | undefined
}

export interface DingTalkPublicFormLinkWarningOptions {
  nowMs?: number
  warnWhenFullyPublic?: boolean
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

export function listDingTalkPublicFormLinkWarnings(
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

  if (options.warnWhenFullyPublic && normalizeAccessMode(publicForm.accessMode) === 'public') {
    return [`Public form sharing for "${publicFormLabel(view, id)}" is fully public; everyone who can open the DingTalk message link can submit. Use DingTalk-protected access and an allowlist when only selected users should fill.`]
  }

  return []
}

export interface DingTalkPublicFormLinkView {
  id: string
  name?: string
  type?: string
  config?: Record<string, unknown> | undefined
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

export function listDingTalkPublicFormLinkWarnings(
  viewId: unknown,
  views: readonly DingTalkPublicFormLinkView[],
  nowMs = Date.now(),
): string[] {
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

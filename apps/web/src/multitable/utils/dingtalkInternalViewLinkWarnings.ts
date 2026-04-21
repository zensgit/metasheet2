export interface DingTalkInternalViewLinkView {
  id: string
  name?: string
}

export function listDingTalkInternalViewLinkBlockingErrors(
  viewId: unknown,
  views: readonly DingTalkInternalViewLinkView[],
): string[] {
  const id = typeof viewId === 'string' ? viewId.trim() : ''
  if (!id) return []

  const view = views.find((item) => item.id === id)
  if (!view) {
    return [`Internal processing view "${id}" is not available in this sheet; DingTalk messages may not include a working processing link.`]
  }

  return []
}

export function listDingTalkInternalViewLinkWarnings(
  viewId: unknown,
  views: readonly DingTalkInternalViewLinkView[],
): string[] {
  return listDingTalkInternalViewLinkBlockingErrors(viewId, views)
}

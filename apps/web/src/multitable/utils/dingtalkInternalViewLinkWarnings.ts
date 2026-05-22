export interface DingTalkInternalViewLinkView {
  id: string
  name?: string
}

export function listDingTalkInternalViewLinkBlockingErrors(
  viewId: unknown,
  views: readonly DingTalkInternalViewLinkView[],
  isZh = false,
): string[] {
  const id = typeof viewId === 'string' ? viewId.trim() : ''
  if (!id) return []

  const view = views.find((item) => item.id === id)
  if (!view) {
    return [isZh
      ? `内部处理视图 "${id}" 在此表中不可用；钉钉消息可能不包含可用的处理链接。`
      : `Internal processing view "${id}" is not available in this sheet; DingTalk messages may not include a working processing link.`]
  }

  return []
}

export function listDingTalkInternalViewLinkWarnings(
  viewId: unknown,
  views: readonly DingTalkInternalViewLinkView[],
  isZh = false,
): string[] {
  return listDingTalkInternalViewLinkBlockingErrors(viewId, views, isZh)
}

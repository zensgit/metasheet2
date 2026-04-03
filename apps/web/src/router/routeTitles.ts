import type { RouteMeta } from './types'

function normalizeTitle(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function resolveRouteDocumentTitle(meta: RouteMeta | undefined, isZh: boolean): string {
  const title = normalizeTitle(isZh ? meta?.titleZh || meta?.title : meta?.title)
  return title ? `${title} - MetaSheet` : 'MetaSheet'
}

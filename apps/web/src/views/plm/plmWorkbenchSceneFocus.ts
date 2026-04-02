import type { LocationQuery, LocationQueryValue } from 'vue-router'

export function buildWorkbenchSceneFocusQuery(
  query: LocationQuery,
  sceneId: string,
): Record<string, LocationQueryValue | LocationQueryValue[] | undefined> {
  return {
    ...query,
    sceneFocus: sceneId,
  }
}

export function readWorkbenchSceneFocus(query: LocationQuery): string {
  if (!Object.prototype.hasOwnProperty.call(query, 'sceneFocus')) {
    return ''
  }
  const raw = query.sceneFocus
  const value = Array.isArray(raw) ? raw[0] : raw
  if (value === undefined || value === null) return ''
  return String(value)
}

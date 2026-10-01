export type GeoFencePayload = {
  lat: number
  lng: number
  radiusMeters: number
}

export type GeoFenceSaveDecision =
  | { ok: true; geoFence: GeoFencePayload | null; explicitClear: boolean }
  | { ok: false; reason: 'incomplete' }

type Translate = (en: string, zh: string) => string

function finiteCoordinate(text: string): number {
  if (!text) return Number.NaN
  return Number(text)
}

/**
 * All three fields blank is an explicit clear (`null`).
 * A partial or invalid triple is refused so it cannot be saved as `null`.
 */
export function resolveGeoFenceSave(input: {
  lat: string
  lng: string
  radius: string
}): GeoFenceSaveDecision {
  const latText = input.lat.trim()
  const lngText = input.lng.trim()
  const radiusText = input.radius.trim()
  if (!latText && !lngText && !radiusText) {
    return { ok: true, geoFence: null, explicitClear: true }
  }
  const lat = finiteCoordinate(latText)
  const lng = finiteCoordinate(lngText)
  const radius = finiteCoordinate(radiusText)
  if (
    latText
    && lngText
    && radiusText
    && Number.isFinite(lat)
    && Number.isFinite(lng)
    && Number.isInteger(radius)
    && radius >= 1
  ) {
    return {
      ok: true,
      geoFence: { lat, lng, radiusMeters: radius },
      explicitClear: false,
    }
  }
  return { ok: false, reason: 'incomplete' }
}

export function geoFenceIncompleteMessage(tr: Translate): string {
  return tr(
    'Enter latitude, longitude, and a whole radius of at least 1 meter together, or clear all three to turn the fence off. Nothing was saved.',
    '请同时填写纬度、经度和至少 1 米的整数半径，或把三项都清空以关闭围栏。本次未保存。',
  )
}

export function geoFenceClearedMessage(tr: Translate): string {
  return tr('Settings updated. Geofence turned off.', '设置已更新。地理围栏已关闭。')
}

export const GEO_FENCE_HINT_EN = 'Latitude, longitude, and radius save together. Leave all three empty to turn the fence off. A partial fill is rejected and does not clear an existing fence.'
export const GEO_FENCE_HINT_ZH = '纬度、经度和半径需一起保存。三项都留空才会关闭围栏。只填一部分会被拒绝，且不会清掉已有围栏。'

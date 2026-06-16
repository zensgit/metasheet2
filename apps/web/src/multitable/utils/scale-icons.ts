// Shared icon-set glyph table for range-based SCALE conditional formatting
// (A5 icon-set kind). Extracted from MetaGridTable.vue so the renderer and the
// scale-rule authoring dialog (ScaleFormattingDialog.vue) draw the SAME glyphs —
// duplicating the constant would let the in-dialog preview drift from the actual
// grid render (the team's wire-vs-fixture drift trap).
//
// The backend (conditional-formatting-service) only emits index ∈ {0,1,2}; an
// out-of-range or unknown set yields no icon (fail-safe).
import type { ConditionalFormattingIconSetName } from '../types'

export interface ScaleIconGlyph {
  glyph: string
  color: string
}

export const SCALE_ICON_GLYPHS: Record<string, ReadonlyArray<ScaleIconGlyph>> = {
  arrows3: [
    { glyph: '↓', color: '#e53935' },
    { glyph: '→', color: '#fb8c00' },
    { glyph: '↑', color: '#43a047' },
  ],
  traffic3: [
    { glyph: '●', color: '#e53935' },
    { glyph: '●', color: '#fbc02d' },
    { glyph: '●', color: '#43a047' },
  ],
  signs3: [
    { glyph: '✕', color: '#e53935' },
    { glyph: '!', color: '#fb8c00' },
    { glyph: '✓', color: '#43a047' },
  ],
}

/** The three authorable icon sets, in display order. */
export const SCALE_ICON_SET_NAMES: ReadonlyArray<ConditionalFormattingIconSetName> = [
  'arrows3',
  'traffic3',
  'signs3',
]

/**
 * Resolve a glyph from a packed `iconKey` (`${set}:${index}`). Returns null for
 * an unknown set or out-of-range index (fail-safe, mirrors the grid renderer).
 */
export function glyphForIconKey(iconKey: string): ScaleIconGlyph | null {
  const sep = iconKey.lastIndexOf(':')
  if (sep < 0) return null
  const set = iconKey.slice(0, sep)
  const idx = Number(iconKey.slice(sep + 1))
  const glyphs = SCALE_ICON_GLYPHS[set]
  if (!glyphs || !Number.isInteger(idx) || idx < 0 || idx >= glyphs.length) return null
  return glyphs[idx]
}

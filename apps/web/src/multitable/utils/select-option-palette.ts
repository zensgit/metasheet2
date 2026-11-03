/**
 * Shared palette for select / multiSelect option colours (field manager).
 *
 * WHY: the option colour was a bare text input — the only way to set a colour was to
 * hand-type a hex string, and an unset colour rendered identically to `#409eff`
 * (the input's placeholder). This module is the single source for
 *   (a) the click-to-pick preset swatches,
 *   (b) the auto-assigned colour for a newly added option, and
 *   (c) the hex normalisation the native `<input type="color">` needs.
 *
 * SHAPE CONTRACT: every preset is a 6-digit `#rrggbb`. The chip renderer
 * (`utils/option-chip-tone.ts`, consumed by MetaCellRenderer/MetaKanbanView) only
 * understands `#rgb` / `#rrggbb` / `rgb()`, so 3-digit or named colours must never
 * be produced here.
 */

/** 10 mid-saturation presets — legible as a chip background with dark text. */
export const SELECT_OPTION_PALETTE: readonly string[] = Object.freeze([
  '#409eff',
  '#67c23a',
  '#e6a23c',
  '#f56c6c',
  '#909399',
  '#7c5cff',
  '#13c2c2',
  '#eb2f96',
  '#2f54eb',
  '#fa8c16',
])

const HEX_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/** True for `#rgb` / `#rrggbb` (case-insensitive), after trimming. Nothing else. */
export function isHexColor(value: unknown): boolean {
  return typeof value === 'string' && HEX_PATTERN.test(value.trim())
}

/**
 * `#abc` → `#aabbcc`; `#aabbcc` → `#aabbcc` (lower-cased). Anything that is not a
 * hex colour → `''`.
 *
 * WHY: the native colour input silently falls back to `#000000` when its `value`
 * is not a 6-digit hex, so a stored 3-digit colour would look black in the picker
 * and then get written back as black on the first interaction.
 */
export function expandHex(value: unknown): string {
  if (!isHexColor(value)) return ''
  const hex = (value as string).trim().toLowerCase()
  if (hex.length === 7) return hex
  return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
}

/**
 * Colour for the option at `index` — cycles through the palette so two adjacent
 * options never share a colour. Non-finite/negative indexes fall back to the head
 * of the palette (never `undefined`, which would write `undefined` into a draft).
 */
export function nextPaletteColor(index: number): string {
  const size = SELECT_OPTION_PALETTE.length
  if (!Number.isFinite(index)) return SELECT_OPTION_PALETTE[0]
  const normalized = ((Math.trunc(index) % size) + size) % size
  return SELECT_OPTION_PALETTE[normalized]
}

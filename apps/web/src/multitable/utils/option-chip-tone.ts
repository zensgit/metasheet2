/**
 * Select / status chip wash: keep the option hue, drop saturation so chips
 * read as Feishu/Airtable-like tokens instead of solid bright pills.
 */

export type OptionChipTone = {
  background: string
  color: string
}

const FALLBACK: OptionChipTone = { background: '#f3f4f6', color: '#4b5563' }

function parseHexColor(raw: string): { r: number; g: number; b: number } | null {
  const value = raw.trim()
  const short = /^#([0-9a-fA-F]{3})$/.exec(value)
  if (short) {
    const [r, g, b] = short[1].split('').map((ch) => parseInt(ch + ch, 16))
    return { r, g, b }
  }
  const full = /^#([0-9a-fA-F]{6})$/.exec(value)
  if (full) {
    return {
      r: parseInt(full[1].slice(0, 2), 16),
      g: parseInt(full[1].slice(2, 4), 16),
      b: parseInt(full[1].slice(4, 6), 16),
    }
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value)
  if (rgb) {
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) }
  }
  return null
}

export function optionChipTone(color?: string | null): OptionChipTone {
  if (!color || !color.trim()) return FALLBACK
  const rgb = parseHexColor(color)
  if (!rgb) return FALLBACK
  const { r, g, b } = rgb
  const text = {
    r: Math.round(r * 0.38 + 18),
    g: Math.round(g * 0.38 + 18),
    b: Math.round(b * 0.38 + 18),
  }
  const luminance = (text.r * 299 + text.g * 587 + text.b * 114) / 1000
  return {
    background: `rgba(${r}, ${g}, ${b}, 0.14)`,
    color: luminance > 130 ? '#374151' : `rgb(${text.r}, ${text.g}, ${text.b})`,
  }
}

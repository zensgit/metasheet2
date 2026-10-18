import { copyText } from '../../utils/clipboard'

// Thin PLM-facing wrappers over the shared `copyText` (apps/web/src/utils/clipboard.ts), which owns the
// Clipboard API + execCommand fallback. Kept as a module because stock-prep and PLM views import it.
export async function copyTextToClipboard(value: string): Promise<boolean> {
  if (!value) return false
  return copyText(value)
}

export async function copyListToClipboard(values: string[], separator = '\n'): Promise<boolean> {
  const filtered = values.filter((value) => String(value || '').length > 0)
  if (!filtered.length) return false
  return copyTextToClipboard(filtered.join(separator))
}

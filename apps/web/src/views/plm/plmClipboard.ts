export async function copyTextToClipboard(value: string): Promise<boolean> {
  if (!value) return false

  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // fallback below
  }

  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'absolute'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  const ok = document.execCommand('copy')
  document.body.removeChild(textarea)
  return ok
}

export async function copyListToClipboard(values: string[], separator = '\n'): Promise<boolean> {
  const filtered = values.filter((value) => String(value || '').length > 0)
  if (!filtered.length) return false
  return copyTextToClipboard(filtered.join(separator))
}

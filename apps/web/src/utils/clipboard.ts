/**
 * The ONE place in apps/web/src that may touch the async Clipboard API (`navigator.clipboard`).
 *
 * Why: `navigator.clipboard` is only exposed in a secure context (HTTPS or localhost). A deployment
 * reached over plain HTTP by IP — e.g. a customer intranet — has `isSecureContext === false`, so
 * `navigator.clipboard` is `undefined` there. Call sites that used it directly either threw a
 * TypeError on click (bare `navigator.clipboard.writeText(...)`) or silently did nothing (guarded
 * with `?.`). `document.execCommand('copy')` on a selected off-screen textarea is deprecated but is
 * still supported by every browser in a non-secure context, so it is the fallback.
 *
 * Contract of `copyText(text)`:
 *   1. `navigator.clipboard.writeText` when it is a function (looked up on every call, so test stubs
 *      on `navigator.clipboard` keep working) — resolves `true` when it succeeds.
 *   2. If it is absent OR it rejects/throws (permission denied, document not focused, …): the
 *      execCommand fallback — an off-screen, read-only `<textarea>` holding the text is selected and
 *      `document.execCommand('copy')` is issued; the textarea is ALWAYS removed again and the
 *      previous selection + focus are restored. Resolves to execCommand's boolean answer.
 *   3. No `document` / no `execCommand` / anything throwing: resolves `false`.
 *   It NEVER rejects. It never logs the text (callers copy API-token plaintext and public links).
 *
 * `readClipboardText()` is the programmatic read side (the grid's "Paste range" toolbar button).
 * There is no fallback for a programmatic read (browsers disable `execCommand('paste')`), so it
 * rejects with `ClipboardReadUnavailableError` when the API is absent; `canReadClipboardText()` lets
 * such a button tell the user up front instead.
 *
 * Keyboard paste (Ctrl/Cmd+V) does NOT go through `readClipboardText()`: it reads the native `paste`
 * event via `pasteEventText(event)`. `event.clipboardData` is filled by the user's own gesture, is
 * readable in a non-secure context too, and never triggers a permission prompt.
 *
 * Guarded by apps/web/tests/clipboard-no-bare-navigator-clipboard.spec.ts (no other file in src may
 * mention the native API).
 */

interface ClipboardLike {
  writeText?: (text: string) => Promise<void>
  readText?: () => Promise<string>
}

export class ClipboardReadUnavailableError extends Error {
  constructor() {
    super('Clipboard read is unavailable (no navigator.clipboard.readText in this context)')
    this.name = 'ClipboardReadUnavailableError'
  }
}

function nativeClipboard(): ClipboardLike | undefined {
  try {
    if (typeof navigator === 'undefined') return undefined
    return (navigator as { clipboard?: ClipboardLike }).clipboard ?? undefined
  } catch {
    return undefined
  }
}

function hasExecCommand(): boolean {
  return typeof document !== 'undefined' && typeof document.execCommand === 'function'
}

/**
 * Whether ANY copy mechanism exists on this page (async Clipboard API or the execCommand fallback).
 * For UI that disables a copy control up front; `copyText` itself never needs this check.
 */
export function canCopyText(): boolean {
  return typeof nativeClipboard()?.writeText === 'function' || hasExecCommand()
}

function execCommandCopy(text: string): boolean {
  if (typeof document === 'undefined') return false
  const doc = document
  if (!doc.body || typeof doc.execCommand !== 'function') return false

  const previouslyFocused = doc.activeElement as (Element & { focus?: (options?: FocusOptions) => void }) | null
  const selection = typeof doc.getSelection === 'function' ? doc.getSelection() : null
  const savedRanges: Range[] = []
  try {
    if (selection) {
      for (let index = 0; index < selection.rangeCount; index += 1) savedRanges.push(selection.getRangeAt(index))
    }
  } catch {
    savedRanges.length = 0
  }

  const textarea = doc.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.setAttribute('aria-hidden', 'true')
  textarea.setAttribute('tabindex', '-1')
  // Fixed + off-viewport: never shifts layout and never scrolls the page; 12pt avoids iOS zoom-on-focus.
  const style = textarea.style
  style.position = 'fixed'
  style.top = '0'
  style.left = '-9999px'
  style.width = '1px'
  style.height = '1px'
  style.padding = '0'
  style.border = '0'
  style.margin = '0'
  style.opacity = '0'
  style.pointerEvents = 'none'
  style.fontSize = '12pt'

  let ok = false
  try {
    doc.body.appendChild(textarea)
    try {
      textarea.focus({ preventScroll: true })
    } catch {
      // focus is best-effort; select() below is what execCommand needs
    }
    textarea.select()
    try {
      textarea.setSelectionRange(0, text.length)
    } catch {
      // some engines reject setSelectionRange on a readonly textarea; select() already covered it
    }
    ok = doc.execCommand('copy') === true
  } catch {
    ok = false
  } finally {
    try {
      textarea.parentNode?.removeChild(textarea)
    } catch {
      // nothing else to do — the element is detached or the document is gone
    }
    try {
      if (selection) {
        selection.removeAllRanges()
        for (const range of savedRanges) selection.addRange(range)
      }
    } catch {
      // selection restore is best-effort
    }
    try {
      if (previouslyFocused && previouslyFocused !== doc.body && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus({ preventScroll: true })
      }
    } catch {
      // focus restore is best-effort
    }
  }
  return ok
}

export async function copyText(text: string): Promise<boolean> {
  const clipboard = nativeClipboard()
  if (typeof clipboard?.writeText === 'function') {
    try {
      await clipboard.writeText(text)
      return true
    } catch {
      // permission denied / not focused / insecure-context shim: fall through to execCommand
    }
  }
  try {
    return execCommandCopy(text)
  } catch {
    return false
  }
}

// Deliberately NOT `async`: it hands back the native promise itself, so `await readClipboardText()`
// settles on exactly the same microtask as the `await navigator.clipboard.readText()` it replaced
// (the grid paste handlers and their specs are sensitive to that).
export function readClipboardText(): Promise<string> {
  const clipboard = nativeClipboard()
  if (typeof clipboard?.readText !== 'function') return Promise.reject(new ClipboardReadUnavailableError())
  return clipboard.readText()
}

/**
 * Whether a programmatic clipboard read (`readClipboardText()`) can work on this page at all. False on
 * a plain-HTTP deployment (no `navigator.clipboard`), where only a native paste gesture can read.
 */
export function canReadClipboardText(): boolean {
  return typeof nativeClipboard()?.readText === 'function'
}

/**
 * The plain-text payload of a native `paste` event, or `null` when the event carries no
 * `clipboardData` object at all. A paste without a text flavour (an image only, say) yields `''`,
 * which is what `navigator.clipboard.readText()` resolves to in that case too, so both read paths
 * feed the same text into the same paste logic.
 */
export function pasteEventText(event: ClipboardEvent): string | null {
  const data = event.clipboardData
  if (!data || typeof data.getData !== 'function') return null
  try {
    return data.getData('text/plain') ?? ''
  } catch {
    return ''
  }
}

/**
 * Non-secure-context clipboard guard.
 *
 * The async Clipboard API only exists in a secure context (HTTPS or localhost). A deployment reached
 * over plain HTTP by IP (customer intranet) has `isSecureContext === false` and no Clipboard API:
 * copy buttons that called it directly either threw a TypeError on click or silently did nothing.
 * Same family as the UUID guard (uuid-no-bare-randomuuid.spec.ts, #6358).
 *
 * Two halves:
 *   1. Tripwire — no file under apps/web/src except src/utils/clipboard.ts may touch the native API
 *      (`navigator.clipboard` / `navigator?.clipboard`); every caller goes through `copyText()` /
 *      `readClipboardText()` / `canCopyText()` / `canReadClipboardText()`; keyboard paste reads the
 *      native paste event through `pasteEventText()`.
 *   2. Contract of `copyText()` itself — native pass-through, execCommand('copy') fallback on an
 *      off-screen textarea that is always removed again, `false` (never a throw) when nothing works.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  canCopyText,
  canReadClipboardText,
  ClipboardReadUnavailableError,
  copyText,
  pasteEventText,
  readClipboardText,
} from '../src/utils/clipboard'

const SRC_ROOT = resolve(__dirname, '../src')
const HELPER = 'utils/clipboard.ts'
// Built from parts so this spec never matches itself.
const NAV = ['navi', 'gator'].join('')
const API = ['clip', 'board'].join('')
const NATIVE_ACCESS = new RegExp(`${NAV}\\s*\\??\\.\\s*${API}\\b`)
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.vue']

function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full))
    } else if (SCANNED_EXTENSIONS.some((ext) => name.endsWith(ext))) {
      out.push(full)
    }
  }
  return out
}

describe('tripwire: no bare native Clipboard API access in apps/web/src', () => {
  const files = listSourceFiles(SRC_ROOT).map((full) => ({
    full,
    rel: relative(SRC_ROOT, full).split(sep).join('/'),
  }))

  it('the pattern catches both the plain and the optional-chained spelling (pattern is not blind)', () => {
    expect(NATIVE_ACCESS.test(`${NAV}.${API}.writeText(x)`)).toBe(true)
    expect(NATIVE_ACCESS.test(`${NAV}?.${API}?.writeText(x)`)).toBe(true)
    expect(NATIVE_ACCESS.test(`window.${NAV}.${API}`)).toBe(true)
    expect(NATIVE_ACCESS.test(`event.${API}Data`)).toBe(false)
  })

  it('scans a non-trivial source tree that includes the helper (scan is not blind)', () => {
    expect(files.length).toBeGreaterThan(500)
    const helper = files.find((file) => file.rel === HELPER)
    expect(helper).toBeDefined()
    expect(NATIVE_ACCESS.test(readFileSync(helper!.full, 'utf8'))).toBe(true)
  })

  it('only src/utils/clipboard.ts touches the native Clipboard API', () => {
    const offenders = files
      .filter((file) => file.rel !== HELPER)
      .flatMap((file) => readFileSync(file.full, 'utf8')
        .split(/\r?\n/)
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => NATIVE_ACCESS.test(line))
        .map(({ line, index }) => `src/${file.rel}:${index + 1}: ${line.trim()}`))
    expect(offenders).toEqual([])
  })
})

type ClipboardStub = { writeText?: (text: string) => Promise<void>; readText?: () => Promise<string> } | undefined

describe('copyText() / canCopyText() / readClipboardText()', () => {
  let originalClipboard: PropertyDescriptor | undefined
  let originalExecCommand: PropertyDescriptor | undefined

  function stubClipboard(value: ClipboardStub): void {
    Object.defineProperty(navigator, API, { configurable: true, value })
  }

  function stubExecCommand(impl: ((command: string) => boolean) | undefined): ReturnType<typeof vi.fn> {
    const fn = vi.fn(impl ?? (() => false))
    Object.defineProperty(document, 'execCommand', { configurable: true, writable: true, value: impl ? fn : undefined })
    return fn
  }

  beforeEach(() => {
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, API)
    originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    if (originalClipboard) Object.defineProperty(navigator, API, originalClipboard)
    else Reflect.deleteProperty(navigator, API)
    if (originalExecCommand) Object.defineProperty(document, 'execCommand', originalExecCommand)
    else Reflect.deleteProperty(document, 'execCommand')
    document.body.innerHTML = ''
  })

  it('① secure context: uses navigator.clipboard.writeText and never touches execCommand', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard({ writeText })
    const execCommand = stubExecCommand(() => true)
    await expect(copyText('hello')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('hello')
    expect(execCommand).not.toHaveBeenCalled()
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('② writeText rejects (permission denied): falls back to execCommand instead of answering false', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'))
    stubClipboard({ writeText })
    const execCommand = stubExecCommand(() => true)
    await expect(copyText('token-plaintext')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(execCommand).toHaveBeenCalledTimes(1)
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('② writeText throws synchronously: same fallback', async () => {
    stubClipboard({ writeText: () => { throw new TypeError('boom') } })
    const execCommand = stubExecCommand(() => true)
    await expect(copyText('x')).resolves.toBe(true)
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('③ no Clipboard API (plain-HTTP intranet): off-screen read-only textarea holds the text, is selected, then removed; focus is restored', async () => {
    stubClipboard(undefined)
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    expect(document.activeElement).toBe(input)

    const seen: Array<{ value: string; readOnly: boolean; position: string; inBody: boolean; selected: string; active: boolean }> = []
    const execCommand = stubExecCommand((command) => {
      expect(command).toBe('copy')
      const areas = document.querySelectorAll('textarea')
      expect(areas).toHaveLength(1)
      const area = areas[0]!
      seen.push({
        value: area.value,
        readOnly: area.readOnly,
        position: area.style.position,
        inBody: area.parentNode === document.body,
        selected: area.value.slice(area.selectionStart ?? 0, area.selectionEnd ?? 0),
        active: document.activeElement === area,
      })
      return true
    })

    const text = '项目号\tP-001\nline two'
    await expect(copyText(text)).resolves.toBe(true)
    expect(execCommand).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([{ value: text, readOnly: true, position: 'fixed', inBody: true, selected: text, active: true }])
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
    expect(document.activeElement).toBe(input)
    expect(canCopyText()).toBe(true)
  })

  it('④ execCommand answers false: resolves false, textarea still removed', async () => {
    stubClipboard(undefined)
    const execCommand = stubExecCommand(() => false)
    await expect(copyText('x')).resolves.toBe(false)
    expect(execCommand).toHaveBeenCalledTimes(1)
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('④ execCommand throws: resolves false (never rejects), textarea still removed', async () => {
    stubClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) })
    const execCommand = stubExecCommand(() => { throw new Error('SecurityError') })
    await expect(copyText('x')).resolves.toBe(false)
    expect(execCommand).toHaveBeenCalledTimes(1)
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('④ neither Clipboard API nor execCommand (jsdom default): resolves false and canCopyText() is false', async () => {
    stubClipboard(undefined)
    stubExecCommand(undefined)
    await expect(copyText('x')).resolves.toBe(false)
    expect(canCopyText()).toBe(false)
  })

  it('⑤ no document and no Clipboard API: resolves false, never throws', async () => {
    stubClipboard(undefined)
    vi.stubGlobal('document', undefined)
    await expect(copyText('x')).resolves.toBe(false)
    expect(canCopyText()).toBe(false)
    vi.stubGlobal('navigator', undefined)
    await expect(copyText('x')).resolves.toBe(false)
    expect(canCopyText()).toBe(false)
  })

  it('canCopyText() is true with only the Clipboard API', () => {
    stubClipboard({ writeText: vi.fn().mockResolvedValue(undefined) })
    stubExecCommand(undefined)
    expect(canCopyText()).toBe(true)
  })

  it('readClipboardText(): passes through readText; rejects with ClipboardReadUnavailableError when absent', async () => {
    stubClipboard({ readText: vi.fn().mockResolvedValue('a\tb') })
    await expect(readClipboardText()).resolves.toBe('a\tb')
    stubClipboard(undefined)
    await expect(readClipboardText()).rejects.toBeInstanceOf(ClipboardReadUnavailableError)
  })

  it('canReadClipboardText(): true only when readText exists (false on plain HTTP, and with write-only stubs)', () => {
    stubClipboard({ readText: vi.fn().mockResolvedValue('') })
    expect(canReadClipboardText()).toBe(true)
    stubClipboard({ writeText: vi.fn().mockResolvedValue(undefined) })
    expect(canReadClipboardText()).toBe(false)
    stubClipboard(undefined)
    expect(canReadClipboardText()).toBe(false)
  })

  it('pasteEventText(): reads text/plain from the paste event, needs no Clipboard API, null without clipboardData', () => {
    stubClipboard(undefined)
    const withData = (getData: (type: string) => string) => {
      const event = new Event('paste') as ClipboardEvent
      Object.defineProperty(event, 'clipboardData', { value: { getData } })
      return event
    }
    const getData = vi.fn((type: string) => (type === 'text/plain' ? 'a\tb' : '<b>a</b>'))
    expect(pasteEventText(withData(getData))).toBe('a\tb')
    expect(getData).toHaveBeenCalledWith('text/plain')
    expect(pasteEventText(withData(() => ''))).toBe('') // image-only paste: no text flavour
    expect(pasteEventText(withData(() => { throw new Error('denied') }))).toBe('')
    const bare = new Event('paste') as ClipboardEvent
    Object.defineProperty(bare, 'clipboardData', { value: null })
    expect(pasteEventText(bare)).toBeNull()
  })
})

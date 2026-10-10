// Shared, framework-free helpers for the A1 「提示与实际状态」 AttendanceView wiring specs. The vi.mock calls
// themselves must stay in each spec file (vitest hoists them per file); only the plain builders live here.
// Not a spec (no .spec.ts / .test.ts suffix), so vitest never collects it.
import { nextTick } from 'vue'

export function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    blob: async () => new Blob([JSON.stringify(payload)], { type: 'application/json' }),
  } as unknown as Response
}

/** The catch-all body the big attendance admin suite returns for endpoints a spec does not care about. */
export function emptyAttendanceResponse(): Response {
  return jsonResponse(200, { ok: true, data: { items: [], summary: null } })
}

export async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

export interface RecordedApiCall {
  url: string
  method: string
  body: Record<string, unknown> | null
}

/** Normalise the (input, init) pair AttendanceView hands to apiFetch into a comparable record. */
export function recordApiCall(input: unknown, init: unknown): RecordedApiCall {
  const url = typeof input === 'string' ? input : String((input as { url?: unknown })?.url ?? input)
  const options = (init ?? {}) as { method?: string; body?: unknown }
  const method = String(options.method || 'GET').toUpperCase()
  let body: Record<string, unknown> | null = null
  if (typeof options.body === 'string' && options.body) {
    try {
      body = JSON.parse(options.body) as Record<string, unknown>
    } catch {
      body = null
    }
  }
  return { url, method, body }
}

export function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
  window.dispatchEvent(new Event('resize'))
}

export function setInput(container: HTMLElement, selector: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(selector)
  if (!input) throw new Error(`expected input ${selector}`)
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

export function setCheckbox(container: HTMLElement, selector: string, checked: boolean): void {
  const input = container.querySelector<HTMLInputElement>(selector)
  if (!input) throw new Error(`expected checkbox ${selector}`)
  input.checked = checked
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

export function buttonByText(root: ParentNode, label: string): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent?.trim() === label)
  if (!button) throw new Error(`expected a button labelled "${label}"`)
  return button
}

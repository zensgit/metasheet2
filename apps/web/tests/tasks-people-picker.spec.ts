import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App as VueApp } from 'vue'

/**
 * Task usability package 1b — the people picker.
 *
 *  1. The client (`tasks/tasksApi.ts`): `searchPeople`, `resolvePeople` and `getTaskPeople` read
 *     their answers strictly (one malformed row makes the whole answer an error), map each failure
 *     to its own kind, never throw, and check every id before a request is built.
 *  2. The component (`tasks/TaskPeoplePicker.vue`): a blank term sends nothing and asks for a name;
 *     a term is sent once after the pause and an older answer is dropped; each row shows the name,
 *     a distinguishing detail and, for someone who cannot use tasks yet, a mark (not tickable as an
 *     assignee, tickable as a follower); each failure has its own copy; confirm hands back only the
 *     ticked ids.
 *  3. Account switches (the component): an answer that lands after the signed-in account changed is
 *     not shown, whether the switch was seen or not; a switch seen while the picker is open (another
 *     tab's storage change, or a session switch in this tab) clears the rows, the ticks and a pending
 *     search, and so does another org for the same person; a search due or a confirm after an unseen
 *     switch sends and hands back nothing; a token refresh for the same person keeps the rows and
 *     the ticks, and a search under one account shows its rows as usual.
 *
 * Only the transport (`apiFetch`) and the locale are replaced.
 */

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  isZh: { value: true },
}))

vi.mock('../src/utils/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}))

// Read when a component is set up; each cell sets the language before it mounts.
vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({ locale: { value: mocks.isZh.value ? 'zh-CN' : 'en' }, isZh: mocks.isZh, setLocale: vi.fn() }),
}))

import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'
import { getTaskPeople, resolvePeople, searchPeople } from '../src/tasks/tasksApi'
import TaskPeoplePicker, { type TaskPeoplePicked, type TaskPeoplePickerMode } from '../src/tasks/TaskPeoplePicker.vue'
import { TASKS_EN, TASKS_ZH } from '../src/tasks/labels'

function jsonResponse(status: number, body: unknown): Response {
  return { status, json: async () => body } as unknown as Response
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const row = (id: string, name: string, detail: string, canUseTasks = true) => ({ id, name, detail, canUseTasks })

function searchBody(items: unknown[], hasMore = false): Record<string, unknown> {
  return { items, hasMore, requiresQuery: false, limit: 20 }
}

function urls(): string[] {
  return mocks.apiFetch.mock.calls.map(([url]) => String(url))
}

beforeEach(() => {
  mocks.apiFetch.mockReset()
  mocks.isZh.value = true
})

// ---------------------------------------------------------------------------------------------
// 1. The client
// ---------------------------------------------------------------------------------------------

describe('searchPeople', () => {
  it('sends the term encoded and reads a well-formed answer', async () => {
    mocks.apiFetch.mockResolvedValue(jsonResponse(200, searchBody([row('u1', '张三', 'zh***@example.test', false)], true)))
    const result = await searchPeople('张 三')
    expect(urls()).toEqual(['/api/tasks/people?q=%E5%BC%A0%20%E4%B8%89'])
    expect(result).toEqual({ kind: 'ok', items: [row('u1', '张三', 'zh***@example.test', false)], hasMore: true, requiresQuery: false })
  })

  it('the "type a name" marker reads as ok with requiresQuery', async () => {
    mocks.apiFetch.mockResolvedValue(jsonResponse(200, { items: [], hasMore: false, requiresQuery: true, limit: 20, minQueryLength: 1 }))
    expect(await searchPeople('')).toEqual({ kind: 'ok', items: [], hasMore: false, requiresQuery: true })
  })

  it('maps each failure to its own kind and never throws', async () => {
    const cases: Array<[Response | Error, unknown]> = [
      [jsonResponse(403, { error: 'Insufficient permissions' }), { kind: 'forbidden' }],
      [jsonResponse(429, { error: { code: 'RATE_LIMITED' } }), { kind: 'rate_limited' }],
      [jsonResponse(422, { error: { code: 'ORG_MISSING' } }), { kind: 'org_missing' }],
      [jsonResponse(422, { error: { code: 'PEOPLE_QUERY_INVALID' } }), { kind: 'error', status: 422 }],
      [jsonResponse(404, {}), { kind: 'error', status: 404 }],
      [jsonResponse(500, { error: { code: 'INTERNAL' } }), { kind: 'error', status: 500 }],
      [new TypeError('network down'), { kind: 'error', status: 0 }],
    ]
    for (const [reply, expected] of cases) {
      mocks.apiFetch.mockReset()
      if (reply instanceof Error) mocks.apiFetch.mockRejectedValue(reply)
      else mocks.apiFetch.mockResolvedValue(reply)
      expect(await searchPeople('x')).toEqual(expected)
    }
  })

  it('a 200 that is not the expected shape, or one malformed row, is an error', async () => {
    const bodies: unknown[] = [
      null,
      { id: 't1', title: 'a task body' },
      { items: 'x', hasMore: false, requiresQuery: false },
      searchBody([row('u1', 'A', ''), { id: 'u2', name: 'B' }]),
      searchBody([row('u1', 'A', ''), { id: 'u2', name: 'B', detail: '', canUseTasks: 'yes' }]),
      searchBody([row('..', 'A', '')]),
      { items: [], requiresQuery: false },
    ]
    for (const body of bodies) {
      mocks.apiFetch.mockReset().mockResolvedValue(jsonResponse(200, body))
      expect(await searchPeople('x'), JSON.stringify(body)).toEqual({ kind: 'error', status: 200 })
    }
  })
})

describe('resolvePeople', () => {
  it('sends only ids the member rule accepts, each once, at most 50', async () => {
    mocks.apiFetch.mockResolvedValue(jsonResponse(200, { items: [], truncated: false }))
    const many = Array.from({ length: 60 }, (_, i) => `u${i}`)
    await resolvePeople(['.', '..', '', 'a b', 'u0', ...many])
    const sent = new URL(urls()[0], 'http://localhost').searchParams.get('ids')!.split(',')
    expect(sent).toEqual(many.slice(0, 50))
  })

  it('with nothing to send, sends nothing and answers an empty ok', async () => {
    expect(await resolvePeople(['..', ''])).toEqual({ kind: 'ok', items: [], hasMore: false, requiresQuery: false, truncated: false })
    expect(mocks.apiFetch).not.toHaveBeenCalled()
  })

  it('reads items and truncated; an answer without truncated, or a task-shaped body, is an error', async () => {
    mocks.apiFetch.mockResolvedValue(jsonResponse(200, { items: [row('u1', 'A', 'a***@x')], truncated: true }))
    expect(await resolvePeople(['u1'])).toEqual({ kind: 'ok', items: [row('u1', 'A', 'a***@x')], hasMore: false, requiresQuery: false, truncated: true })
    mocks.apiFetch.mockReset().mockResolvedValue(jsonResponse(200, { items: [row('u1', 'A', '')] }))
    expect(await resolvePeople(['u1'])).toEqual({ kind: 'error', status: 200 })
    mocks.apiFetch.mockReset().mockResolvedValue(jsonResponse(200, { id: 'tsk_9', title: 'Alpha', assignees: [] }))
    expect(await resolvePeople(['u1'])).toEqual({ kind: 'error', status: 200 })
  })
})

describe('getTaskPeople', () => {
  it('refuses an id that is not path-safe before any request', async () => {
    expect(await getTaskPeople('..')).toEqual({ kind: 'not_found' })
    expect(await getTaskPeople('.')).toEqual({ kind: 'not_found' })
    expect(await getTaskPeople('')).toEqual({ kind: 'not_found' })
    expect(mocks.apiFetch).not.toHaveBeenCalled()
  })

  it('reads the people into a map keyed by user id, any id being only a key', async () => {
    mocks.apiFetch.mockResolvedValue({
      status: 200,
      json: async () => JSON.parse('{"people":{"u1":{"name":"张三","status":"active"},"__proto__":{"name":"","status":"inactive"}}}'),
    } as unknown as Response)
    const result = await getTaskPeople('t 1')
    expect(urls()).toEqual(['/api/tasks/t%201/people'])
    expect(result.kind).toBe('ok')
    const people = (result as { kind: 'ok'; people: Map<string, unknown> }).people
    expect([...people.entries()]).toEqual([
      ['u1', { name: '张三', status: 'active' }],
      ['__proto__', { name: '', status: 'inactive' }],
    ])
  })

  it('maps 403, 404, 500, a thrown call and a malformed answer to their kinds', async () => {
    const cases: Array<[Response | Error, unknown]> = [
      [jsonResponse(403, {}), { kind: 'forbidden' }],
      [jsonResponse(404, { error: { code: 'NOT_FOUND' } }), { kind: 'not_found' }],
      [jsonResponse(500, {}), { kind: 'error', status: 500 }],
      [new TypeError('network down'), { kind: 'error', status: 0 }],
      [jsonResponse(200, { people: [] }), { kind: 'error', status: 200 }],
      [jsonResponse(200, { people: { u1: { name: 'A', status: 'gone' } } }), { kind: 'error', status: 200 }],
      [jsonResponse(200, { items: [] }), { kind: 'error', status: 200 }],
    ]
    for (const [reply, expected] of cases) {
      mocks.apiFetch.mockReset()
      if (reply instanceof Error) mocks.apiFetch.mockRejectedValue(reply)
      else mocks.apiFetch.mockResolvedValue(reply)
      expect(await getTaskPeople('t1')).toEqual(expected)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// 2. The component
// ---------------------------------------------------------------------------------------------

let app: VueApp<Element> | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
})

async function flush(cycles = 8): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function pause(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 350))
  await flush()
}

function mountPicker(mode: TaskPeoplePickerMode, opts: { beforeRequest?: () => boolean } = {}) {
  const confirmed: TaskPeoplePicked[] = []
  const closed = { count: 0 }
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    render: () => h(TaskPeoplePicker, {
      visible: true,
      mode,
      ...(opts.beforeRequest ? { beforeRequest: opts.beforeRequest } : {}),
      onConfirm: (picked: TaskPeoplePicked) => confirmed.push(picked),
      onClose: () => { closed.count += 1 },
    }),
  })
  app.mount(container)
  return { el: container, confirmed, closed }
}

const q = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-testid="task-people-picker-${id}"]`)
const rows = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>('[data-testid="task-people-picker-row"]'))

function type(el: HTMLElement, value: string): void {
  const input = q(el, 'search') as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input'))
}

function tick(el: HTMLElement, id: string): void {
  el.querySelector<HTMLInputElement>(`[data-person-id="${id}"] input[type="checkbox"]`)!.click()
}

describe('TaskPeoplePicker', () => {
  it('opens with the "type a name" hint, never "no one matches", and a blank term sends nothing', async () => {
    const { el } = mountPicker('assignee')
    await flush()
    expect(q(el, 'type-hint')!.textContent).toBe(TASKS_ZH.peopleTypeToSearch)
    expect(q(el, 'empty')).toBeNull()
    type(el, '   ')
    await pause()
    expect(mocks.apiFetch).not.toHaveBeenCalled()
    expect(q(el, 'type-hint')).not.toBeNull()
  })

  it('one character is searched after the pause; two keystrokes inside the pause send one request', async () => {
    mocks.apiFetch.mockResolvedValue(jsonResponse(200, searchBody([row('u1', '张三', 'zh***@example.test')])))
    const { el } = mountPicker('assignee')
    await flush()
    type(el, '张')
    await flush()
    expect(mocks.apiFetch).not.toHaveBeenCalled()
    await pause()
    expect(urls()).toEqual([`/api/tasks/people?q=${encodeURIComponent('张')}`])
    type(el, '张三')
    type(el, '张三丰')
    await pause()
    expect(urls()).toEqual([`/api/tasks/people?q=${encodeURIComponent('张')}`, `/api/tasks/people?q=${encodeURIComponent('张三丰')}`])
  })

  it('an answer to an older term is dropped', async () => {
    const first = deferred<Response>()
    mocks.apiFetch
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async () => jsonResponse(200, searchBody([row('u2', '李四', '')])))
    const { el } = mountPicker('assignee')
    await flush()
    type(el, '张')
    await pause()
    type(el, '李')
    await pause()
    first.resolve(jsonResponse(200, searchBody([row('u1', '张三', '')])))
    await flush()
    expect(rows(el).map((entry) => entry.dataset.personId)).toEqual(['u2'])
  })

  it('a row shows the name (the id without one), the detail (the id without one), and the id after the detail when two rows read the same', async () => {
    mocks.apiFetch.mockResolvedValue(jsonResponse(200, searchBody([
      row('u1', '张三', 'zh***@example.test'),
      row('u2', '张三', 'zh***@example.test'),
      row('u3', '', ''),
      row('u4', '张伟', 'zw***@example.test'),
    ])))
    const { el } = mountPicker('assignee')
    await flush()
    type(el, '张')
    await pause()
    const texts = rows(el).map((entry) => [
      entry.querySelector('[data-testid="task-people-picker-name"]')!.textContent,
      entry.querySelector('[data-testid="task-people-picker-detail"]')!.textContent,
    ])
    expect(texts).toEqual([
      ['张三', 'zh***@example.test · u1'],
      ['张三', 'zh***@example.test · u2'],
      ['u3', 'u3'],
      ['张伟', 'zw***@example.test'],
    ])
  })

  it('more matches than shown: the narrow-your-search hint; nobody: the no-match copy', async () => {
    mocks.apiFetch.mockResolvedValueOnce(jsonResponse(200, searchBody([row('u1', '张三', '')], true)))
    mocks.apiFetch.mockResolvedValueOnce(jsonResponse(200, searchBody([])))
    const { el } = mountPicker('assignee')
    await flush()
    type(el, '张')
    await pause()
    expect(q(el, 'more')!.textContent).toBe(TASKS_ZH.peopleRefineSearch)
    type(el, '张无')
    await pause()
    expect(q(el, 'empty')!.textContent).toBe(TASKS_ZH.peopleNoMatch)
    expect(q(el, 'more')).toBeNull()
  })

  const failures: Array<[string, () => Response | Promise<Response>, string]> = [
    ['no org', () => jsonResponse(422, { error: { code: 'ORG_MISSING' } }), TASKS_ZH.orgMissing],
    ['a 403', () => jsonResponse(403, { error: 'Insufficient permissions' }), TASKS_ZH.actionForbidden],
    ['a 429', () => jsonResponse(429, { error: { code: 'RATE_LIMITED' } }), TASKS_ZH.peopleRateLimited],
    ['a 500', () => jsonResponse(500, {}), TASKS_ZH.peopleLoadFailed],
    ['a malformed row', () => jsonResponse(200, searchBody([row('u1', '张三', ''), { id: 'u2' }])), TASKS_ZH.peopleLoadFailed],
    ['a row whose id the member rule refuses', () => jsonResponse(200, searchBody([row('..', '张三', '')])), TASKS_ZH.peopleLoadFailed],
    ['a transport failure', () => Promise.reject(new TypeError('network down')), TASKS_ZH.peopleLoadFailed],
  ]
  for (const [name, reply, copy] of failures) {
    it(`${name}: its own copy, and no rows`, async () => {
      mocks.apiFetch.mockImplementation(reply)
      const { el } = mountPicker('assignee')
      await flush()
      type(el, '张')
      await pause()
      expect(q(el, 'error')!.textContent).toBe(copy)
      expect(q(el, 'error')!.getAttribute('role')).toBe('alert')
      expect(rows(el)).toEqual([])
    })
  }

  it('assignee mode: someone who cannot use tasks yet is marked, cannot be ticked, and confirm hands back only the ticked ids', async () => {
    mocks.apiFetch.mockResolvedValue(jsonResponse(200, searchBody([
      row('u1', '张三', 'zh***@example.test', false),
      row('u2', '张伟', 'zw***@example.test'),
      row('u3', '张亮', 'zl***@example.test'),
    ])))
    const { el, confirmed } = mountPicker('assignee')
    await flush()
    type(el, '张')
    await pause()
    const blocked = el.querySelector<HTMLElement>('[data-person-id="u1"]')!
    expect(blocked.querySelector('[data-testid="task-people-picker-no-access"]')!.textContent).toBe(TASKS_ZH.peopleCannotUseTasks)
    expect(blocked.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true)
    expect((q(el, 'confirm') as HTMLButtonElement).disabled).toBe(true)
    tick(el, 'u1')
    tick(el, 'u3')
    tick(el, 'u2')
    await flush()
    ;(q(el, 'confirm') as HTMLButtonElement).click()
    await flush()
    expect(confirmed).toEqual([{ ids: ['u3', 'u2'], names: { u3: '张亮', u2: '张伟' } }])
  })

  it('follower mode: the same person is marked and can be ticked', async () => {
    mocks.apiFetch.mockResolvedValue(jsonResponse(200, searchBody([row('u1', '张三', 'zh***@example.test', false)])))
    const { el, confirmed } = mountPicker('follower')
    await flush()
    type(el, '张')
    await pause()
    expect(el.querySelector('[data-testid="task-people-picker-no-access"]')).not.toBeNull()
    tick(el, 'u1')
    await flush()
    ;(q(el, 'confirm') as HTMLButtonElement).click()
    await flush()
    expect(confirmed).toEqual([{ ids: ['u1'], names: { u1: '张三' } }])
  })

  it('unticking removes a person again; cancel and Esc close without confirming', async () => {
    mocks.apiFetch.mockResolvedValue(jsonResponse(200, searchBody([row('u2', '张伟', '')])))
    const { el, confirmed, closed } = mountPicker('assignee')
    await flush()
    type(el, '张')
    await pause()
    tick(el, 'u2')
    await flush()
    expect(q(el, 'count')!.textContent).toBe(`${TASKS_ZH.peopleSelectedLabel}1`)
    tick(el, 'u2')
    await flush()
    expect(q(el, 'count')!.textContent).toBe(`${TASKS_ZH.peopleSelectedLabel}0`)
    ;(q(el, 'cancel') as HTMLButtonElement).click()
    q(el, 'search')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flush()
    expect(closed.count).toBe(2)
    expect(confirmed).toEqual([])
  })

  it('in the millisecond the picker opens: Esc stops at the picker from the box and its buttons, Enter is held back in the box only, typing is untouched', async () => {
    // Vue stamps an event at the first of its listeners it reaches and skips any later one attached
    // in that millisecond; with the clock held there, a second listener inside the picker would let
    // the Esc through.
    const opened = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(opened)
    try {
      await flush()
      const { el, closed, confirmed } = mountPicker('assignee')
      const reachedParent: string[] = []
      el.addEventListener('keydown', (event) => { reachedParent.push(event.key) })
      const press = (id: string, key: string) => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
        q(el, id)!.dispatchEvent(event)
        return event
      }
      // Typing in the search box is left alone; Enter there is held back but still bubbles.
      expect(press('search', 'a').defaultPrevented).toBe(false)
      expect(press('search', 'Enter').defaultPrevented).toBe(true)
      // Enter on the picker's own buttons is left to them.
      expect(press('confirm', 'Enter').defaultPrevented).toBe(false)
      expect(press('cancel', 'Enter').defaultPrevented).toBe(false)
      // Esc from the box or a button closes the picker and goes no further.
      expect(press('search', 'Escape').defaultPrevented).toBe(true)
      expect(press('cancel', 'Escape').defaultPrevented).toBe(true)
      await flush()
      expect(closed.count).toBe(2)
      expect(reachedParent).toEqual(['a', 'Enter', 'Enter', 'Enter'])
      expect(confirmed).toEqual([])
    } finally {
      now.mockRestore()
    }
  })

  it('Tab and Shift+Tab stay inside the picker: the picker moves every one, wraps at the ends, skips the disabled confirm and no listener around it sees them', async () => {
    const { el } = mountPicker('assignee')
    await flush()
    const reachedParent: string[] = []
    el.addEventListener('keydown', (event) => { reachedParent.push(event.key) })
    const panel = el.querySelector<HTMLElement>('[data-testid="task-people-picker"]')!
    const tab = (from: HTMLElement, shiftKey = false) => {
      from.focus()
      expect(document.activeElement).toBe(from)
      const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
      from.dispatchEvent(event)
      return event
    }
    // Nothing is ticked, so confirm is disabled and cancel is the last control.
    expect((q(el, 'confirm') as HTMLButtonElement).disabled).toBe(true)
    expect(tab(q(el, 'cancel')!).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(q(el, 'search'))
    expect(tab(q(el, 'search')!, true).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(q(el, 'cancel'))
    expect(tab(panel).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(q(el, 'search'))
    // A Tab between the ends is moved by the picker too (macOS Safari would skip the buttons).
    expect(tab(q(el, 'search')!).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(q(el, 'cancel'))
    expect(reachedParent).toEqual([])
  })

  it('a Tab the input method took (keyCode 229) is left to it; a Tab during a composition it did not take is moved as usual', async () => {
    const { el } = mountPicker('assignee')
    await flush()
    const search = q(el, 'search')!
    search.focus()
    // keyCode 229: the input method took the key (Safari's key that ends a composition also has
    // isComposing false). Not moved, not held.
    for (const init of [{ keyCode: 229, isComposing: true }, { keyCode: 229 }, { keyCode: 229, shiftKey: true }]) {
      const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true, ...init })
      search.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
      expect(document.activeElement).toBe(search)
    }
    // A composition is active but the input method passed the key on (Chromium: isComposing true,
    // keyCode 9): the browser would move focus anyway, so the picker moves it, inside the picker.
    const passedOn = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true, isComposing: true, keyCode: 9 })
    search.dispatchEvent(passedOn)
    expect(passedOn.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(q(el, 'cancel'))
  })

  it('with a person ticked, Tab from the confirm wraps to the box and Shift+Tab from the box lands on the confirm', async () => {
    mocks.apiFetch.mockResolvedValue(jsonResponse(200, searchBody([row('u1', '张三', '')])))
    const { el } = mountPicker('assignee')
    await flush()
    type(el, '张')
    await pause()
    tick(el, 'u1')
    await flush()
    const reachedParent: string[] = []
    el.addEventListener('keydown', (event) => { reachedParent.push(event.key) })
    const tab = (from: HTMLElement, shiftKey = false) => {
      from.focus()
      expect(document.activeElement).toBe(from)
      const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
      from.dispatchEvent(event)
      return event
    }
    expect(tab(q(el, 'confirm')!).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(q(el, 'search'))
    expect(tab(q(el, 'search')!, true).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(q(el, 'confirm'))
    const check = el.querySelector<HTMLElement>('[data-person-id="u1"] input[type="checkbox"]')!
    expect(tab(q(el, 'search')!).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(check)
    expect(tab(check).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(q(el, 'cancel'))
    // A control hidden after it was drawn is skipped.
    check.closest('li')!.hidden = true
    expect(tab(q(el, 'search')!).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(q(el, 'cancel'))
    expect(reachedParent).toEqual([])
  })

  it('assignee mode: Tab and Shift+Tab step over the disabled checkbox of someone who cannot use tasks yet', async () => {
    mocks.apiFetch.mockResolvedValue(jsonResponse(200, searchBody([row('u1', '张三', '', false), row('u2', '张伟', '')])))
    const { el } = mountPicker('assignee')
    await flush()
    type(el, '张')
    await pause()
    const blocked = el.querySelector<HTMLInputElement>('[data-person-id="u1"] input[type="checkbox"]')!
    const usable = el.querySelector<HTMLInputElement>('[data-person-id="u2"] input[type="checkbox"]')!
    expect(blocked.disabled).toBe(true)
    expect(usable.disabled).toBe(false)
    const reachedParent: string[] = []
    el.addEventListener('keydown', (event) => { reachedParent.push(event.key) })
    const tab = (from: HTMLElement, shiftKey = false) => {
      from.focus()
      expect(document.activeElement).toBe(from)
      const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
      from.dispatchEvent(event)
      return event
    }
    expect(tab(q(el, 'search')!).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(usable)
    expect(tab(usable, true).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(q(el, 'search'))
    expect(reachedParent).toEqual([])
  })

  it('Shift+Tab from a middle control moves to the one before it, and Shift+Tab from the panel itself lands on the last control', async () => {
    mocks.apiFetch.mockResolvedValue(jsonResponse(200, searchBody([row('u1', '张三', '')])))
    const { el } = mountPicker('assignee')
    await flush()
    type(el, '张')
    await pause()
    tick(el, 'u1')
    await flush()
    const reachedParent: string[] = []
    el.addEventListener('keydown', (event) => { reachedParent.push(event.key) })
    const panel = el.querySelector<HTMLElement>('[data-testid="task-people-picker"]')!
    const shiftTab = (from: HTMLElement) => {
      from.focus()
      expect(document.activeElement).toBe(from)
      const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
      from.dispatchEvent(event)
      return event
    }
    // Search, the checkbox, cancel and confirm: cancel is neither end.
    expect(shiftTab(q(el, 'cancel')!).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(el.querySelector('[data-person-id="u1"] input[type="checkbox"]'))
    // The panel takes focus when its title or count is clicked; Shift+Tab from there stays inside.
    expect(shiftTab(panel).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(q(el, 'confirm'))
    expect(reachedParent).toEqual([])
  })

  /** The picker under a parent that opens it from a button, optionally inside a dialog of its own. */
  function mountWithOpener() {
    const open = ref(false)
    const openerDisabled = ref(false)
    const openerShown = ref(true)
    const pickerShown = ref(true)
    const dialogShown = ref(true)
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({
      render: () => (dialogShown.value
        ? h('div', { role: 'dialog', tabindex: '-1', 'data-testid': 'outer-dialog' }, [
          openerShown.value
            ? h('button', { type: 'button', 'data-testid': 'opener', disabled: openerDisabled.value, onClick: () => { open.value = true } }, 'pick')
            : null,
          h('button', { type: 'button', 'data-testid': 'elsewhere' }, 'other'),
          pickerShown.value ? h(TaskPeoplePicker, { visible: open.value, mode: 'assignee', onClose: () => { open.value = false } }) : null,
        ])
        // A control of the page stays when the dialog is gone; the picker must not take focus to it.
        : h('button', { type: 'button', 'data-testid': 'page-control' }, 'page')),
    })
    app.mount(container)
    const el = container
    const opener = () => el.querySelector<HTMLButtonElement>('[data-testid="opener"]')
    const openFromButton = async () => {
      opener()!.focus()
      opener()!.click()
      await flush()
      expect(document.activeElement).toBe(q(el, 'search'))
    }
    return { el, open, openerDisabled, openerShown, pickerShown, dialogShown, opener, openFromButton }
  }

  it('closing hands focus back to the opener; an opener disabled meanwhile hands it to the dialog around it', async () => {
    const { el, openerDisabled, opener, openFromButton } = mountWithOpener()
    await flush()
    await openFromButton()
    ;(q(el, 'cancel') as HTMLButtonElement).click()
    await flush()
    expect(q(el, 'search')).toBeNull()
    expect(document.activeElement).toBe(opener())
    await openFromButton()
    openerDisabled.value = true
    await flush()
    q(el, 'search')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flush()
    expect(q(el, 'search')).toBeNull()
    expect(document.activeElement).toBe(el.querySelector('[data-testid="outer-dialog"]'))
  })

  it('a click on the overlay keeps focus in the picker on mousedown, closes it, and hands focus back to the opener', async () => {
    const { el, opener, openFromButton } = mountWithOpener()
    await flush()
    await openFromButton()
    const overlay = el.querySelector<HTMLElement>('.task-people-picker__overlay')!
    const mousedown = (on: HTMLElement) => {
      const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
      on.dispatchEvent(event)
      return event
    }
    // Held back on the overlay itself only; a mousedown inside the panel is left alone.
    expect(mousedown(q(el, 'search')!).defaultPrevented).toBe(false)
    expect(mousedown(overlay).defaultPrevented).toBe(true)
    overlay.click()
    await flush()
    expect(q(el, 'search')).toBeNull()
    expect(document.activeElement).toBe(opener())
  })

  it('the parent removing the open picker hands focus back to the opener as well', async () => {
    const { el, pickerShown, opener, openFromButton } = mountWithOpener()
    await flush()
    await openFromButton()
    pickerShown.value = false
    await flush()
    expect(q(el, 'search')).toBeNull()
    expect(document.activeElement).toBe(opener())
  })

  it('the picker moves no focus on close when focus has gone elsewhere; an opener gone from the page hands it to the dialog it was in', async () => {
    const { el, open, openerShown, openFromButton } = mountWithOpener()
    await flush()
    await openFromButton()
    // The parent closes the picker and puts focus on another control of its own.
    const elsewhere = el.querySelector<HTMLElement>('[data-testid="elsewhere"]')!
    elsewhere.focus()
    open.value = false
    await flush()
    expect(q(el, 'search')).toBeNull()
    expect(document.activeElement).toBe(elsewhere)
    await openFromButton()
    // The dialog around the opener turns to another view without it (the dispatch dialog's refusal).
    openerShown.value = false
    await flush()
    ;(q(el, 'cancel') as HTMLButtonElement).click()
    await flush()
    expect(q(el, 'search')).toBeNull()
    expect(document.activeElement).toBe(el.querySelector('[data-testid="outer-dialog"]'))
  })

  it('the picker moves no focus when the opener and the dialog it was in are both gone (the whole dialog closing)', async () => {
    const { el, dialogShown, openFromButton } = mountWithOpener()
    await flush()
    await openFromButton()
    dialogShown.value = false
    await flush()
    expect(q(el, 'search')).toBeNull()
    expect(el.querySelector('[data-testid="outer-dialog"]')).toBeNull()
    expect(el.querySelector('[data-testid="page-control"]')).not.toBeNull()
    expect(document.activeElement).toBe(document.body)
  })

  it('beforeRequest saying no: nothing is sent', async () => {
    const { el } = mountPicker('assignee', { beforeRequest: () => false })
    await flush()
    type(el, '张')
    await pause()
    expect(mocks.apiFetch).not.toHaveBeenCalled()
  })

  it('in English: no CJK in the chrome, the hint, the mark or the copy', async () => {
    mocks.isZh.value = false
    mocks.apiFetch.mockResolvedValue(jsonResponse(200, searchBody([row('u1', 'Ann', 'an***@example.test', false)], true)))
    const { el } = mountPicker('assignee')
    await flush()
    const cjk = /[　-鿿＀-￯]/
    expect(cjk.test(el.textContent ?? '')).toBe(false)
    type(el, 'A')
    await pause()
    expect(el.querySelector('[data-testid="task-people-picker-no-access"]')!.textContent).toBe(TASKS_EN.peopleCannotUseTasks)
    expect(cjk.test(el.textContent ?? '')).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// 3. Account switches
// ---------------------------------------------------------------------------------------------

/** A JWT-shaped token the app's own payload reader understands (header and signature are not read). */
function fakeToken(payload: Record<string, unknown>): string {
  return `h.${btoa(JSON.stringify(payload)).replace(/=+$/, '')}.s`
}
const TOKEN_A = fakeToken({ sub: 'usr_a', exp: 4102444800 })
const TOKEN_A_REFRESHED = fakeToken({ sub: 'usr_a', exp: 4102448400 })
const TOKEN_B = fakeToken({ sub: 'usr_b', exp: 4102444800 })

function signIn(token: string): void {
  localStorage.setItem('auth_token', token)
}

/** Another tab signs in: the shared storage changes and this tab is told nothing. */
function signInSilently(token: string): void {
  signIn(token)
}

/** The same, plus the `storage` event a browser delivers to the other tabs. */
function signInElsewhereWithEvent(token: string): void {
  signIn(token)
  window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token', newValue: token }))
}

describe('TaskPeoplePicker — account switches', () => {
  beforeEach(() => {
    localStorage.removeItem('auth_token')
    signIn(TOKEN_A)
  })

  afterEach(() => {
    localStorage.removeItem('auth_token')
  })

  it('a search started under one account whose answer lands after a silent switch to another is not shown', async () => {
    const late = deferred<Response>()
    mocks.apiFetch.mockImplementationOnce(() => late.promise)
    const { el } = mountPicker('assignee')
    await flush()
    type(el, '张')
    await pause()
    expect(q(el, 'loading')).not.toBeNull()
    signInSilently(TOKEN_B)
    late.resolve(jsonResponse(200, searchBody([row('u1', '张三', 'zh***@example.test')])))
    await flush()
    expect(rows(el)).toEqual([])
    expect(el.textContent).not.toContain('张三')
    expect(el.textContent).not.toContain('zh***@example.test')
    expect(q(el, 'type-hint')).not.toBeNull()
    expect((q(el, 'search') as HTMLInputElement).value).toBe('')
  })

  for (const [how, switchTo] of [
    ['another tab (a storage change)', (token: string) => signInElsewhereWithEvent(token)],
    ['this tab (a session switch)', (token: string) => { signIn(token); notifyAuthPrincipalChange() }],
  ] as Array<[string, (token: string) => void]>) {
    it(`a switch seen while open, from ${how}: rows, ticks and the pending search are cleared`, async () => {
      mocks.apiFetch.mockResolvedValue(jsonResponse(200, searchBody([row('u1', '张三', 'zh***@example.test')])))
      const { el, confirmed } = mountPicker('assignee')
      await flush()
      type(el, '张')
      await pause()
      tick(el, 'u1')
      await flush()
      expect(q(el, 'count')!.textContent).toBe(`${TASKS_ZH.peopleSelectedLabel}1`)
      type(el, '张三')
      switchTo(TOKEN_B)
      await flush()
      expect(rows(el)).toEqual([])
      expect(el.textContent).not.toContain('zh***@example.test')
      expect(q(el, 'count')!.textContent).toBe(`${TASKS_ZH.peopleSelectedLabel}0`)
      expect((q(el, 'confirm') as HTMLButtonElement).disabled).toBe(true)
      await pause()
      expect(urls()).toEqual([`/api/tasks/people?q=${encodeURIComponent('张')}`])
      ;(q(el, 'confirm') as HTMLButtonElement).click()
      await flush()
      expect(confirmed).toEqual([])
    })

    it(`a search started before a switch seen from ${how} whose answer lands after it is not shown`, async () => {
      const late = deferred<Response>()
      mocks.apiFetch.mockImplementationOnce(() => late.promise)
      const { el } = mountPicker('assignee')
      await flush()
      type(el, '张')
      await pause()
      expect(q(el, 'loading')).not.toBeNull()
      switchTo(TOKEN_B)
      await flush()
      late.resolve(jsonResponse(200, searchBody([row('u1', '张三', 'zh***@example.test')])))
      await flush()
      expect(rows(el)).toEqual([])
      expect(el.textContent).not.toContain('张三')
      expect(el.textContent).not.toContain('zh***@example.test')
      expect(q(el, 'type-hint')).not.toBeNull()
    })
  }

  it('a search whose pause ends after a silent switch to another account is not sent', async () => {
    mocks.apiFetch.mockResolvedValue(jsonResponse(200, searchBody([row('u1', '张三', 'zh***@example.test')])))
    const { el } = mountPicker('assignee')
    await flush()
    type(el, '张')
    await flush()
    signInSilently(TOKEN_B)
    await pause()
    expect(mocks.apiFetch).not.toHaveBeenCalled()
    expect(rows(el)).toEqual([])
    expect((q(el, 'search') as HTMLInputElement).value).toBe('')
  })

  it('ticks made under one account are not handed back by a confirm after a silent switch to another', async () => {
    mocks.apiFetch.mockResolvedValue(jsonResponse(200, searchBody([row('u1', '张三', 'zh***@example.test')])))
    const { el, confirmed } = mountPicker('assignee')
    await flush()
    type(el, '张')
    await pause()
    tick(el, 'u1')
    await flush()
    expect((q(el, 'confirm') as HTMLButtonElement).disabled).toBe(false)
    signInSilently(TOKEN_B)
    ;(q(el, 'confirm') as HTMLButtonElement).click()
    await flush()
    expect(confirmed).toEqual([])
    expect(rows(el)).toEqual([])
    expect(q(el, 'count')!.textContent).toBe(`${TASKS_ZH.peopleSelectedLabel}0`)
  })

  it('a switch to another org for the same person, seen from another tab, clears the rows and the ticks', async () => {
    signIn(fakeToken({ sub: 'usr_a', tenantId: 'org_1', exp: 4102444800 }))
    mocks.apiFetch.mockResolvedValue(jsonResponse(200, searchBody([row('u1', '张三', 'zh***@example.test')])))
    const { el, confirmed } = mountPicker('assignee')
    await flush()
    type(el, '张')
    await pause()
    tick(el, 'u1')
    await flush()
    expect(q(el, 'count')!.textContent).toBe(`${TASKS_ZH.peopleSelectedLabel}1`)
    signInElsewhereWithEvent(fakeToken({ sub: 'usr_a', tenantId: 'org_2', exp: 4102444800 }))
    await flush()
    expect(rows(el)).toEqual([])
    expect(el.textContent).not.toContain('zh***@example.test')
    expect(q(el, 'count')!.textContent).toBe(`${TASKS_ZH.peopleSelectedLabel}0`)
    ;(q(el, 'confirm') as HTMLButtonElement).click()
    await flush()
    expect(confirmed).toEqual([])
  })

  it('negative control: a token refresh for the same person keeps the rows and the ticks, and the next search is sent', async () => {
    mocks.apiFetch.mockResolvedValue(jsonResponse(200, searchBody([row('u1', '张三', 'zh***@example.test')])))
    const { el, confirmed } = mountPicker('assignee')
    await flush()
    type(el, '张')
    await pause()
    tick(el, 'u1')
    await flush()
    signInElsewhereWithEvent(TOKEN_A_REFRESHED)
    notifyAuthPrincipalChange()
    await flush()
    expect(rows(el).map((entry) => entry.dataset.personId)).toEqual(['u1'])
    expect(q(el, 'count')!.textContent).toBe(`${TASKS_ZH.peopleSelectedLabel}1`)
    ;(q(el, 'confirm') as HTMLButtonElement).click()
    await flush()
    expect(confirmed).toEqual([{ ids: ['u1'], names: { u1: '张三' } }])
    type(el, '张三')
    await pause()
    expect(urls()).toEqual([`/api/tasks/people?q=${encodeURIComponent('张')}`, `/api/tasks/people?q=${encodeURIComponent('张三')}`])
    expect(rows(el).map((entry) => entry.dataset.personId)).toEqual(['u1'])
  })

  it('negative control: signed in and not switching, a search shows its rows and beforeRequest is asked once', async () => {
    mocks.apiFetch.mockResolvedValue(jsonResponse(200, searchBody([row('u1', '张三', 'zh***@example.test'), row('u2', '张伟', '')])))
    const asked = { count: 0 }
    const { el } = mountPicker('follower', { beforeRequest: () => { asked.count += 1; return true } })
    await flush()
    type(el, '张')
    await pause()
    expect(asked.count).toBe(1)
    expect(rows(el).map((entry) => entry.dataset.personId)).toEqual(['u1', 'u2'])
    expect(q(el, 'detail')!.textContent).toBe('zh***@example.test')
  })
})

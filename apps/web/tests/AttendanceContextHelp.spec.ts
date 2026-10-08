// W5-2 (Wave 5 explainability design-lock, RATIFIED §6/§9 W5-2): mounted render matrix for
// AttendanceContextHelp.vue — real DOM rendering of the closed-set entries per context, zh + en
// legs, the R1 zero-write shape (the ONLY interactive element anywhere in this tree is the
// read-only evidence-link `<a>`), and the evidence-link click contract (real DOM click ->
// `evidence-link-click` emit, exact payload, no page navigation performed by the component itself).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App } from 'vue'
import AttendanceContextHelp from '../src/views/attendance/AttendanceContextHelp.vue'
import {
  ATTENDANCE_CONTEXT_HELP_CONTEXTS,
  getAttendanceContextHelpEntries,
  type AttendanceContextHelpContextId,
  type AttendanceContextHelpEvidenceLink,
  type TranslateFn,
} from '../src/views/attendance/attendanceContextHelp'

const trZh: TranslateFn = (_en, zh) => zh
const trEn: TranslateFn = (en, _zh) => en

let app: App<Element> | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  if (app) {
    app.unmount()
    app = null
  }
  container?.remove()
  container = null
})

function mountHelp(
  contextId: AttendanceContextHelpContextId,
  tr: TranslateFn = trZh,
  onEvidenceLinkClick?: (link: AttendanceContextHelpEvidenceLink) => void,
): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(AttendanceContextHelp, {
    tr,
    contextId,
    ...(onEvidenceLinkClick ? { onEvidenceLinkClick } : {}),
  })
  app.mount(container)
  return container
}

describe('AttendanceContextHelp — mount + context-id root attribute', () => {
  for (const contextId of ATTENDANCE_CONTEXT_HELP_CONTEXTS) {
    it(`mounts for context '${contextId}' with the exact context-id root attribute`, () => {
      const root = mountHelp(contextId)
      const el = root.querySelector('[data-attendance-context-help]')
      expect(el).not.toBeNull()
      expect(el!.getAttribute('data-context-help-context')).toBe(contextId)
    })
  }
})

describe('AttendanceContextHelp — entry render matrix (zh + en legs)', () => {
  for (const contextId of ATTENDANCE_CONTEXT_HELP_CONTEXTS) {
    for (const [legName, tr] of [['zh', trZh], ['en', trEn]] as const) {
      it(`context '${contextId}' (${legName} leg): renders exactly the pure-module entries — category set, titles, body lines`, () => {
        const expected = getAttendanceContextHelpEntries(contextId, tr)
        const root = mountHelp(contextId, tr)
        const entryEls = Array.from(root.querySelectorAll('[data-context-help-entry]'))
        expect(entryEls.map((el) => el.getAttribute('data-context-help-category'))).toEqual(
          expected.map((entry) => entry.category),
        )
        entryEls.forEach((el, index) => {
          const entry = expected[index]
          expect(el.querySelector('.context-help__title')?.textContent?.trim()).toBe(entry.title)
          const lines = Array.from(el.querySelectorAll('.context-help__body li')).map((li) => li.textContent?.trim())
          expect(lines).toEqual(entry.body)
        })
      })
    }
  }
})

describe("AttendanceContextHelp — 'self-request-center' evidence-link (category ④)", () => {
  it('renders the `<a>` with the exact href, zero hash, and the exact translated label', () => {
    const root = mountHelp('self-request-center', trZh)
    const anchor = root.querySelector<HTMLAnchorElement>('[data-context-help-evidence-link]')
    expect(anchor).not.toBeNull()
    expect(anchor!.getAttribute('href')).toBe('/attendance?section=attendance-overview-decision-trace')
    expect(anchor!.getAttribute('href')!.includes('#')).toBe(false)
    expect(anchor!.textContent?.trim()).toBe('查看依据（决策轨迹）')
  })

  it('en leg renders the en label (locale-routed, not hardcoded zh)', () => {
    const root = mountHelp('self-request-center', trEn)
    const anchor = root.querySelector<HTMLAnchorElement>('[data-context-help-evidence-link]')
    expect(anchor!.textContent?.trim()).toBe('View basis (decision trace)')
  })

  it('clicking the anchor emits evidence-link-click with the EXACT link payload (deepEqual) and does not itself navigate', () => {
    const onEvidenceLinkClick = vi.fn()
    const root = mountHelp('self-request-center', trZh, onEvidenceLinkClick)
    const anchor = root.querySelector<HTMLAnchorElement>('[data-context-help-evidence-link]')!
    const locationBefore = window.location.href
    anchor.click()
    expect(onEvidenceLinkClick).toHaveBeenCalledTimes(1)
    expect(onEvidenceLinkClick).toHaveBeenCalledWith({
      href: '/attendance?section=attendance-overview-decision-trace',
      label: '查看依据（决策轨迹）',
      presetCategory: 'missing_punch',
    })
    // click.prevent — the component's own DOM click never performs a page navigation.
    expect(window.location.href).toBe(locationBefore)
  })
})

describe("AttendanceContextHelp — non-evidence-link contexts render ZERO anchors/buttons", () => {
  it("'setup-wizard' and 'import' contexts carry no evidence_link category, hence no `<a>`/`<button>` anywhere in the tree", () => {
    for (const contextId of ['setup-wizard', 'import'] as const) {
      const root = mountHelp(contextId)
      expect(root.querySelectorAll('a').length).toBe(0)
      expect(root.querySelectorAll('button').length).toBe(0)
    }
  })
})

describe('AttendanceContextHelp — R1 zero-write shape', () => {
  it('the ENTIRE rendered tree contains zero <button>, zero <form>, zero <input> — the only interactive element anywhere is the read-only evidence-link <a>', () => {
    for (const contextId of ATTENDANCE_CONTEXT_HELP_CONTEXTS) {
      const root = mountHelp(contextId)
      expect(root.querySelectorAll('button').length).toBe(0)
      expect(root.querySelectorAll('form').length).toBe(0)
      expect(root.querySelectorAll('input').length).toBe(0)
      // Any anchors present must be the evidence-link door — never anything else.
      const anchors = Array.from(root.querySelectorAll('a'))
      for (const anchor of anchors) {
        expect(anchor.hasAttribute('data-context-help-evidence-link')).toBe(true)
      }
    }
  })
})

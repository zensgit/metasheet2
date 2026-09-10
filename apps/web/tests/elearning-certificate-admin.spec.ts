import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { useLocale } from '../src/composables/useLocale'

const h = vi.hoisted(() => ({
  issue: vi.fn(),
  list: vi.fn(),
  publish: vi.fn(),
}))

vi.mock('../src/services/elearningCertificate', async () => {
  const actual = await vi.importActual<typeof import('../src/services/elearningCertificate')>(
    '../src/services/elearningCertificate',
  )
  return {
    ...actual,
    issueElearningCertificate: h.issue,
    listElearningCertificateTemplates: h.list,
    publishElearningCertificateTemplate: h.publish,
  }
})

import { ElearningApiError } from '../src/services/elearning'
import ElearningCertificateAdminSection from '../src/views/ElearningCertificateAdminSection.vue'

const REQUEST_A = '11111111-1111-4111-8111-111111111111'
const REQUEST_B = '22222222-2222-4222-8222-222222222222'
const REQUEST_C = '33333333-3333-4333-8333-333333333333'
const REVISION = '44444444-4444-4444-8444-444444444444'
const ISSUE = '55555555-5555-4555-8555-555555555555'
const SERIAL = '66666666-6666-4666-8666-666666666666'

async function flushUi(cycles = 10): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function template(over: Record<string, unknown> = {}) {
  return {
    certificateId: 'course-completion',
    revisionId: REVISION,
    version: 1,
    name: 'Course completion',
    templateText: '#learnerName# completed #courseName#',
    backgroundImageUrl: null,
    placeholders: ['learnerName', 'courseName'],
    createdAt: '2026-08-30T04:00:00.000Z',
    ...over,
  }
}

function fill(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('ElearningCertificateAdminSection', () => {
  let app: VueApp<Element> | null = null
  let root: HTMLDivElement | null = null
  let uuidSpy: ReturnType<typeof vi.spyOn> | null = null

  function mountView(): HTMLDivElement {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(ElearningCertificateAdminSection)
    app.mount(root)
    return root
  }

  function q(testid: string): HTMLElement {
    const value = root?.querySelector(`[data-testid="${testid}"]`)
    if (!(value instanceof HTMLElement)) throw new Error(`missing ${testid}`)
    return value
  }

  beforeEach(() => {
    useLocale().setLocale('en')
    h.issue.mockReset()
    h.list.mockReset()
    h.publish.mockReset()
    h.list.mockResolvedValue([template()])
    let index = 0
    const ids = [REQUEST_A, REQUEST_B, REQUEST_C]
    uuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => (
      ids[index++] ?? REQUEST_C
    ) as `${string}-${string}-${string}-${string}-${string}`)
  })

  afterEach(() => {
    app?.unmount()
    root?.remove()
    app = null
    root = null
    uuidSpy?.mockRestore()
    vi.clearAllMocks()
  })

  it('loads active templates and renders the parameter contract', async () => {
    const view = mountView()
    await flushUi()
    expect(h.list).toHaveBeenCalledTimes(1)
    expect(view.textContent).toContain('Course completion')
    expect(view.textContent).toContain('learnerName, courseName')
    expect(q('elearning-certificate-issue-parameter-learnerName')).toBeTruthy()
    expect(q('elearning-certificate-issue-parameter-courseName')).toBeTruthy()
  })

  it('reuses a template request ID after failure and rotates when payload changes', async () => {
    mountView()
    await flushUi()
    fill(q('elearning-certificate-template-name') as HTMLInputElement, 'Course completion')
    fill(
      q('elearning-certificate-template-text') as HTMLTextAreaElement,
      '#learnerName# completed #courseName#',
    )
    h.publish.mockRejectedValueOnce(new ElearningApiError('network_error', 0))
    ;(q('elearning-certificate-template-submit') as HTMLButtonElement).click()
    await flushUi()
    expect(h.publish.mock.calls[0]?.[0]).toMatchObject({ requestId: REQUEST_A })

    h.publish.mockRejectedValueOnce(new ElearningApiError('unavailable', 503))
    ;(q('elearning-certificate-template-submit') as HTMLButtonElement).click()
    await flushUi()
    expect(h.publish.mock.calls[1]?.[0]).toMatchObject({ requestId: REQUEST_A })

    fill(q('elearning-certificate-template-name') as HTMLInputElement, 'Course completion v2')
    h.publish.mockResolvedValueOnce(template({ name: 'Course completion v2', version: 2 }))
    h.list.mockResolvedValueOnce([template({ name: 'Course completion v2', version: 2 })])
    ;(q('elearning-certificate-template-submit') as HTMLButtonElement).click()
    await flushUi()
    expect(h.publish.mock.calls[2]?.[0]).toMatchObject({
      requestId: REQUEST_B,
      name: 'Course completion v2',
    })
  })

  it('freezes issue identity by template revision, target, and parameters', async () => {
    mountView()
    await flushUi()
    fill(q('elearning-certificate-issue-user') as HTMLInputElement, 'learner-1')
    fill(q('elearning-certificate-issue-parameter-learnerName') as HTMLInputElement, 'Learner')
    fill(q('elearning-certificate-issue-parameter-courseName') as HTMLInputElement, 'Safety')
    h.issue.mockRejectedValueOnce(new ElearningApiError('network_error', 0))
    ;(q('elearning-certificate-issue-submit') as HTMLButtonElement).click()
    await flushUi()
    expect(h.issue.mock.calls[0]?.[0]).toEqual({
      requestId: REQUEST_A,
      certificateId: 'course-completion',
      userId: 'learner-1',
      parameters: { learnerName: 'Learner', courseName: 'Safety' },
    })

    h.issue.mockRejectedValueOnce(new ElearningApiError('unavailable', 503))
    ;(q('elearning-certificate-issue-submit') as HTMLButtonElement).click()
    await flushUi()
    expect(h.issue.mock.calls[1]?.[0]).toMatchObject({ requestId: REQUEST_A })

    fill(q('elearning-certificate-issue-user') as HTMLInputElement, 'learner-2')
    h.issue.mockResolvedValueOnce({
      issueId: ISSUE,
      certificateId: 'course-completion',
      templateRevisionId: REVISION,
      templateName: 'Course completion',
      serialNumber: SERIAL,
      parameters: { learnerName: 'Learner', courseName: 'Safety' },
      backgroundImageUrl: null,
      issuedAt: '2026-08-30T05:00:00.000Z',
    })
    ;(q('elearning-certificate-issue-submit') as HTMLButtonElement).click()
    await flushUi()
    expect(h.issue.mock.calls[2]?.[0]).toMatchObject({
      requestId: REQUEST_B,
      userId: 'learner-2',
    })
    expect(q('elearning-certificate-issue-status').textContent).toContain(SERIAL)
  })

  it('keeps conflict errors values-free', async () => {
    mountView()
    await flushUi()
    fill(q('elearning-certificate-issue-user') as HTMLInputElement, 'secret-user')
    fill(q('elearning-certificate-issue-parameter-learnerName') as HTMLInputElement, 'Secret name')
    fill(q('elearning-certificate-issue-parameter-courseName') as HTMLInputElement, 'Secret course')
    h.issue.mockRejectedValueOnce(new ElearningApiError('conflict', 409))
    ;(q('elearning-certificate-issue-submit') as HTMLButtonElement).click()
    await flushUi()
    const status = q('elearning-certificate-issue-status').textContent ?? ''
    expect(status).toContain('request ID')
    expect(status).not.toContain('secret-user')
    expect(status).not.toContain('Secret')
  })
})

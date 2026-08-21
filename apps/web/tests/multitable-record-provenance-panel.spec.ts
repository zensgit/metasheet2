/**
 * MetaRecordProvenancePanel.vue — 数据来源 / Provenance, the FIRST multitable consumer of the
 * Data Factory DF-N2-2c by-rowId provenance read.
 *
 * Wire-vs-fixture (the #1968 lesson the DF-N2-3 operator spec also pins): every load assertion here
 * goes through a mocked `apiFetch`, so the tests prove the component really issues
 * `GET /api/integration/provenance?...&rowId=…` through the EXISTING integration client — not that
 * a pre-mocked service returned a fixture. A source scan additionally pins that the component
 * introduces no fetch path of its own.
 *
 * The four contracts under test:
 *   1. VISIBILITY — hidden without the route's own `integration:read`-tier permission; hidden on a
 *      sheet that is not integration-fed; retracted entirely when the route answers 403.
 *   2. LAZY — mounting (i.e. opening a record) fires NO request; only the first expand does, and
 *      collapse/re-expand reuses the loaded timeline.
 *   3. RENDER — entries from a mocked response, values-free: the whitelisted `attrs` keys render and
 *      everything else in `attrs` does NOT (negative control).
 *   4. STATES — empty (incl. a hand-created row with no key: empty WITHOUT a request) and a quiet
 *      inline error that stays retryable.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
import MetaRecordProvenancePanel from '../src/multitable/components/MetaRecordProvenancePanel.vue'
import type { MetaField, MetaFieldPermission, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }))

vi.mock('../src/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/api')>()
  return { ...actual, apiFetch: apiFetchMock }
})

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function readSrc(rel: string): string {
  return readFileSync(join(__dirname, '..', rel), 'utf8')
}

function okEnvelope(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ ok: true, data }),
  } as unknown as Response
}

function errorEnvelope(status: number, statusText: string, code: string, message: string): Response {
  return {
    ok: false,
    status,
    statusText,
    json: async () => ({ ok: false, error: { code, message } }),
  } as unknown as Response
}

const KEY_FIELD: MetaField = { id: 'fld_key', name: '_integration_idempotency_key', type: 'string' }
const TITLE_FIELD: MetaField = { id: 'fld_title', name: 'Title', type: 'string' }
const INTEGRATION_FED_FIELDS: MetaField[] = [TITLE_FIELD, KEY_FIELD]
const ROW_KEY = 'idem_9f2c4d7ab1'

function record(data: Record<string, unknown>, id = 'rec_1'): MetaRecord {
  return { id, version: 1, data }
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: 'run_0123456789abcdef',
    pipelineId: 'k3-to-beiliao',
    rowId: ROW_KEY,
    eventType: 'target_write_succeeded',
    at: '2026-05-28T02:00:00.000Z',
    attrs: {},
    eventIndex: 0,
    runStatus: 'succeeded',
    runMode: 'incremental',
    runCreatedAt: '2026-05-28T01:59:00.000Z',
    ...overrides,
  }
}

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []

function mount(props: Record<string, unknown>): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(MetaRecordProvenancePanel, props) })
  app.mount(container)
  mounts.push({ app, container })
  return container
}

function grantIntegrationRead(): void {
  localStorage.setItem('user_permissions', JSON.stringify(['multitable:read', 'integration:read']))
}

function grantSheetReadOnly(): void {
  localStorage.setItem('user_permissions', JSON.stringify(['multitable:read']))
}

function toggle(container: HTMLDivElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('[data-test="record-provenance-toggle"]')
  if (!button) throw new Error('provenance toggle not rendered')
  return button
}

beforeEach(() => {
  apiFetchMock.mockReset()
  apiFetchMock.mockResolvedValue(okEnvelope([]))
})

afterEach(() => {
  while (mounts.length) {
    const m = mounts.pop()!
    m.app.unmount()
    m.container.remove()
  }
  useLocale().setLocale('en')
  vi.restoreAllMocks()
})

describe('MetaRecordProvenancePanel — visibility', () => {
  it('renders nothing for an actor without the route\'s integration read permission', async () => {
    grantSheetReadOnly()
    const container = mount({ record: record({ fld_key: ROW_KEY }), fields: INTEGRATION_FED_FIELDS })
    await flushUi()

    expect(container.querySelector('[data-test="record-provenance"]')).toBeNull()
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('renders nothing on a sheet that is not integration-fed (no provenance key column)', async () => {
    grantIntegrationRead()
    const container = mount({ record: record({ fld_title: 'Alpha' }), fields: [TITLE_FIELD] })
    await flushUi()

    expect(container.querySelector('[data-test="record-provenance"]')).toBeNull()
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('renders nothing when the key column is RBAC-masked for this actor', async () => {
    grantIntegrationRead()
    const fieldPermissions: Record<string, MetaFieldPermission> = {
      [KEY_FIELD.id]: { visible: false, readOnly: true },
    }
    const container = mount({
      record: record({ fld_key: ROW_KEY }),
      fields: INTEGRATION_FED_FIELDS,
      fieldPermissions,
    })
    await flushUi()

    expect(container.querySelector('[data-test="record-provenance"]')).toBeNull()
  })

  it('retracts the whole section when the route answers 403', async () => {
    grantIntegrationRead()
    apiFetchMock.mockResolvedValue(
      errorEnvelope(403, 'Forbidden', 'FORBIDDEN', 'Insufficient integration permissions'),
    )
    const container = mount({ record: record({ fld_key: ROW_KEY }), fields: INTEGRATION_FED_FIELDS })
    await flushUi()

    expect(container.querySelector('[data-test="record-provenance"]')).not.toBeNull()
    toggle(container).click()
    await flushUi()

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-test="record-provenance"]')).toBeNull()
    expect(container.querySelector('[data-test="record-provenance-error"]')).toBeNull()
  })
})

describe('MetaRecordProvenancePanel — lazy load', () => {
  it('fires no request on record open, and exactly one on first expand', async () => {
    grantIntegrationRead()
    apiFetchMock.mockResolvedValue(okEnvelope([entry()]))
    const container = mount({ record: record({ fld_key: ROW_KEY }), fields: INTEGRATION_FED_FIELDS })
    await flushUi()

    // Section header is there, body is collapsed, nothing requested yet.
    expect(container.querySelector('[data-test="record-provenance"]')).not.toBeNull()
    expect(container.querySelector('[data-test="record-provenance-body"]')).toBeNull()
    expect(toggle(container).getAttribute('aria-expanded')).toBe('false')
    expect(apiFetchMock).not.toHaveBeenCalled()

    toggle(container).click()
    await flushUi()

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    const url = String(apiFetchMock.mock.calls[0]?.[0] ?? '')
    expect(url.startsWith('/api/integration/provenance?')).toBe(true)
    expect(url).toContain(`rowId=${ROW_KEY}`)
    expect(toggle(container).getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('[data-test="record-provenance-body"]')).not.toBeNull()
  })

  it('reuses the loaded timeline on collapse then re-expand', async () => {
    grantIntegrationRead()
    apiFetchMock.mockResolvedValue(okEnvelope([entry()]))
    const container = mount({ record: record({ fld_key: ROW_KEY }), fields: INTEGRATION_FED_FIELDS })
    await flushUi()

    toggle(container).click()
    await flushUi()
    toggle(container).click()
    await flushUi()
    toggle(container).click()
    await flushUi()

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(container.querySelectorAll('[data-test="record-provenance-entry"]').length).toBe(1)
  })
})

describe('MetaRecordProvenancePanel — render', () => {
  it('renders the cross-run timeline from the response, values-free', async () => {
    grantIntegrationRead()
    apiFetchMock.mockResolvedValue(okEnvelope([
      entry({ runId: 'run_aaaaaaaaaaaaaaaa', eventIndex: 0, runStatus: 'succeeded' }),
      entry({
        runId: 'run_bbbbbbbbbbbbbbbb',
        eventIndex: 1,
        eventType: 'target_write_failed',
        runStatus: 'partial',
        runMode: 'manual',
        attrs: {
          decision: 'update',
          errorCode: 'C6_WRITE_ROW_HELD',
          // Everything below is deliberately NOT in the render whitelist.
          errorMessage: 'K3 rejected FNumber=BL-2026-0001 for supplier 上海某某有限公司',
          targetKind: 'k3-wise',
          dryRunRevision: 'rev-7',
        },
      }),
    ]))
    const container = mount({ record: record({ fld_key: ROW_KEY }), fields: INTEGRATION_FED_FIELDS })
    await flushUi()
    toggle(container).click()
    await flushUi()

    const entries = container.querySelectorAll('[data-test="record-provenance-entry"]')
    expect(entries.length).toBe(2)

    const text = container.textContent ?? ''
    expect(text).toContain('Write succeeded')
    expect(text).toContain('Write failed')
    expect(text).toContain('k3-to-beiliao')
    // runId is shortened, never the full opaque id.
    expect(text).toContain('run_aaaaaaaa')
    expect(text).not.toContain('run_aaaaaaaaaaaaaaaa')
    // Whitelisted attrs render...
    expect(text).toContain('C6_WRITE_ROW_HELD')
    expect(text).toContain('update')
    // ...and nothing else from the attrs blob does.
    expect(text).not.toContain('K3 rejected')
    expect(text).not.toContain('BL-2026-0001')
    expect(text).not.toContain('k3-wise')
    expect(text).not.toContain('rev-7')
  })

  it('renders the Chinese section label and event vocabulary under the zh locale', async () => {
    grantIntegrationRead()
    useLocale().setLocale('zh-CN')
    apiFetchMock.mockResolvedValue(okEnvelope([entry()]))
    const container = mount({ record: record({ fld_key: ROW_KEY }), fields: INTEGRATION_FED_FIELDS })
    await flushUi()

    expect(toggle(container).textContent).toContain('数据来源')
    toggle(container).click()
    await flushUi()

    expect(container.textContent).toContain('写入成功')
  })
})

describe('MetaRecordProvenancePanel — empty and error states', () => {
  it('shows the empty state when the row has no recorded provenance', async () => {
    grantIntegrationRead()
    apiFetchMock.mockResolvedValue(okEnvelope([]))
    const container = mount({ record: record({ fld_key: ROW_KEY }), fields: INTEGRATION_FED_FIELDS })
    await flushUi()
    toggle(container).click()
    await flushUi()

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    const empty = container.querySelector('[data-test="record-provenance-empty"]')
    expect(empty).not.toBeNull()
    expect(empty?.textContent).toContain('No provenance recorded')
  })

  it('shows the empty state WITHOUT a request for a hand-created row (no key value)', async () => {
    grantIntegrationRead()
    const container = mount({ record: record({ fld_key: '', fld_title: 'typed by hand' }), fields: INTEGRATION_FED_FIELDS })
    await flushUi()
    toggle(container).click()
    await flushUi()

    expect(apiFetchMock).not.toHaveBeenCalled()
    expect(container.querySelector('[data-test="record-provenance-empty"]')).not.toBeNull()
  })

  it('shows a quiet inline error that stays retryable on the next expand', async () => {
    grantIntegrationRead()
    apiFetchMock.mockResolvedValue(errorEnvelope(500, 'Internal Server Error', 'INTERNAL', 'boom'))
    const container = mount({ record: record({ fld_key: ROW_KEY }), fields: INTEGRATION_FED_FIELDS })
    await flushUi()
    toggle(container).click()
    await flushUi()

    const error = container.querySelector('[data-test="record-provenance-error"]')
    expect(error).not.toBeNull()
    expect(error?.textContent).toContain('Provenance is unavailable right now.')
    // Quiet: the raw server message never reaches the DOM.
    expect(container.textContent).not.toContain('boom')
    // One request per user-initiated expand — no retry loop.
    expect(apiFetchMock).toHaveBeenCalledTimes(1)

    apiFetchMock.mockResolvedValue(okEnvelope([entry()]))
    toggle(container).click()
    await flushUi()
    toggle(container).click()
    await flushUi()

    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    expect(container.querySelectorAll('[data-test="record-provenance-entry"]').length).toBe(1)
  })

  it('resets to collapsed and re-queries when the drawer navigates to another record', async () => {
    grantIntegrationRead()
    apiFetchMock.mockResolvedValue(okEnvelope([entry()]))
    const container = document.createElement('div')
    document.body.appendChild(container)
    const current = ref<MetaRecord>(record({ fld_key: ROW_KEY }, 'rec_1'))
    const app = createApp({
      setup: () => () => h(MetaRecordProvenancePanel, { record: current.value, fields: INTEGRATION_FED_FIELDS }),
    })
    app.mount(container)
    mounts.push({ app, container })
    await flushUi()

    toggle(container).click()
    await flushUi()
    expect(apiFetchMock).toHaveBeenCalledTimes(1)

    current.value = record({ fld_key: 'idem_other' }, 'rec_2')
    await flushUi()

    expect(toggle(container).getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-test="record-provenance-body"]')).toBeNull()

    toggle(container).click()
    await flushUi()
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    expect(String(apiFetchMock.mock.calls[1]?.[0] ?? '')).toContain('rowId=idem_other')
  })
})

describe('MetaRecordProvenancePanel — no new data path', () => {
  it('reads only the existing integration provenance client (no hand-rolled fetch/URL)', () => {
    const source = readSrc('src/multitable/components/MetaRecordProvenancePanel.vue')
    const script = source.slice(source.indexOf('<script setup'))
    expect(script).toContain('listIntegrationProvenanceByRow')
    expect(script).not.toMatch(/\bfetch\s*\(/)
    expect(script).not.toMatch(/['"`]\/api\//)
  })

  it('never renders an attrs key outside the whitelist', () => {
    const source = readSrc('src/multitable/utils/record-provenance.ts')
    expect(source).toContain("export const PROVENANCE_VISIBLE_ATTR_KEYS = ['decision', 'errorCode'] as const")
  })
})

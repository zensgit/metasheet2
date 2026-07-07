import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive, type App as VueApp, type Component } from 'vue'
import IntegrationConnectionSection from '../src/components/integration/IntegrationConnectionSection.vue'
import type { IntegrationAdapterMetadata, WorkbenchExternalSystem } from '../src/services/integration/workbench'
import type { ConnectionDraft } from '../src/components/integration/integrationWorkbenchSectionTypes'

// IU-2c (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-2,
// stage C): structural smoke test for the extracted connection section — see
// IntegrationMonitoringSection.spec.ts's header comment for why this is a light isolation check,
// not a re-test of behavior already covered via the parent's unchanged 50 tests.
const ElCard = defineComponent({
  name: 'ElCard',
  props: { shadow: { type: String, required: false, default: undefined } },
  setup(_props, { slots }) {
    return () => h('div', { class: 'el-card' }, [
      slots.header ? h('div', { class: 'el-card__header' }, slots.header()) : null,
      h('div', { class: 'el-card__body' }, slots.default?.()),
    ])
  },
})

describe('IntegrationConnectionSection (unit)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  async function mountSection(props: Record<string, unknown>): Promise<void> {
    container = document.createElement('div')
    document.body.appendChild(container)
    const Host = defineComponent({
      setup() {
        return () => h(IntegrationConnectionSection as unknown as Component, props)
      },
    })
    app = createApp(Host)
    app.component('ElCard', ElCard)
    app.component('router-link', { props: ['to'], setup(_props, { slots }) { return () => h('a', slots.default?.()) } })
    app.mount(container)
    await nextTick()
  }

  const bi = (zh: string, _en: string): string => zh
  const noopFn = (..._args: unknown[]): unknown => undefined

  const emptyConnectionDraft: ConnectionDraft = {
    id: '',
    name: '',
    kind: '',
    role: 'source',
    status: 'active',
    configText: '{}',
    capabilitiesText: '{}',
    dataSourceId: '',
    dataSourceObject: '',
  }

  function baseProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      bi,
      refreshBootstrap: vi.fn(noopFn),
      showConnectionGuide: vi.fn(noopFn),
      showSqlSetup: vi.fn(noopFn),
      inventorySummary: '已配置连接 0 个',
      systems: [] as WorkbenchExternalSystem[],
      connectionStatusLabel: () => '',
      runtimeBlockerForSystem: () => '',
      editConnection: vi.fn(noopFn),
      copyConnection: vi.fn(noopFn),
      deactivateConnection: vi.fn(noopFn),
      activateConnection: vi.fn(noopFn),
      deleteConnection: vi.fn(noopFn),
      deletingConnectionId: '',
      adapters: [] as IntegrationAdapterMetadata[],
      stagingDatasetCards: [],
      visibleAdapters: [] as IntegrationAdapterMetadata[],
      hiddenAdvancedSystemCount: 0,
      connectionDraftTitle: '新增连接',
      connectionDraft: emptyConnectionDraft,
      connectionDraftAdapterOptions: [] as Array<{ kind: string; label: string }>,
      isDataSourceBridgeKind: false,
      onBridgeDataSourceChange: vi.fn(noopFn),
      bridgeDataSources: [],
      bridgeDataSourceObjectsLoading: false,
      bridgeDataSourceObjectOptions: [],
      bridgeDataSourceObjectsError: '',
      selectedBridgeObjectSummary: '',
      bridgeDataSourcesError: '',
      connectionDraftDuplicateWarning: '',
      connectionDraftRoleWarning: '',
      connectionDraftJsonError: '',
      savingConnectionDraft: false,
      canSaveConnectionDraft: false,
      saveConnectionDraft: vi.fn(noopFn),
      resetConnectionDraft: vi.fn(noopFn),
      scope: { tenantId: 'default', workspaceId: null },
      'onUpdate:inventoryExpanded': vi.fn(noopFn),
      inventoryExpanded: false,
      'onUpdate:showAdvancedConnectors': vi.fn(noopFn),
      showAdvancedConnectors: false,
      'onUpdate:workspaceInput': vi.fn(noopFn),
      workspaceInput: '',
      ...overrides,
    }
  }

  it('renders the section id and the connections-empty state (with IU-6 guided sub-testids)', async () => {
    await mountSection(baseProps({ inventoryExpanded: true }))
    expect(container?.querySelector('#int-sec-connection')).toBeTruthy()
    expect(container?.querySelector('[data-testid="connections-empty-state"]')).toBeTruthy()
    // IU-6 guided empty-state copy (what-this-is + first-step) rides through the IU-2c extraction —
    // pin both sub-testids here (the parent view spec doesn't assert them directly, so without
    // this the extracted component could drop the guidance and stay green).
    expect(container?.querySelector('[data-testid="connections-empty-what"]')?.textContent?.trim().length ?? 0).toBeGreaterThan(0)
    expect(container?.querySelector('[data-testid="connections-empty-first-step"]')?.textContent?.trim().length ?? 0).toBeGreaterThan(0)
  })

  it('forwards the refresh-systems click to the prop function', async () => {
    const refreshBootstrap = vi.fn(noopFn)
    await mountSection(baseProps({ refreshBootstrap }))
    const button = container?.querySelector<HTMLButtonElement>('[data-testid="refresh-systems"]')
    button?.click()
    await nextTick()
    expect(refreshBootstrap).toHaveBeenCalledTimes(1)
  })

  it('toggles inventory-expanded via update:inventoryExpanded when the toggle button is clicked', async () => {
    const onUpdateInventoryExpanded = vi.fn(noopFn)
    await mountSection(baseProps({ inventoryExpanded: false, 'onUpdate:inventoryExpanded': onUpdateInventoryExpanded }))
    const toggle = container?.querySelector<HTMLButtonElement>('[data-testid="toggle-inventory-overview"]')
    toggle?.click()
    await nextTick()
    expect(onUpdateInventoryExpanded).toHaveBeenCalledWith(true)
  })

  it('mutates the connectionDraft prop object directly when the connection-name input changes', async () => {
    const connectionDraft: ConnectionDraft = { ...emptyConnectionDraft }
    await mountSection(baseProps({ connectionDraft }))
    const input = container?.querySelector<HTMLInputElement>('[data-testid="connection-draft-name"]')
    expect(input).toBeTruthy()
    if (input) {
      input.value = 'K3 WISE WebAPI'
      input.dispatchEvent(new Event('input'))
    }
    await nextTick()
    expect(connectionDraft.name).toBe('K3 WISE WebAPI')
  })

  // IU-5a (design-lock §2 IU-5, sites 1 "connection-draft-config" + 2
  // "connection-draft-capabilities"): the JsonAssist strip is a side-mount next to the raw
  // textareas above — these tests are additive, the assertions above are untouched.
  it('renders a JsonAssist strip beside both the config and capabilities JSON textareas', async () => {
    await mountSection(baseProps())
    expect(container?.querySelector('[data-testid="connection-draft-config-json-assist"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="connection-draft-config-json-format"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="connection-draft-config-json-status"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="connection-draft-capabilities-json-assist"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="connection-draft-capabilities-json-format"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="connection-draft-capabilities-json-status"]')).toBeTruthy()
    // The raw textareas keep their own data-testids exactly as before — JsonAssist never
    // replaces them.
    expect(container?.querySelector('[data-testid="connection-draft-config"]')?.tagName).toBe('TEXTAREA')
    expect(container?.querySelector('[data-testid="connection-draft-capabilities"]')?.tagName).toBe('TEXTAREA')
  })

  it('formats the config JSON via the JsonAssist format button, mutating connectionDraft in place', async () => {
    // `reactive()` here mirrors the parent view's real `connectionDraft` (a `reactive(...)`
    // object per this file's own extraction-comment above) — plain-object props (as the earlier,
    // pre-existing "mutates connectionDraft…" test above uses) only prove the raw JS write
    // happened, not that the DOM/sibling JsonAssist reacted to it; a genuine reactive proxy is
    // needed to observe the format button's downstream effect.
    const connectionDraft = reactive<ConnectionDraft>({ ...emptyConnectionDraft, configText: '{"a":1,"b":2}' })
    await mountSection(baseProps({ connectionDraft }))
    const formatButton = container?.querySelector<HTMLButtonElement>('[data-testid="connection-draft-config-json-format"]')
    expect(formatButton?.disabled).toBe(false)
    formatButton?.click()
    await nextTick()
    expect(connectionDraft.configText).toBe('{\n  "a": 1,\n  "b": 2\n}')
  })

  it('flips the config JsonAssist status line to invalid when the textarea is edited to malformed JSON', async () => {
    const connectionDraft = reactive<ConnectionDraft>({ ...emptyConnectionDraft })
    await mountSection(baseProps({ connectionDraft }))
    const textarea = container?.querySelector<HTMLTextAreaElement>('[data-testid="connection-draft-config"]')
    expect(textarea).toBeTruthy()
    if (textarea) {
      textarea.value = '{"a": 1,}'
      textarea.dispatchEvent(new Event('input'))
    }
    await nextTick()
    const status = container?.querySelector('[data-testid="connection-draft-config-json-status"]')
    expect(status?.getAttribute('data-status')).toBe('invalid')
  })

  it('does not render the K3 WISE setup-wizard hint for a non-K3 kind', async () => {
    const connectionDraft: ConnectionDraft = { ...emptyConnectionDraft, kind: 'http' }
    await mountSection(baseProps({ connectionDraft }))
    expect(container?.querySelector('[data-testid="connection-draft-k3-setup-hint"]')).toBeFalsy()
  })

  it('renders the K3 WISE setup-wizard hint + link when the erp:k3-wise-webapi kind is selected', async () => {
    const connectionDraft: ConnectionDraft = { ...emptyConnectionDraft, kind: 'erp:k3-wise-webapi' }
    await mountSection(baseProps({ connectionDraft }))
    const hint = container?.querySelector('[data-testid="connection-draft-k3-setup-hint"]')
    expect(hint).toBeTruthy()
    const link = container?.querySelector<HTMLAnchorElement>('[data-testid="connection-draft-k3-setup-link"]')
    expect(link).toBeTruthy()
  })
})

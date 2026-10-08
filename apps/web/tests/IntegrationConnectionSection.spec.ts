import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import { createApp, defineComponent, h, nextTick, reactive, type App as VueApp, type Component } from 'vue'

// 整合切片 (2026-09-09): the section now embeds DataSourcesPanel (the folded-in 外接数据源 page),
// which owns a pinia store and fetches the source list on mount. Stub the SAME api-client seam
// data-sources-ui.spec.ts stubs so this stays a DOM-structure check with zero network, and give
// every mount a fresh pinia below.
const listDataSourcesMock = vi.hoisted(() => vi.fn())
const createDataSourceMock = vi.hoisted(() => vi.fn())
vi.mock('../src/data-sources/api', () => ({
  listDataSources: listDataSourcesMock,
  getDataSource: vi.fn(),
  createDataSource: createDataSourceMock,
  updateDataSource: vi.fn(),
  rotateDataSourceCredentials: vi.fn(),
  deleteDataSource: vi.fn(),
  testDataSourceConnection: vi.fn(),
  testDataSourceDraftConnection: vi.fn(),
  getDataSourceSchema: vi.fn(),
  getDataSourceTableInfo: vi.fn(),
  previewDataSourceRows: vi.fn(),
}))

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

  beforeEach(() => {
    // Default answer for the embedded panel's own on-mount list call. Cases that care about
    // the list override it before mounting.
    listDataSourcesMock.mockResolvedValue([])
  })

  afterEach(() => {
    listDataSourcesMock.mockReset()
    createDataSourceMock.mockReset()
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
    app.use(createPinia())
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
    connectionId: '',
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

  // 整合切片 (2026-09-09): 外接数据源 is no longer a separate page — it renders INSIDE this
  // section. Asserting the wrapper alone would pass on an empty <div>, so the panel's own
  // primary control (`ds-new-button`) has to be found INSIDE the wrapper, inside the section.
  it('the panel 去看绑定 link expands the 已配置连接 inventory (an anchor alone would land on a hidden answer)', async () => {
    // 被引用 N 列 (2026-09-10): the reference column's link asks the HOST to reveal the bindings
    // that hold a source. Those bindings are this inventory, which starts collapsed — so the
    // request has to reach `inventoryExpanded`, or the operator is sent to a section whose
    // answer is still folded away.
    listDataSourcesMock.mockResolvedValue([
      { id: 'src-1', name: 'Source 1', type: 'postgres', connected: true, referenceCount: 2 },
    ])
    const onUpdateInventoryExpanded = vi.fn(noopFn)
    await mountSection(
      baseProps({ inventoryExpanded: false, 'onUpdate:inventoryExpanded': onUpdateInventoryExpanded }),
    )
    // The embedded panel fetches its list on mount; flush that before reading the column.
    for (let i = 0; i < 3; i += 1) {
      await Promise.resolve()
      await nextTick()
    }

    const link = container?.querySelector<HTMLAnchorElement>(
      '[data-testid="connection-data-sources-panel"] [data-testid="ds-reference-goto"]',
    )
    expect(link).toBeTruthy()
    // Embedded, it is an in-page anchor at this very section — not a navigation elsewhere.
    expect(link?.getAttribute('href')).toBe('#int-sec-connection')

    link?.click()
    await nextTick()
    expect(onUpdateInventoryExpanded).toHaveBeenCalledWith(true)
  })

  it('embeds the data-sources panel inside #int-sec-connection, with the panel content really rendered', async () => {
    await mountSection(baseProps())
    const panel = container?.querySelector('#int-sec-connection [data-testid="connection-data-sources-panel"]')
    expect(panel).toBeTruthy()
    expect(panel?.querySelector('[data-testid="ds-new-button"]')).toBeTruthy()
    // It sits AFTER the onboarding block and BEFORE the inventory toggle — the position the two
    // 「上方『外接数据源』面板」 hints further down the section promise the operator.
    const onboarding = container?.querySelector('[data-testid="connection-onboarding"]')
    const inventoryToggle = container?.querySelector('[data-testid="toggle-inventory-overview"]')
    expect(onboarding).toBeTruthy()
    expect(inventoryToggle).toBeTruthy()
    expect((onboarding!.compareDocumentPosition(panel!) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
    expect((panel!.compareDocumentPosition(inventoryToggle!) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
  })

  it('calls onDataSourcesChanged after the embedded panel reports a successful create', async () => {
    // The whole point of the fold: a source registered in the embedded panel must become
    // selectable in the connection draft below WITHOUT a reload. That only holds if the panel's
    // `changed` emit actually reaches the host's refresh callback.
    listDataSourcesMock.mockResolvedValue([])
    createDataSourceMock.mockResolvedValue({ id: 'src-1' })
    const onDataSourcesChanged = vi.fn(noopFn)
    await mountSection(baseProps({ onDataSourcesChanged }))

    container?.querySelector<HTMLButtonElement>('[data-testid="ds-new-button"]')?.click()
    await nextTick()
    for (const [testid, value] of [['ds-field-id', 'src-1'], ['ds-field-name', 'Source 1'], ['ds-field-host', 'db.internal'], ['ds-field-database', 'app']] as const) {
      const input = container?.querySelector<HTMLInputElement>(`[data-testid="${testid}"]`)
      expect(input, testid).toBeTruthy()
      if (input) {
        input.value = value
        input.dispatchEvent(new Event('input'))
      }
    }
    await nextTick()

    container?.querySelector<HTMLFormElement>('[data-testid="ds-create-form"]')?.dispatchEvent(
      new Event('submit', { cancelable: true }),
    )
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve()
      await nextTick()
    }

    expect(createDataSourceMock).toHaveBeenCalledTimes(1)
    expect(onDataSourcesChanged).toHaveBeenCalledTimes(1)
  })

  it('does not call onDataSourcesChanged when the create fails', async () => {
    // A refetch on a FAILED attempt would repaint the pre-attempt list as if it were fresh.
    listDataSourcesMock.mockResolvedValue([])
    createDataSourceMock.mockRejectedValue(new Error('create rejected'))
    const onDataSourcesChanged = vi.fn(noopFn)
    await mountSection(baseProps({ onDataSourcesChanged }))

    container?.querySelector<HTMLButtonElement>('[data-testid="ds-new-button"]')?.click()
    await nextTick()
    for (const [testid, value] of [['ds-field-id', 'src-1'], ['ds-field-name', 'Source 1'], ['ds-field-host', 'db.internal'], ['ds-field-database', 'app']] as const) {
      const input = container?.querySelector<HTMLInputElement>(`[data-testid="${testid}"]`)
      expect(input, testid).toBeTruthy()
      if (input) {
        input.value = value
        input.dispatchEvent(new Event('input'))
      }
    }
    await nextTick()

    container?.querySelector<HTMLFormElement>('[data-testid="ds-create-form"]')?.dispatchEvent(
      new Event('submit', { cancelable: true }),
    )
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve()
      await nextTick()
    }

    expect(createDataSourceMock).toHaveBeenCalledTimes(1)
    expect(onDataSourcesChanged).not.toHaveBeenCalled()
  })

  it('points the bridge hints at the embedded panel instead of the retired /data-sources path', async () => {
    const connectionDraft: ConnectionDraft = { ...emptyConnectionDraft, kind: 'data-source:sql-readonly' }
    await mountSection(baseProps({ connectionDraft, isDataSourceBridgeKind: true }))
    const hint = container?.querySelector('[data-testid="data-source-bridge-hint"]')?.textContent ?? ''
    expect(hint).toContain('上方「外接数据源」面板')
    expect(hint).not.toContain('/data-sources')
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

  // 这块清单是带写按钮的清单,而列表读已经放宽到「同租户的租户级行」。upsert/delete 没有放宽
  // (都按精确作用域匹配),所以回退来的行必须在这里就改不动:否则「停用」会被服务端以 409
  // EXTERNAL_SYSTEM_SCOPE_MISMATCH 拒掉,「删除」会 404 —— 两个死按钮。
  // 口径注意:这四个按钮置灰 ≠ 这行只读。同一屏的「测试连接」仍会按行自身的作用域写回该行
  // (服务端 persistExternalSystemTestResult,#5534),所以组件只负责原样展示父组件给的理由。
  const tenantWideSystem: WorkbenchExternalSystem = {
    id: 'sys_tenant_wide',
    tenantId: 'default',
    workspaceId: null,
    name: '客户 PLM 只读库',
    kind: 'data-source:sql-readonly',
    role: 'source',
    status: 'active',
  }
  const ownScopeSystem: WorkbenchExternalSystem = {
    ...tenantWideSystem,
    id: 'sys_ws',
    name: '本工作区的源',
    workspaceId: 'default',
  }
  const WRITE_BLOCK_REASON = '这是租户级连接(未归属当前工作区):在当前工作区里不能编辑 / 停用 / 启用 / 删除。'

  it('把回退来的行的编辑/停用/删除置灰并给出原因,复制仍可用', async () => {
    await mountSection(baseProps({
      inventoryExpanded: true,
      systems: [tenantWideSystem, ownScopeSystem],
      // 与父组件同形:判据只看行自己的 workspaceId 与当前 hint 是否一致。
      connectionScopeWriteBlock: (system: WorkbenchExternalSystem) => (
        (system.workspaceId ?? null) === null ? WRITE_BLOCK_REASON : ''
      ),
    }))

    const notice = container?.querySelector('[data-testid="connection-scope-write-block-sys_tenant_wide"]')
    expect(notice?.textContent).toContain('租户级')
    expect(notice?.textContent).toContain('停用')
    expect(container?.querySelector<HTMLButtonElement>('[data-testid="edit-connection-sys_tenant_wide"]')?.disabled).toBe(true)
    expect(container?.querySelector<HTMLButtonElement>('[data-testid="deactivate-connection-sys_tenant_wide"]')?.disabled).toBe(true)
    expect(container?.querySelector<HTMLButtonElement>('[data-testid="delete-connection-sys_tenant_wide"]')?.disabled).toBe(true)
    expect(container?.querySelector<HTMLButtonElement>('[data-testid="delete-connection-sys_tenant_wide"]')?.title).toContain('租户级')
    // 复制会清空 id、在当前作用域新建一条,是这行唯一正当的写动作,不许一起置灰。
    expect(container?.querySelector<HTMLButtonElement>('[data-testid="copy-connection-sys_tenant_wide"]')?.disabled).toBe(false)

    // 同一份渲染里,本作用域的行一切照旧 —— 是按行判的,不是整块清单一刀切。
    expect(container?.querySelector('[data-testid="connection-scope-write-block-sys_ws"]')).toBeFalsy()
    expect(container?.querySelector<HTMLButtonElement>('[data-testid="edit-connection-sys_ws"]')?.disabled).toBe(false)
    expect(container?.querySelector<HTMLButtonElement>('[data-testid="deactivate-connection-sys_ws"]')?.disabled).toBe(false)
    expect(container?.querySelector<HTMLButtonElement>('[data-testid="delete-connection-sys_ws"]')?.disabled).toBe(false)
  })

  it('没传 connectionScopeWriteBlock 时按可写渲染(其它挂载点与既有用法不受影响)', async () => {
    await mountSection(baseProps({ inventoryExpanded: true, systems: [tenantWideSystem] }))
    expect(container?.querySelector('[data-testid="connection-scope-write-block-sys_tenant_wide"]')).toBeFalsy()
    expect(container?.querySelector<HTMLButtonElement>('[data-testid="deactivate-connection-sys_tenant_wide"]')?.disabled).toBe(false)
  })
})

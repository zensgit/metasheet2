import { createApp, nextTick } from 'vue'
import type { App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AuthState,
  BomLineRecord,
  PlmBomPanelModel,
  PlmProductPanelModel,
  PlmSearchPanelModel,
  ProductRecord,
  SearchItem,
} from '../src/views/plm/plmPanelModels'
import type { PlmItemMetadata, PlmListResponse } from '../src/services/PlmService'
import PlmProductView from '../src/views/PlmProductView.vue'

const handles = vi.hoisted(() => ({
  route: {
    query: {},
    path: '/plm',
    fullPath: '/plm',
  },
  productPanel: null as unknown,
  searchPanel: null as unknown,
  bomPanel: null as unknown,
  handleAuthError: null as null | ReturnType<typeof vi.fn>,
  routerReplace: vi.fn(),
  scheduleQuerySync: vi.fn(),
  apiFetch: vi.fn(() => {
    throw new Error('unexpected apiFetch call')
  }),
  getProduct: vi.fn(),
  getMetadata: vi.fn(),
  getBom: vi.fn(),
  listDocuments: vi.fn(),
  listApprovals: vi.fn(),
}))

vi.mock('../src/components/plm/PlmProductPanel.vue', () => ({
  default: {
    name: 'PlmProductPanel',
    props: ['panel'],
    setup(props: { panel: PlmProductPanelModel }) {
      handles.productPanel = props.panel
    },
    render() {
      return null
    },
  },
}))

vi.mock('../src/components/plm/PlmSearchPanel.vue', () => ({
  default: {
    name: 'PlmSearchPanel',
    props: ['panel'],
    setup(props: { panel: PlmSearchPanelModel }) {
      handles.searchPanel = props.panel
    },
    render() {
      return null
    },
  },
}))

vi.mock('../src/components/plm/PlmBomPanel.vue', () => ({
  default: {
    name: 'PlmBomPanel',
    props: ['panel'],
    setup(props: { panel: PlmBomPanelModel }) {
      handles.bomPanel = props.panel
    },
    render() {
      return null
    },
  },
}))

vi.mock('../src/components/plm/PlmDocumentsPanel.vue', () => ({
  default: {
    name: 'PlmDocumentsPanel',
    render() {
      return null
    },
  },
}))

vi.mock('../src/components/plm/PlmCadPanel.vue', () => ({
  default: {
    name: 'PlmCadPanel',
    render() {
      return null
    },
  },
}))

vi.mock('../src/components/plm/PlmApprovalsPanel.vue', () => ({
  default: {
    name: 'PlmApprovalsPanel',
    render() {
      return null
    },
  },
}))

vi.mock('../src/components/plm/PlmWhereUsedPanel.vue', () => ({
  default: {
    name: 'PlmWhereUsedPanel',
    render() {
      return null
    },
  },
}))

vi.mock('../src/components/plm/PlmComparePanel.vue', () => ({
  default: {
    name: 'PlmComparePanel',
    render() {
      return null
    },
  },
}))

vi.mock('../src/components/plm/PlmSubstitutesPanel.vue', () => ({
  default: {
    name: 'PlmSubstitutesPanel',
    render() {
      return null
    },
  },
}))

vi.mock('../src/views/plm/usePlmAuthStatus', async () => {
  const { ref } = await import('vue')
  return {
    usePlmAuthStatus: () => {
      const handleAuthError = vi.fn()
      handles.handleAuthError = handleAuthError
      return {
        authState: ref('missing' as AuthState),
        authExpiresAt: ref<number | null>(null),
        plmAuthState: ref('missing' as AuthState),
        plmAuthExpiresAt: ref<number | null>(null),
        plmAuthLegacy: ref(false),
        authError: ref(''),
        refreshAuthStatus: vi.fn(),
        handleAuthError,
        startAuthStatusPolling: vi.fn(),
        stopAuthStatusPolling: vi.fn(),
      }
    },
  }
})

vi.mock('vue-router', () => ({
  useRoute: () => handles.route,
  useRouter: () => ({ replace: handles.routerReplace }),
}))

vi.mock('../src/views/plm/usePlmDeepLinkState', async () => {
  const actual = await vi.importActual<typeof import('../src/views/plm/usePlmDeepLinkState')>(
    '../src/views/plm/usePlmDeepLinkState',
  )
  return {
    ...actual,
    usePlmDeepLinkState: (options: Parameters<typeof actual.usePlmDeepLinkState>[0]) => {
      const actualState = actual.usePlmDeepLinkState(options)
      return {
        ...actualState,
        scheduleQuerySync: handles.scheduleQuerySync,
      }
    },
  }
})

vi.mock('../src/services/PlmService', () => ({
  plmService: {
    getProduct: handles.getProduct,
    getMetadata: handles.getMetadata,
    getBom: handles.getBom,
    listDocuments: handles.listDocuments,
    listApprovals: handles.listApprovals,
  },
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: handles.apiFetch,
}))

const recordA: ProductRecord = {
  id: 'A',
  name: 'Product A',
  partNumber: 'PN-A',
  itemType: 'Part',
}
const recordB: ProductRecord = {
  id: 'B',
  name: 'Product B',
  partNumber: 'PN-B',
  itemType: 'Part',
}
const recordC: ProductRecord = {
  id: 'C',
  name: 'Product C',
  partNumber: 'PN-C',
  itemType: 'Part',
}
const searchItemB: SearchItem = {
  id: 'B',
  name: 'Product B',
  partNumber: 'PN-B',
  itemType: 'Part',
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {}
  let reject: (reason?: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let active: { app: App, container: HTMLElement } | null = null

beforeEach(() => {
  localStorage.clear()
  handles.productPanel = null
  handles.searchPanel = null
  handles.bomPanel = null
  handles.getProduct.mockReset()
  handles.getProduct.mockImplementation(() => Promise.reject(new Error('unexpected getProduct')))
  handles.getMetadata.mockReset()
  handles.getMetadata.mockImplementation(async (itemType: string): Promise<PlmItemMetadata> => ({
    id: itemType,
    properties: [{ name: 'name', label: 'Name', type: 'string' }],
  }))
  handles.getBom.mockReset()
  handles.getBom.mockImplementation(async (productId: string) => ({
    productId,
    items: [],
    total: 0,
  }))
  handles.listDocuments.mockReset()
  handles.listDocuments.mockImplementation(async () => ({
    items: [],
    total: 0,
    sources: [],
  }))
  handles.listApprovals.mockReset()
  handles.listApprovals.mockImplementation(async () => ({
    items: [],
    total: 0,
  }))
  handles.routerReplace.mockReset()
  handles.routerReplace.mockResolvedValue(undefined)
  handles.scheduleQuerySync.mockReset()
  handles.apiFetch.mockClear()
  handles.handleAuthError?.mockClear()
})

afterEach(() => {
  active?.app.unmount()
  active?.container.remove()
  active = null
})

async function mountOwnedView() {
  localStorage.clear()
  handles.productPanel = null
  handles.searchPanel = null
  handles.bomPanel = null
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(PlmProductView)
  active = { app, container }
  app.mount(container)
  await nextTick()

  const productPanel = handles.productPanel as PlmProductPanelModel | null
  const searchPanel = handles.searchPanel as PlmSearchPanelModel | null
  const bomPanel = handles.bomPanel as PlmBomPanelModel | null
  const handleAuthError = handles.handleAuthError
  if (!productPanel || !searchPanel || !bomPanel || !handleAuthError) {
    throw new Error('PlmProductView mount did not capture product panel, search panel, bom panel, and handleAuthError')
  }

  expect(handles.getProduct).not.toHaveBeenCalled()
  expect(handles.getMetadata).not.toHaveBeenCalled()
  expect(handles.getBom).not.toHaveBeenCalled()
  expect(handles.listDocuments).not.toHaveBeenCalled()
  expect(handles.listApprovals).not.toHaveBeenCalled()
  expect(handles.apiFetch).not.toHaveBeenCalled()

  return {
    productPanel,
    searchPanel,
    bomPanel,
    handleAuthError,
    async seedAcceptedC() {
      handles.getProduct.mockImplementation((id: string) => {
        if (id !== 'C') return Promise.reject(new Error(`unexpected getProduct ${id}`))
        return Promise.resolve({ ...recordC })
      })
      productPanel.productId.value = 'C'
      productPanel.productItemNumber.value = 'PN-C'
      productPanel.itemType.value = 'Part'
      await productPanel.loadProduct()
      await nextTick()

      expect(productPanel.product.value).toEqual(expect.objectContaining({
        id: 'C',
        name: 'Product C',
        partNumber: 'PN-C',
        itemType: 'Part',
      }))
      expect(productPanel.productView.value).toEqual(expect.objectContaining({
        partNumber: 'PN-C',
        itemType: 'Part',
      }))
      expect(productPanel.productLoading.value).toBe(false)
      expect(productPanel.productError.value).toBe('')
      expect(productPanel.productMetadataError.value).toBe('')
      expect(handleAuthError).not.toHaveBeenCalled()
      expect(productPanel.productMetadataRows.value).toEqual([
        expect.objectContaining({ name: 'name', currentValue: 'Product C' }),
      ])
      expect(handles.getProduct).toHaveBeenCalledTimes(1)
      expect(handles.getProduct).toHaveBeenCalledWith('C', { itemType: 'Part', itemNumber: 'PN-C' })
      expect(handles.getMetadata).toHaveBeenCalledTimes(1)
      expect(handles.getMetadata).toHaveBeenCalledWith('Part')
      expect(handles.getBom).toHaveBeenCalledTimes(1)
      expect(handles.getBom).toHaveBeenCalledWith('C', { depth: 2, effectiveAt: undefined })
      expect(handles.listDocuments).toHaveBeenCalledTimes(1)
      expect(handles.listDocuments).toHaveBeenCalledWith({ productId: 'C', role: undefined })
      expect(handles.listApprovals).toHaveBeenCalledTimes(1)
      expect(handles.listApprovals).toHaveBeenCalledWith({ productId: 'C', status: 'pending' })

      handles.getProduct.mockClear()
      handles.getMetadata.mockClear()
      handles.getBom.mockClear()
      handles.listDocuments.mockClear()
      handles.listApprovals.mockClear()
      handles.routerReplace.mockClear()
      handleAuthError.mockClear()
      handles.scheduleQuerySync.mockClear()
      expect(handles.apiFetch).not.toHaveBeenCalled()
    },
  }
}

describe('PlmProductView loadProduct completion ownership', () => {
  it('B success and batch then old A success keeps B and does not publish A', async () => {
    const view = await mountOwnedView()
    await view.seedAcceptedC()
    const gateA = deferred<ProductRecord>()
    const gateB = deferred<ProductRecord>()
    handles.getProduct.mockImplementation((id: string) => {
      if (id === 'A') return gateA.promise
      if (id === 'B') return gateB.promise
      return Promise.reject(new Error(`unexpected getProduct ${id}`))
    })
    view.productPanel.productId.value = 'A'
    view.productPanel.productItemNumber.value = 'PN-A'
    view.productPanel.itemType.value = 'Part'
    const pendingA = view.productPanel.loadProduct()
    const pendingB = view.searchPanel.applySearchItem({ ...searchItemB })
    expect(JSON.stringify(handles.routerReplace.mock.calls)).toContain('"A"')
    expect(JSON.stringify(handles.routerReplace.mock.calls)).toContain('"B"')

    gateB.resolve({ ...recordB })
    await pendingB
    await nextTick()

    expect(view.productPanel.product.value).toEqual(expect.objectContaining({
      id: 'B',
      name: 'Product B',
      partNumber: 'PN-B',
      itemType: 'Part',
    }))
    expect(view.productPanel.productView.value).toEqual(expect.objectContaining({
      partNumber: 'PN-B',
      itemType: 'Part',
    }))
    expect(view.productPanel.productId.value).toBe('B')
    expect(view.productPanel.productItemNumber.value).toBe('PN-B')
    expect(view.productPanel.itemType.value).toBe('Part')
    expect(view.productPanel.productLoading.value).toBe(false)
    expect(view.productPanel.productError.value).toBe('')
    expect(view.productPanel.productMetadataError.value).toBe('')
    expect(view.productPanel.productMetadataRows.value).toEqual([
      expect.objectContaining({ name: 'name', currentValue: 'Product B' }),
    ])
    expect(handles.getProduct).toHaveBeenCalledTimes(2)
    expect(handles.getProduct).toHaveBeenNthCalledWith(1, 'A', { itemType: 'Part', itemNumber: 'PN-A' })
    expect(handles.getProduct).toHaveBeenNthCalledWith(2, 'B', { itemType: 'Part', itemNumber: 'PN-B' })
    expect(handles.getMetadata).toHaveBeenCalledTimes(1)
    expect(handles.getMetadata).toHaveBeenCalledWith('Part')
    expect(handles.getBom).toHaveBeenCalledTimes(1)
    expect(handles.getBom).toHaveBeenCalledWith('B', { depth: 2, effectiveAt: undefined })
    expect(handles.listDocuments).toHaveBeenCalledTimes(1)
    expect(handles.listDocuments).toHaveBeenCalledWith({ productId: 'B', role: undefined })
    expect(handles.listApprovals).toHaveBeenCalledTimes(1)
    expect(handles.listApprovals).toHaveBeenCalledWith({ productId: 'B', status: 'pending' })

    const patchesAfterB = handles.routerReplace.mock.calls.length
    gateA.resolve({ ...recordA })
    await pendingA
    await nextTick()

    expect(handles.routerReplace.mock.calls).toHaveLength(patchesAfterB)
    expect(view.productPanel.product.value).toEqual(expect.objectContaining({
      id: 'B',
      name: 'Product B',
      partNumber: 'PN-B',
      itemType: 'Part',
    }))
    expect(view.productPanel.productId.value).toBe('B')
    expect(view.productPanel.productItemNumber.value).toBe('PN-B')
    expect(view.productPanel.itemType.value).toBe('Part')
    expect(view.productPanel.productLoading.value).toBe(false)
    expect(view.productPanel.productError.value).toBe('')
    expect(view.productPanel.productMetadataRows.value).toEqual([
      expect.objectContaining({ name: 'name', currentValue: 'Product B' }),
    ])
    expect(handles.getProduct).toHaveBeenCalledTimes(2)
    expect(handles.getMetadata).toHaveBeenCalledTimes(1)
    expect(handles.getBom).toHaveBeenCalledTimes(1)
    expect(handles.listDocuments).toHaveBeenCalledTimes(1)
    expect(handles.listApprovals).toHaveBeenCalledTimes(1)
    expect(view.handleAuthError).not.toHaveBeenCalled()
    expect(handles.apiFetch).not.toHaveBeenCalled()
  })

  it('old A success while B is pending preserves C and loading and dispatches no batch', async () => {
    const view = await mountOwnedView()
    await view.seedAcceptedC()
    const gateA = deferred<ProductRecord>()
    const gateB = deferred<ProductRecord>()
    handles.getProduct.mockImplementation((id: string) => {
      if (id === 'A') return gateA.promise
      if (id === 'B') return gateB.promise
      return Promise.reject(new Error(`unexpected getProduct ${id}`))
    })
    view.productPanel.productId.value = 'A'
    view.productPanel.productItemNumber.value = 'PN-A'
    view.productPanel.itemType.value = 'Part'
    const pendingA = view.productPanel.loadProduct()
    const pendingB = view.searchPanel.applySearchItem({ ...searchItemB })
    const patchesBeforeStaleA = handles.routerReplace.mock.calls.length

    gateA.resolve({ ...recordA })
    await pendingA
    await nextTick()

    expect(view.productPanel.product.value).toEqual(expect.objectContaining({
      id: 'C',
      name: 'Product C',
      partNumber: 'PN-C',
      itemType: 'Part',
    }))
    expect(view.productPanel.productLoading.value).toBe(true)
    expect(view.productPanel.productId.value).toBe('B')
    expect(view.productPanel.productItemNumber.value).toBe('PN-B')
    expect(view.productPanel.itemType.value).toBe('Part')
    expect(handles.routerReplace.mock.calls).toHaveLength(patchesBeforeStaleA)
    expect(handles.getProduct).toHaveBeenCalledTimes(2)
    expect(handles.getProduct).toHaveBeenNthCalledWith(1, 'A', { itemType: 'Part', itemNumber: 'PN-A' })
    expect(handles.getProduct).toHaveBeenNthCalledWith(2, 'B', { itemType: 'Part', itemNumber: 'PN-B' })
    expect(handles.getMetadata).not.toHaveBeenCalled()
    expect(handles.getBom).not.toHaveBeenCalled()
    expect(handles.listDocuments).not.toHaveBeenCalled()
    expect(handles.listApprovals).not.toHaveBeenCalled()

    gateB.resolve({ ...recordB })
    await pendingB
    await nextTick()

    expect(view.productPanel.product.value).toEqual(expect.objectContaining({
      id: 'B',
      name: 'Product B',
      partNumber: 'PN-B',
      itemType: 'Part',
    }))
    expect(view.productPanel.productLoading.value).toBe(false)
    expect(handles.getProduct).toHaveBeenCalledTimes(2)
    expect(handles.getMetadata).toHaveBeenCalledTimes(1)
    expect(handles.getMetadata).toHaveBeenCalledWith('Part')
    expect(handles.getBom).toHaveBeenCalledTimes(1)
    expect(handles.getBom).toHaveBeenCalledWith('B', { depth: 2, effectiveAt: undefined })
    expect(handles.listDocuments).toHaveBeenCalledTimes(1)
    expect(handles.listDocuments).toHaveBeenCalledWith({ productId: 'B', role: undefined })
    expect(handles.listApprovals).toHaveBeenCalledTimes(1)
    expect(handles.listApprovals).toHaveBeenCalledWith({ productId: 'B', status: 'pending' })
    expect(handles.apiFetch).not.toHaveBeenCalled()
  })

  it('B success with nonempty metadata then old A rejection preserves metadata, error, and auth', async () => {
    const view = await mountOwnedView()
    await view.seedAcceptedC()
    const gateA = deferred<ProductRecord>()
    const gateB = deferred<ProductRecord>()
    handles.getProduct.mockImplementation((id: string) => {
      if (id === 'A') return gateA.promise
      if (id === 'B') return gateB.promise
      return Promise.reject(new Error(`unexpected getProduct ${id}`))
    })
    view.productPanel.productId.value = 'A'
    view.productPanel.productItemNumber.value = 'PN-A'
    view.productPanel.itemType.value = 'Part'
    const pendingA = view.productPanel.loadProduct()
    const pendingB = view.searchPanel.applySearchItem({ ...searchItemB })

    gateB.resolve({ ...recordB })
    await pendingB
    await nextTick()

    expect(view.productPanel.product.value).toEqual(expect.objectContaining({
      id: 'B',
      name: 'Product B',
      partNumber: 'PN-B',
      itemType: 'Part',
    }))
    expect(view.productPanel.productMetadataRows.value).toEqual([
      expect.objectContaining({ name: 'name', currentValue: 'Product B' }),
    ])
    expect(handles.getMetadata).toHaveBeenCalledTimes(1)
    expect(handles.getMetadata).toHaveBeenCalledWith('Part')
    expect(handles.getBom).toHaveBeenCalledTimes(1)
    expect(handles.getBom).toHaveBeenCalledWith('B', { depth: 2, effectiveAt: undefined })
    expect(handles.listDocuments).toHaveBeenCalledTimes(1)
    expect(handles.listDocuments).toHaveBeenCalledWith({ productId: 'B', role: undefined })
    expect(handles.listApprovals).toHaveBeenCalledTimes(1)
    expect(handles.listApprovals).toHaveBeenCalledWith({ productId: 'B', status: 'pending' })

    const failureA = new Error('Product A load failed')
    const patchesAfterB = handles.routerReplace.mock.calls.length
    gateA.reject(failureA)
    await pendingA
    await nextTick()

    expect(handles.routerReplace.mock.calls).toHaveLength(patchesAfterB)
    expect(view.productPanel.product.value).toEqual(expect.objectContaining({
      id: 'B',
      name: 'Product B',
      partNumber: 'PN-B',
      itemType: 'Part',
    }))
    expect(view.productPanel.productId.value).toBe('B')
    expect(view.productPanel.productItemNumber.value).toBe('PN-B')
    expect(view.productPanel.itemType.value).toBe('Part')
    expect(view.productPanel.productMetadataRows.value).toEqual([
      expect.objectContaining({ name: 'name', currentValue: 'Product B' }),
    ])
    expect(view.productPanel.productMetadataError.value).toBe('')
    expect(view.productPanel.productError.value).toBe('')
    expect(view.productPanel.productLoading.value).toBe(false)
    expect(view.handleAuthError).not.toHaveBeenCalled()
    expect(handles.getProduct).toHaveBeenCalledTimes(2)
    expect(handles.getProduct).toHaveBeenNthCalledWith(1, 'A', { itemType: 'Part', itemNumber: 'PN-A' })
    expect(handles.getProduct).toHaveBeenNthCalledWith(2, 'B', { itemType: 'Part', itemNumber: 'PN-B' })
    expect(handles.getMetadata).toHaveBeenCalledTimes(1)
    expect(handles.getBom).toHaveBeenCalledTimes(1)
    expect(handles.listDocuments).toHaveBeenCalledTimes(1)
    expect(handles.listApprovals).toHaveBeenCalledTimes(1)
    expect(handles.apiFetch).not.toHaveBeenCalled()
  })

  it('latest B rejection before A success preserves C, selected B, and the latest error and auth once', async () => {
    const view = await mountOwnedView()
    await view.seedAcceptedC()
    const gateA = deferred<ProductRecord>()
    const gateB = deferred<ProductRecord>()
    handles.getProduct.mockImplementation((id: string) => {
      if (id === 'A') return gateA.promise
      if (id === 'B') return gateB.promise
      return Promise.reject(new Error(`unexpected getProduct ${id}`))
    })
    view.productPanel.productId.value = 'A'
    view.productPanel.productItemNumber.value = 'PN-A'
    view.productPanel.itemType.value = 'Part'
    const pendingA = view.productPanel.loadProduct()
    const pendingB = view.searchPanel.applySearchItem({ ...searchItemB })
    const failureB = new Error('Product B load failed')

    gateB.reject(failureB)
    await pendingB
    await nextTick()

    expect(view.productPanel.product.value).toEqual(expect.objectContaining({
      id: 'C',
      name: 'Product C',
      partNumber: 'PN-C',
      itemType: 'Part',
    }))
    expect(view.productPanel.productId.value).toBe('B')
    expect(view.productPanel.productItemNumber.value).toBe('PN-B')
    expect(view.productPanel.itemType.value).toBe('Part')
    expect(view.productPanel.productMetadataRows.value).toEqual([])
    expect(view.productPanel.productMetadataError.value).toBe('')
    expect(view.productPanel.productError.value).toBe('Product B load failed')
    expect(view.handleAuthError).toHaveBeenCalledTimes(1)
    expect(view.handleAuthError).toHaveBeenCalledWith(failureB)
    expect(view.productPanel.productLoading.value).toBe(false)
    expect(handles.getMetadata).not.toHaveBeenCalled()
    expect(handles.getBom).not.toHaveBeenCalled()
    expect(handles.listDocuments).not.toHaveBeenCalled()
    expect(handles.listApprovals).not.toHaveBeenCalled()

    const patchesAfterBRejection = handles.routerReplace.mock.calls.length
    gateA.resolve({ ...recordA })
    await pendingA
    await nextTick()

    expect(handles.routerReplace.mock.calls).toHaveLength(patchesAfterBRejection)
    expect(view.productPanel.product.value).toEqual(expect.objectContaining({
      id: 'C',
      name: 'Product C',
      partNumber: 'PN-C',
      itemType: 'Part',
    }))
    expect(view.productPanel.productId.value).toBe('B')
    expect(view.productPanel.productItemNumber.value).toBe('PN-B')
    expect(view.productPanel.itemType.value).toBe('Part')
    expect(view.productPanel.productMetadataRows.value).toEqual([])
    expect(view.productPanel.productMetadataError.value).toBe('')
    expect(view.productPanel.productError.value).toBe('Product B load failed')
    expect(view.handleAuthError).toHaveBeenCalledTimes(1)
    expect(view.handleAuthError).toHaveBeenCalledWith(failureB)
    expect(view.productPanel.productLoading.value).toBe(false)
    expect(handles.getProduct).toHaveBeenCalledTimes(2)
    expect(handles.getProduct).toHaveBeenNthCalledWith(1, 'A', { itemType: 'Part', itemNumber: 'PN-A' })
    expect(handles.getProduct).toHaveBeenNthCalledWith(2, 'B', { itemType: 'Part', itemNumber: 'PN-B' })
    expect(handles.getMetadata).not.toHaveBeenCalled()
    expect(handles.getBom).not.toHaveBeenCalled()
    expect(handles.listDocuments).not.toHaveBeenCalled()
    expect(handles.listApprovals).not.toHaveBeenCalled()
    expect(handles.apiFetch).not.toHaveBeenCalled()
  })

  it('one current item-number lookup preserves canonical-ID success and the exact read batch', async () => {
    const view = await mountOwnedView()
    handles.getProduct.mockImplementation((id: string) => {
      if (id !== 'PN-B') return Promise.reject(new Error(`unexpected getProduct ${id}`))
      return Promise.resolve({ ...recordB })
    })
    view.productPanel.productId.value = ''
    view.productPanel.productItemNumber.value = 'PN-B'
    view.productPanel.itemType.value = 'Part'

    await view.productPanel.loadProduct()
    await nextTick()

    expect(handles.getProduct).toHaveBeenCalledTimes(1)
    expect(handles.getProduct).toHaveBeenCalledWith('PN-B', {
      itemType: 'Part',
      itemNumber: 'PN-B',
    })
    expect(view.productPanel.productId.value).toBe('B')
    expect(view.productPanel.productItemNumber.value).toBe('PN-B')
    expect(view.productPanel.itemType.value).toBe('Part')
    expect(view.productPanel.product.value).toEqual(expect.objectContaining({
      id: 'B',
      name: 'Product B',
      partNumber: 'PN-B',
      itemType: 'Part',
    }))
    expect(view.productPanel.productView.value).toEqual(expect.objectContaining({
      partNumber: 'PN-B',
      itemType: 'Part',
    }))
    expect(view.productPanel.productLoading.value).toBe(false)
    expect(view.productPanel.productError.value).toBe('')
    expect(view.productPanel.productMetadataError.value).toBe('')
    expect(view.productPanel.productMetadataRows.value).toEqual([
      expect.objectContaining({ name: 'name', currentValue: 'Product B' }),
    ])
    expect(handles.getMetadata).toHaveBeenCalledTimes(1)
    expect(handles.getMetadata).toHaveBeenCalledWith('Part')
    expect(handles.getBom).toHaveBeenCalledTimes(1)
    expect(handles.getBom).toHaveBeenCalledWith('B', { depth: 2, effectiveAt: undefined })
    expect(handles.listDocuments).toHaveBeenCalledTimes(1)
    expect(handles.listDocuments).toHaveBeenCalledWith({ productId: 'B', role: undefined })
    expect(handles.listApprovals).toHaveBeenCalledTimes(1)
    expect(handles.listApprovals).toHaveBeenCalledWith({ productId: 'B', status: 'pending' })
    expect(handles.routerReplace.mock.calls.length).toBeGreaterThanOrEqual(2)
    const lastRouterPatch = handles.routerReplace.mock.calls[handles.routerReplace.mock.calls.length - 1]
    expect(JSON.stringify(lastRouterPatch)).toContain('"B"')
    expect(view.handleAuthError).not.toHaveBeenCalled()
    expect(handles.apiFetch).not.toHaveBeenCalled()
  })
})
describe('PlmProductView already-dispatched BOM child-read ownership', () => {
  const lineC = [{
    id: 'C-L',
    parent_item_id: 'C',
    component_id: 'C-leaf',
    component_code: 'C-LEAF',
    quantity: 1,
  }]
  const lineA = [{
    id: 'A-L',
    parent_item_id: 'A',
    component_id: 'A-leaf',
    component_code: 'A-LEAF',
    quantity: 1,
  }]
  const lineB = [{
    id: 'B-L',
    parent_item_id: 'B',
    component_id: 'B-leaf',
    component_code: 'B-LEAF',
    quantity: 1,
  }]
  const depth1Items = [{
    id: 'B-S',
    parent_item_id: 'B',
    component_id: 'S',
    component_code: 'S',
    quantity: 1,
  }]
  const depth2Items = [
    {
      id: 'B-S',
      parent_item_id: 'B',
      component_id: 'S',
      component_code: 'S',
      quantity: 1,
    },
    {
      id: 'S-leaf',
      parent_item_id: 'S',
      component_id: 'S-leaf',
      component_code: 'S-LEAF',
      quantity: 1,
    },
  ]

  function searchItemA(): SearchItem {
    return {
      id: recordA.id,
      name: recordA.name,
      partNumber: recordA.partNumber,
      itemType: recordA.itemType,
    }
  }

  async function drainChildDispatch() {
    await Promise.resolve()
    await nextTick()
  }

  async function seedRetainedC() {
    handles.getBom.mockImplementation(async (productId: string) => ({
      productId,
      items: productId === 'C' ? lineC : [],
      total: productId === 'C' ? lineC.length : 0,
    }))
    const view = await mountOwnedView()
    await view.seedAcceptedC()
    expect(view.bomPanel.bomItems.value).toEqual(lineC)
    expect(view.bomPanel.bomError.value).toBe('')
    expect(view.bomPanel.bomLoading.value).toBe(false)
    expect(handles.apiFetch).not.toHaveBeenCalled()
    return view
  }

  it('keeps newer B BOM when an already dispatched A BOM resolves afterward', async () => {
    const view = await mountOwnedView()
    const productA = deferred<ProductRecord>()
    const productB = deferred<ProductRecord>()
    const bomA = deferred<PlmListResponse<BomLineRecord>>()
    const bomB = deferred<PlmListResponse<BomLineRecord>>()
    handles.getProduct.mockImplementation((id: string) => {
      if (id === 'A') return productA.promise
      if (id === 'B') return productB.promise
      return Promise.reject(new Error(`unexpected getProduct ${id}`))
    })
    handles.getBom.mockImplementation((productId: string) => {
      if (productId === 'A') return bomA.promise
      if (productId === 'B') return bomB.promise
      return Promise.reject(new Error(`unexpected getBom ${productId}`))
    })

    const pendingA = view.searchPanel.applySearchItem(searchItemA())
    expect(handles.getProduct).toHaveBeenCalledWith('A', { itemType: 'Part', itemNumber: 'PN-A' })
    productA.resolve({ ...recordA })
    await drainChildDispatch()
    expect(handles.getBom).toHaveBeenCalledTimes(1)
    expect(handles.getBom).toHaveBeenCalledWith('A', { depth: 2, effectiveAt: undefined })

    const pendingB = view.searchPanel.applySearchItem({ ...searchItemB })
    expect(handles.getProduct).toHaveBeenCalledWith('B', { itemType: 'Part', itemNumber: 'PN-B' })
    productB.resolve({ ...recordB })
    await drainChildDispatch()
    expect(handles.getBom).toHaveBeenCalledTimes(2)
    expect(handles.getBom).toHaveBeenNthCalledWith(1, 'A', { depth: 2, effectiveAt: undefined })
    expect(handles.getBom).toHaveBeenNthCalledWith(2, 'B', { depth: 2, effectiveAt: undefined })

    bomB.resolve({ productId: 'B', items: lineB, total: lineB.length })
    await drainChildDispatch()
    expect(view.bomPanel.bomItems.value).toEqual(lineB)
    expect(view.bomPanel.bomLoading.value).toBe(false)
    expect(view.bomPanel.bomError.value).toBe('')
    expect(view.handleAuthError).not.toHaveBeenCalled()

    bomA.resolve({ productId: 'A', items: lineA, total: lineA.length })
    await drainChildDispatch()
    expect(view.bomPanel.bomItems.value).toEqual(lineB)
    expect(view.bomPanel.productId.value).toBe('B')
    expect(view.bomPanel.bomLoading.value).toBe(false)
    expect(view.bomPanel.bomError.value).toBe('')
    expect(view.handleAuthError).not.toHaveBeenCalled()
    expect(handles.apiFetch).not.toHaveBeenCalled()
    await pendingA
    await pendingB
  })

  it('suppresses A BOM success while selected B product is pending, then keeps C after B product failure', async () => {
    const view = await seedRetainedC()
    const productA = deferred<ProductRecord>()
    const productB = deferred<ProductRecord>()
    const bomA = deferred<PlmListResponse<BomLineRecord>>()
    handles.getProduct.mockImplementation((id: string) => {
      if (id === 'A') return productA.promise
      if (id === 'B') return productB.promise
      return Promise.reject(new Error(`unexpected getProduct ${id}`))
    })
    handles.getBom.mockImplementation((productId: string) => {
      if (productId === 'A') return bomA.promise
      return Promise.reject(new Error(`unexpected getBom ${productId}`))
    })

    const pendingA = view.searchPanel.applySearchItem(searchItemA())
    productA.resolve({ ...recordA })
    await drainChildDispatch()
    expect(handles.getBom).toHaveBeenCalledTimes(1)
    expect(handles.getBom).toHaveBeenCalledWith('A', { depth: 2, effectiveAt: undefined })
    expect(view.productPanel.product.value).toEqual(expect.objectContaining({ id: 'A' }))

    const pendingB = view.searchPanel.applySearchItem({ ...searchItemB })
    expect(handles.getProduct).toHaveBeenCalledWith('B', { itemType: 'Part', itemNumber: 'PN-B' })
    expect(view.bomPanel.productId.value).toBe('B')
    expect(handles.getBom).toHaveBeenCalledTimes(1)

    bomA.resolve({ productId: 'A', items: lineA, total: lineA.length })
    await drainChildDispatch()
    expect(view.bomPanel.productId.value).toBe('B')
    expect(view.bomPanel.bomItems.value).toEqual(lineC)
    expect(view.bomPanel.bomError.value).toBe('')
    expect(view.bomPanel.bomLoading.value).toBe(false)
    expect(view.handleAuthError).not.toHaveBeenCalled()
    expect(handles.getBom).toHaveBeenCalledTimes(1)

    const productFailure = new Error('current B product failed')
    productB.reject(productFailure)
    await pendingB
    await pendingA
    await nextTick()
    expect(handles.getBom).toHaveBeenCalledTimes(1)
    expect(handles.getBom).toHaveBeenCalledWith('A', { depth: 2, effectiveAt: undefined })
    expect(view.productPanel.productId.value).toBe('B')
    expect(view.productPanel.product.value).toEqual(expect.objectContaining({ id: 'A' }))
    expect(view.productPanel.productError.value).toBe('current B product failed')
    expect(view.bomPanel.bomItems.value).toEqual(lineC)
    expect(view.bomPanel.bomError.value).toBe('')
    expect(view.bomPanel.bomLoading.value).toBe(false)
    expect(view.handleAuthError).toHaveBeenCalledTimes(1)
    expect(view.handleAuthError).toHaveBeenCalledWith(productFailure)
    expect(handles.apiFetch).not.toHaveBeenCalled()
  })

  it('keeps newer same-id depth 2 BOM when the older depth 1 response resolves afterward', async () => {
    const view = await mountOwnedView()
    const productB1 = deferred<ProductRecord>()
    const productB2 = deferred<ProductRecord>()
    const bomDepth1 = deferred<PlmListResponse<BomLineRecord>>()
    const bomDepth2 = deferred<PlmListResponse<BomLineRecord>>()
    let productCalls = 0
    let bomCalls = 0
    handles.getProduct.mockImplementation((id: string) => {
      if (id !== 'B') return Promise.reject(new Error(`unexpected getProduct ${id}`))
      productCalls += 1
      if (productCalls === 1) return productB1.promise
      if (productCalls === 2) return productB2.promise
      return Promise.reject(new Error(`unexpected getProduct ${id}`))
    })
    handles.getBom.mockImplementation((productId: string) => {
      if (productId !== 'B') return Promise.reject(new Error(`unexpected getBom ${productId}`))
      bomCalls += 1
      if (bomCalls === 1) return bomDepth1.promise
      if (bomCalls === 2) return bomDepth2.promise
      return Promise.reject(new Error(`unexpected getBom ${productId}`))
    })

    view.bomPanel.bomDepth.value = 1
    const pendingB1 = view.searchPanel.applySearchItem({ ...searchItemB })
    productB1.resolve({ ...recordB })
    await drainChildDispatch()
    expect(handles.getBom).toHaveBeenNthCalledWith(1, 'B', { depth: 1, effectiveAt: undefined })

    const pendingB2 = view.searchPanel.applySearchItem({ ...searchItemB })
    view.bomPanel.bomDepth.value = 2
    productB2.resolve({ ...recordB })
    await drainChildDispatch()
    expect(handles.getProduct).toHaveBeenCalledTimes(2)
    expect(handles.getProduct).toHaveBeenNthCalledWith(1, 'B', { itemType: 'Part', itemNumber: 'PN-B' })
    expect(handles.getProduct).toHaveBeenNthCalledWith(2, 'B', { itemType: 'Part', itemNumber: 'PN-B' })
    expect(handles.getBom).toHaveBeenCalledTimes(2)
    expect(handles.getBom).toHaveBeenNthCalledWith(2, 'B', { depth: 2, effectiveAt: undefined })

    bomDepth2.resolve({ productId: 'B', items: depth2Items, total: depth2Items.length })
    await drainChildDispatch()
    expect(view.bomPanel.bomItems.value).toEqual(depth2Items)
    expect(view.bomPanel.bomLoading.value).toBe(false)
    const visibleAfterNewer = JSON.parse(JSON.stringify(view.bomPanel.bomTreeVisibleRows.value))

    bomDepth1.resolve({ productId: 'B', items: depth1Items, total: depth1Items.length })
    await drainChildDispatch()
    expect(view.bomPanel.bomItems.value).toEqual(depth2Items)
    expect(JSON.parse(JSON.stringify(view.bomPanel.bomTreeVisibleRows.value))).toEqual(visibleAfterNewer)
    expect(view.bomPanel.productId.value).toBe('B')
    expect(view.bomPanel.bomError.value).toBe('')
    expect(view.bomPanel.bomLoading.value).toBe(false)
    expect(view.handleAuthError).not.toHaveBeenCalled()
    expect(handles.apiFetch).not.toHaveBeenCalled()
    await pendingB1
    await pendingB2
  })

  it('drops a stale A BOM rejection while selected B product is pending, then settles B', async () => {
    const view = await seedRetainedC()
    const productA = deferred<ProductRecord>()
    const productB = deferred<ProductRecord>()
    const bomA = deferred<PlmListResponse<BomLineRecord>>()
    handles.getProduct.mockImplementation((id: string) => {
      if (id === 'A') return productA.promise
      if (id === 'B') return productB.promise
      return Promise.reject(new Error(`unexpected getProduct ${id}`))
    })
    handles.getBom.mockImplementation((productId: string) => {
      if (productId === 'A') return bomA.promise
      return Promise.reject(new Error(`unexpected getBom ${productId}`))
    })

    const pendingA = view.searchPanel.applySearchItem(searchItemA())
    productA.resolve({ ...recordA })
    await drainChildDispatch()
    expect(handles.getBom).toHaveBeenCalledTimes(1)
    expect(handles.getBom).toHaveBeenCalledWith('A', { depth: 2, effectiveAt: undefined })

    const pendingB = view.searchPanel.applySearchItem({ ...searchItemB })
    expect(view.bomPanel.productId.value).toBe('B')
    expect(handles.getBom).toHaveBeenCalledTimes(1)

    const staleBomError = new Error('stale A bom')
    bomA.reject(staleBomError)
    await drainChildDispatch()
    expect(view.bomPanel.bomItems.value).toEqual(lineC)
    expect(view.bomPanel.bomError.value).toBe('')
    expect(view.bomPanel.bomLoading.value).toBe(false)
    expect(view.handleAuthError).not.toHaveBeenCalled()
    expect(handles.getBom).toHaveBeenCalledTimes(1)

    const productFailure = new Error('current B product failed')
    productB.reject(productFailure)
    await pendingB
    await pendingA
    await nextTick()
    expect(handles.getBom).toHaveBeenCalledTimes(1)
    expect(handles.getBom).toHaveBeenCalledWith('A', { depth: 2, effectiveAt: undefined })
    expect(view.productPanel.productId.value).toBe('B')
    expect(view.productPanel.product.value).toEqual(expect.objectContaining({ id: 'A' }))
    expect(view.productPanel.productError.value).toBe('current B product failed')
    expect(view.bomPanel.bomItems.value).toEqual(lineC)
    expect(view.bomPanel.bomError.value).toBe('')
    expect(view.bomPanel.bomLoading.value).toBe(false)
    expect(view.handleAuthError).toHaveBeenCalledTimes(1)
    expect(view.handleAuthError).toHaveBeenCalledWith(productFailure)
    expect(handles.apiFetch).not.toHaveBeenCalled()
  })

  it('publishes one current B BOM refresh failure and keeps the previous B items', async () => {
    const view = await mountOwnedView()
    const productB = deferred<ProductRecord>()
    const bomOk = deferred<PlmListResponse<BomLineRecord>>()
    const bomFail = deferred<PlmListResponse<BomLineRecord>>()
    let bomCalls = 0
    handles.getProduct.mockImplementation((id: string) => {
      if (id === 'B') return productB.promise
      return Promise.reject(new Error(`unexpected getProduct ${id}`))
    })
    handles.getBom.mockImplementation((productId: string) => {
      if (productId !== 'B') return Promise.reject(new Error(`unexpected getBom ${productId}`))
      bomCalls += 1
      if (bomCalls === 1) return bomOk.promise
      if (bomCalls === 2) return bomFail.promise
      return Promise.reject(new Error(`unexpected getBom ${productId}`))
    })

    const pendingB = view.searchPanel.applySearchItem({ ...searchItemB })
    productB.resolve({ ...recordB })
    await drainChildDispatch()
    expect(handles.getBom).toHaveBeenCalledTimes(1)
    expect(handles.getBom).toHaveBeenCalledWith('B', { depth: 2, effectiveAt: undefined })
    bomOk.resolve({ productId: 'B', items: lineB, total: lineB.length })
    await drainChildDispatch()
    await pendingB
    expect(view.bomPanel.bomItems.value).toEqual(lineB)
    expect(view.bomPanel.bomError.value).toBe('')
    expect(view.bomPanel.bomLoading.value).toBe(false)
    expect(view.handleAuthError).not.toHaveBeenCalled()
    const visibleBeforeRefresh = JSON.parse(JSON.stringify(view.bomPanel.bomTreeVisibleRows.value))

    const refreshError = new Error('B bom refresh failed')
    const pendingRefresh = view.bomPanel.loadBom()
    expect(handles.getBom).toHaveBeenCalledTimes(2)
    expect(handles.getBom).toHaveBeenNthCalledWith(2, 'B', { depth: 2, effectiveAt: undefined })
    bomFail.reject(refreshError)
    await pendingRefresh
    await nextTick()
    expect(view.handleAuthError).toHaveBeenCalledTimes(1)
    expect(view.handleAuthError).toHaveBeenCalledWith(refreshError)
    expect(view.bomPanel.bomError.value).toBe('B bom refresh failed')
    expect(view.bomPanel.bomItems.value).toEqual(lineB)
    expect(JSON.parse(JSON.stringify(view.bomPanel.bomTreeVisibleRows.value))).toEqual(visibleBeforeRefresh)
    expect(view.bomPanel.bomLoading.value).toBe(false)
    expect(view.bomPanel.productId.value).toBe('B')
    expect(handles.apiFetch).not.toHaveBeenCalled()
  })

  it('keeps loading true when the older B BOM rejects while the newer B BOM is still pending', async () => {
    const view = await seedRetainedC()
    const productB1 = deferred<ProductRecord>()
    const productB2 = deferred<ProductRecord>()
    const bomB1 = deferred<PlmListResponse<BomLineRecord>>()
    const bomB2 = deferred<PlmListResponse<BomLineRecord>>()
    let productCalls = 0
    let bomCalls = 0
    handles.getProduct.mockImplementation((id: string) => {
      if (id !== 'B') return Promise.reject(new Error(`unexpected getProduct ${id}`))
      productCalls += 1
      if (productCalls === 1) return productB1.promise
      if (productCalls === 2) return productB2.promise
      return Promise.reject(new Error(`unexpected getProduct ${id}`))
    })
    handles.getBom.mockImplementation((productId: string) => {
      if (productId !== 'B') return Promise.reject(new Error(`unexpected getBom ${productId}`))
      bomCalls += 1
      if (bomCalls === 1) return bomB1.promise
      if (bomCalls === 2) return bomB2.promise
      return Promise.reject(new Error(`unexpected getBom ${productId}`))
    })

    const pendingB1 = view.searchPanel.applySearchItem({ ...searchItemB })
    productB1.resolve({ ...recordB })
    await drainChildDispatch()
    const pendingB2 = view.searchPanel.applySearchItem({ ...searchItemB })
    productB2.resolve({ ...recordB })
    await drainChildDispatch()

    const olderBomError = new Error('older B bom failed')
    bomB1.reject(olderBomError)
    await drainChildDispatch()
    expect(view.bomPanel.bomItems.value).toEqual(lineC)
    expect(view.bomPanel.bomLoading.value).toBe(true)
    expect(view.bomPanel.bomError.value).toBe('')
    expect(view.handleAuthError).not.toHaveBeenCalled()
    expect(handles.getBom).toHaveBeenCalledTimes(2)
    expect(handles.getBom).toHaveBeenNthCalledWith(1, 'B', { depth: 2, effectiveAt: undefined })
    expect(handles.getBom).toHaveBeenNthCalledWith(2, 'B', { depth: 2, effectiveAt: undefined })

    bomB2.resolve({ productId: 'B', items: lineB, total: lineB.length })
    await pendingB1
    await pendingB2
    expect(view.bomPanel.bomLoading.value).toBe(false)
    expect(view.bomPanel.bomItems.value).toEqual(lineB)
    expect(view.bomPanel.bomError.value).toBe('')
    expect(view.handleAuthError).not.toHaveBeenCalled()
    expect(handles.apiFetch).not.toHaveBeenCalled()
  })
})

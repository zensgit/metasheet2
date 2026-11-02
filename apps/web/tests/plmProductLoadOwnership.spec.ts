import { createApp, nextTick } from 'vue'
import type { App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AuthState,
  PlmProductPanelModel,
  PlmSearchPanelModel,
  ProductRecord,
  SearchItem,
} from '../src/views/plm/plmPanelModels'
import type { PlmItemMetadata } from '../src/services/PlmService'
import PlmProductView from '../src/views/PlmProductView.vue'

const handles = vi.hoisted(() => ({
  route: {
    query: {},
    path: '/plm',
    fullPath: '/plm',
  },
  productPanel: null as unknown,
  searchPanel: null as unknown,
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
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(PlmProductView)
  active = { app, container }
  app.mount(container)
  await nextTick()

  const productPanel = handles.productPanel as PlmProductPanelModel | null
  const searchPanel = handles.searchPanel as PlmSearchPanelModel | null
  const handleAuthError = handles.handleAuthError
  if (!productPanel || !searchPanel || !handleAuthError) {
    throw new Error('PlmProductView mount did not capture product panel, search panel, and handleAuthError')
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

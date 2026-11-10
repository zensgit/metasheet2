import { readFileSync } from 'node:fs'
import { afterEach, expect, test, vi } from 'vitest'
import ts from 'typescript'
import { effectScope, ref, watch } from 'vue'

const source = readFileSync(new URL('../src/views/PlmProductView.vue', import.meta.url), 'utf8')
const start = source.search(/^async function loadBomCompareSchema\(\)/m)
const end = source.search(/^async function loadSubstitutes\(\)/m)
const slice = source.slice(start, end)
const javascript = ts.transpileModule(slice, {
  compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
}).outputText
const bindingNames = [
  'compareLeftId', 'compareRightId', 'compareMode', 'compareLineKey', 'compareMaxLevels',
  'compareIncludeChildFields', 'compareIncludeSubstitutes', 'compareIncludeEffectivity',
  'compareEffectiveAt', 'compareRelationshipProps', 'compareLoading', 'compareError', 'bomCompare',
  'watch', 'syncQueryParams', 'handleAuthError', 'normalizeEffectiveAt', 'plmService',
]
const loadFactory = new Function(...bindingNames, `${javascript}\nreturn loadBomCompare`) as (...args: unknown[]) => () => Promise<void>
let scope: ReturnType<typeof effectScope> | undefined
afterEach(() => { scope?.stop(); scope = undefined })

function defer() {
  let resolve: (value: unknown) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function mount(left = 'left-1', right = 'right-2') {
  const compareLeftId = ref(left)
  const compareRightId = ref(right)
  const compareMode = ref('only_product')
  const compareLineKey = ref('find_num')
  const compareMaxLevels = ref(3)
  const compareIncludeChildFields = ref(true)
  const compareIncludeSubstitutes = ref(false)
  const compareIncludeEffectivity = ref(true)
  const compareEffectiveAt = ref('2026-11-10T08:30')
  const compareRelationshipProps = ref(' quantity , uom , , find_num ')
  const compareLoading = ref(false)
  const compareError = ref('previous-error')
  const bomCompare = ref<unknown>({ id: 'published' })
  const syncQueryParams = vi.fn()
  const handleAuthError = vi.fn()
  const normalizeEffectiveAt = vi.fn((value: string) => (value ? `normalized:${value}` : undefined))
  const calls: Array<ReturnType<typeof defer>> = []
  const plmService = { getBomCompare: vi.fn(() => { const pending = defer(); calls.push(pending); return pending.promise }) }
  scope = effectScope()
  const loadBomCompare = scope.run(() => loadFactory(
    compareLeftId, compareRightId, compareMode, compareLineKey, compareMaxLevels,
    compareIncludeChildFields, compareIncludeSubstitutes, compareIncludeEffectivity,
    compareEffectiveAt, compareRelationshipProps, compareLoading, compareError, bomCompare,
    watch, syncQueryParams, handleAuthError, normalizeEffectiveAt, plmService,
  ))
  if (!loadBomCompare) throw new Error('loadBomCompare was not registered')
  return { compareLeftId, compareRightId, compareLoading, compareError, bomCompare, syncQueryParams, handleAuthError, normalizeEffectiveAt, plmService, calls, loadBomCompare }
}

test('extracts the compare slice between the schema and substitutes anchors', () => {
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  expect(source.match(/^async function loadBomCompareSchema\(\)/gm)).toHaveLength(1)
  expect(source.match(/^async function loadSubstitutes\(\)/gm)).toHaveLength(1)
  expect(slice.startsWith('async function loadBomCompareSchema()')).toBe(true)
  expect(slice.includes('async function loadSubstitutes()')).toBe(false)
  expect(slice).toMatch(/^async function loadBomCompare\(\)/m)
})

test('current compare publishes the service result and the exact options', async () => {
  const state = mount()
  const pending = state.loadBomCompare()
  expect(state.compareLoading.value).toBe(true)
  expect(state.compareError.value).toBe('')
  expect(state.bomCompare.value).toEqual({ id: 'published' })
  expect(state.syncQueryParams).toHaveBeenCalledTimes(1)
  expect(state.syncQueryParams).toHaveBeenCalledWith({
    compareLeftId: 'left-1',
    compareRightId: 'right-2',
    compareMode: 'only_product',
    compareLineKey: 'find_num',
    compareMaxLevels: 3,
    compareIncludeChildFields: true,
    compareIncludeSubstitutes: false,
    compareIncludeEffectivity: true,
    compareEffectiveAt: '2026-11-10T08:30',
    compareRelationshipProps: ' quantity , uom , , find_num ',
  })
  expect(state.normalizeEffectiveAt).toHaveBeenCalledTimes(1)
  expect(state.normalizeEffectiveAt).toHaveBeenCalledWith('2026-11-10T08:30')
  expect(state.plmService.getBomCompare).toHaveBeenCalledTimes(1)
  expect(state.plmService.getBomCompare).toHaveBeenCalledWith({
    leftId: 'left-1',
    rightId: 'right-2',
    leftType: 'item',
    rightType: 'item',
    maxLevels: 3,
    compareMode: 'only_product',
    lineKey: 'find_num',
    includeChildFields: true,
    includeSubstitutes: false,
    includeEffectivity: true,
    includeRelationshipProps: ['quantity', 'uom', 'find_num'],
    effectiveAt: 'normalized:2026-11-10T08:30',
  })
  expect(state.handleAuthError).not.toHaveBeenCalled()
  const [call] = state.calls
  if (!call) throw new Error('expected one compare request')
  const result = { id: 'fresh' }
  call.resolve(result)
  await pending
  expect(state.bomCompare.value).toEqual(result)
  expect(state.compareLoading.value).toBe(false)
  expect(state.handleAuthError).not.toHaveBeenCalled()
})

test.each(['left', 'right'] as const)('%s id edit releases loading and ignores a stale success', async (side) => {
  const state = mount()
  const pending = state.loadBomCompare()
  const published = state.bomCompare.value
  if (side === 'left') state.compareLeftId.value = 'left-c'
  else state.compareRightId.value = 'right-c'
  expect(state.compareLoading.value).toBe(false)
  expect(state.bomCompare.value).toBe(published)
  expect(state.syncQueryParams).toHaveBeenCalledTimes(1)
  const [call] = state.calls
  if (!call) throw new Error('expected the original compare request')
  call.resolve({ id: 'stale' })
  await pending
  expect(state.bomCompare.value).toBe(published)
  expect(state.compareError.value).toBe('')
  expect(state.compareLoading.value).toBe(false)
  expect(state.handleAuthError).not.toHaveBeenCalled()
})

test.each(['left', 'right'] as const)('%s id edit ignores a stale auth failure', async (side) => {
  const state = mount()
  const pending = state.loadBomCompare()
  const published = state.bomCompare.value
  if (side === 'left') state.compareLeftId.value = 'left-c'
  else state.compareRightId.value = 'right-c'
  expect(state.compareLoading.value).toBe(false)
  state.compareError.value = 'kept-error'
  const [call] = state.calls
  if (!call) throw new Error('expected the original compare request')
  call.reject(Object.assign(new Error('session expired'), { status: 401 }))
  await pending
  expect(state.compareLoading.value).toBe(false)
  expect(state.compareError.value).toBe('kept-error')
  expect(state.bomCompare.value).toBe(published)
  expect(state.handleAuthError).not.toHaveBeenCalled()
})

test('same-tick A to C to A drops the old result even though the ids match again', async () => {
  const state = mount('A', 'B')
  const pending = state.loadBomCompare()
  const published = state.bomCompare.value
  state.compareLeftId.value = 'C'
  state.compareLeftId.value = 'A'
  expect(state.compareLeftId.value).toBe('A')
  expect(state.compareRightId.value).toBe('B')
  expect(state.compareLoading.value).toBe(false)
  expect(state.bomCompare.value).toBe(published)
  const [call] = state.calls
  if (!call) throw new Error('expected the original compare request')
  call.resolve({ id: 'stale' })
  await pending
  expect(state.bomCompare.value).toBe(published)
  expect(state.compareError.value).toBe('')
  expect(state.compareLoading.value).toBe(false)
  expect(state.handleAuthError).not.toHaveBeenCalled()
  expect(state.plmService.getBomCompare).toHaveBeenCalledTimes(1)
  expect(state.plmService.getBomCompare).toHaveBeenCalledWith(expect.objectContaining({
    leftId: 'A',
    rightId: 'B',
    leftType: 'item',
    rightType: 'item',
  }))
})

test('a newer comparison stays published when the older call settles later', async () => {
  const state = mount('A', 'B')
  const oldCall = state.loadBomCompare()
  state.compareLeftId.value = 'C'
  expect(state.compareLoading.value).toBe(false)
  const newCall = state.loadBomCompare()
  expect(state.compareLoading.value).toBe(true)
  const [older, newer] = state.calls
  if (!older || !newer) throw new Error('expected two compare requests')
  const fresh = { id: 'fresh' }
  newer.resolve(fresh)
  await newCall
  expect(state.bomCompare.value).toEqual(fresh)
  expect(state.compareLoading.value).toBe(false)
  older.resolve({ id: 'old' })
  await oldCall
  expect(state.bomCompare.value).toEqual(fresh)
  expect(state.compareError.value).toBe('')
  expect(state.compareLoading.value).toBe(false)
  expect(state.handleAuthError).not.toHaveBeenCalled()
  expect(state.syncQueryParams).toHaveBeenNthCalledWith(1, expect.objectContaining({ compareLeftId: 'A', compareRightId: 'B' }))
  expect(state.syncQueryParams).toHaveBeenNthCalledWith(2, expect.objectContaining({ compareLeftId: 'C', compareRightId: 'B' }))
  expect(state.plmService.getBomCompare).toHaveBeenNthCalledWith(1, expect.objectContaining({ leftId: 'A', rightId: 'B' }))
  expect(state.plmService.getBomCompare).toHaveBeenNthCalledWith(2, expect.objectContaining({ leftId: 'C', rightId: 'B' }))
})

test('same-id dispatch supersedes and loading stays up until the newer call settles', async () => {
  const state = mount()
  const first = state.loadBomCompare()
  const second = state.loadBomCompare()
  expect(state.plmService.getBomCompare).toHaveBeenCalledTimes(2)
  expect(state.plmService.getBomCompare).toHaveBeenNthCalledWith(1, expect.objectContaining({ leftId: 'left-1', rightId: 'right-2' }))
  expect(state.plmService.getBomCompare).toHaveBeenNthCalledWith(2, expect.objectContaining({ leftId: 'left-1', rightId: 'right-2' }))
  expect(state.compareLoading.value).toBe(true)
  const published = state.bomCompare.value
  const [older, newer] = state.calls
  if (!older || !newer) throw new Error('expected two compare requests')
  older.resolve({ id: 'old' })
  await first
  expect(state.bomCompare.value).toBe(published)
  expect(state.compareLoading.value).toBe(true)
  expect(state.handleAuthError).not.toHaveBeenCalled()
  const fresh = { id: 'fresh' }
  newer.resolve(fresh)
  await second
  expect(state.bomCompare.value).toEqual(fresh)
  expect(state.compareLoading.value).toBe(false)
})

test('a current rejection reports auth once, shows the message, and clears loading', async () => {
  const state = mount()
  const pending = state.loadBomCompare()
  const [call] = state.calls
  if (!call) throw new Error('expected one compare request')
  const error = new Error('compare down')
  call.reject(error)
  await pending
  expect(state.handleAuthError).toHaveBeenCalledTimes(1)
  expect(state.handleAuthError).toHaveBeenCalledWith(error)
  expect(state.compareError.value).toBe('compare down')
  expect(state.compareLoading.value).toBe(false)

  state.handleAuthError.mockClear()
  const again = state.loadBomCompare()
  const nameless = { status: 401 }
  const second = state.calls[1]
  if (!second) throw new Error('expected the current compare request')
  second.reject(nameless)
  await again
  expect(state.handleAuthError).toHaveBeenCalledTimes(1)
  expect(state.handleAuthError).toHaveBeenCalledWith(nameless)
  expect(state.compareError.value).toBe('BOM 对比失败')
  expect(state.compareLoading.value).toBe(false)
})

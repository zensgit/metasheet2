import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/integrations/dingtalk/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/integrations/dingtalk/client')>(),
  fetchDingTalkAppAccessToken: vi.fn().mockResolvedValue('synthetic-token'),
}))

import { DingTalkIncompleteResponseError } from '../../src/integrations/dingtalk/client'
import { fetchAllDepartments } from '../../src/directory/directory-sync'

type Row = { dept_id: string; parent_id: string | null; name: string }
const row = (id: string, parentId: string | null): Row => ({ dept_id: id, parent_id: parentId, name: 'Department ' + id })
let children: Record<string, Row[]>
let listCalls: string[]
let detailCalls: string[]

beforeEach(() => {
  children = {}
  listCalls = []
  detailCalls = []
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
    const id = String(JSON.parse(String(init?.body ?? '{}')).dept_id)
    let result: unknown
    if (input.includes('/department/listsub?')) {
      listCalls.push(id)
      result = children[id] ?? []
    } else if (input.includes('/department/get?')) {
      detailCalls.push(id)
      result = { dept_manager_userid_list: [] }
    } else {
      throw new Error('Unexpected synthetic directory request')
    }
    return { ok: true, status: 200, json: async () => ({ errcode: 0, result }) }
  }))
})

afterEach(() => vi.unstubAllGlobals())

const config = {
  appKey: 'synthetic-key', appSecret: 'synthetic-secret', rootDepartmentId: '1',
} as Parameters<typeof fetchAllDepartments>[0]

describe('directory department cycle completeness', () => {
  const cyclicCases: Array<{ label: string; graph: Record<string, Row[]>; calls: string[] }> = [
    { label: 'self-parent', graph: { '1': [row('2', '2')] }, calls: ['1', '2'] },
    { label: 'two-department cycle', graph: { '1': [row('2', '3')], '2': [row('3', '2')] }, calls: ['1', '2', '3'] },
    { label: 'longer ancestor cycle', graph: { '1': [row('2', '4')], '2': [row('3', '2')], '3': [row('4', '3')] }, calls: ['1', '2', '3', '4'] },
    { label: 'cycle through the configured root', graph: { '1': [row('2', '1')], '2': [row('1', '2')] }, calls: ['1', '2'] },
    { label: 'cycle alongside a valid branch', graph: { '1': [row('2', '1'), row('7', '8')], '7': [row('8', '7')] }, calls: ['1', '2', '7', '8'] },
  ]

  it.each(cyclicCases)('rejects $label before detail enrichment or returning an apply snapshot', async ({ graph, calls }) => {
    children = graph
    await expect(fetchAllDepartments(config, 'Synthetic root')).rejects.toBeInstanceOf(DingTalkIncompleteResponseError)
    expect(listCalls).toEqual(calls)
    expect(detailCalls).toEqual([])
  })

  it('preserves a valid non-monotonic tree and its shared ancestors', async () => {
    children = { '1': [row('9', '1'), row('3', '1')], '9': [row('2', '9')] }
    const result = await fetchAllDepartments(config, 'Synthetic root')
    expect([...result.values()].map(({ id, parentId, name }) => ({ id, parentId, name }))).toEqual([
      { id: '1', parentId: null, name: 'Synthetic root' },
      { id: '9', parentId: '1', name: 'Department 9' },
      { id: '3', parentId: '1', name: 'Department 3' },
      { id: '2', parentId: '9', name: 'Department 2' },
    ])
    expect(listCalls).toEqual(['1', '9', '3', '2'])
    expect(detailCalls).toEqual(['1', '9', '3', '2'])
  })

  it('keeps existing null and out-of-scope parent semantics without declaring a cycle', async () => {
    children = { '1': [row('2', 'outside-scope'), row('3', null)] }
    const result = await fetchAllDepartments(config, 'Synthetic root')
    expect([...result.values()].map(({ id, parentId }) => ({ id, parentId }))).toEqual([
      { id: '1', parentId: null },
      { id: '2', parentId: 'outside-scope' },
      { id: '3', parentId: null },
    ])
    expect(detailCalls).toEqual(['1', '2', '3'])
  })

  it('keeps an explicitly empty directory with its synthetic root and manager lookup', async () => {
    const result = await fetchAllDepartments(config, 'Synthetic root')
    expect([...result.values()].map(({ id, parentId, name }) => ({ id, parentId, name }))).toEqual([
      { id: '1', parentId: null, name: 'Synthetic root' },
    ])
    expect(listCalls).toEqual(['1'])
    expect(detailCalls).toEqual(['1'])
  })

  it('does not disclose cyclic department identities or names through the error', async () => {
    children = { '1': [{ dept_id: 'PRIVATE_DEPARTMENT_SENTINEL', parent_id: 'PRIVATE_DEPARTMENT_SENTINEL', name: 'PRIVATE_DEPARTMENT_NAME' }] }
    const error = await fetchAllDepartments(config, 'Synthetic root').catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(DingTalkIncompleteResponseError)
    expect((error as Error).message).toBe('Failed to read complete DingTalk departments')
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE_DEPARTMENT/)
    expect(detailCalls).toEqual([])
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DingTalkIncompleteResponseError,
  listDingTalkDepartments,
} from '../../src/integrations/dingtalk/client'

afterEach(() => vi.unstubAllGlobals())

function reply(result: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ errcode: 0, result }),
  }))
}

async function readDepartments(result: unknown) {
  reply(result)
  return listDingTalkDepartments('synthetic-token', '1')
}

const INCOMPLETE = 'Failed to read complete DingTalk departments'

describe('DingTalk department list parent identity', () => {
  it.each([
    { label: 'array', parent: [1] },
    { label: 'empty array', parent: [] },
    { label: 'object', parent: { id: 1 } },
    { label: 'true', parent: true },
    { label: 'false', parent: false },
    { label: 'fractional', parent: 1.5 },
    { label: 'negative', parent: -1 },
    { label: 'unsafe integer', parent: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects a $label parent for the whole department list', async ({ parent }) => {
    const outcome = await readDepartments([
      { dept_id: 2, parent_id: parent, name: 'Synthetic department' },
    ]).catch((error: unknown) => error)
    expect(outcome).toBeInstanceOf(DingTalkIncompleteResponseError)
    expect((outcome as Error).message).toBe(INCOMPLETE)
  })

  it('rejects a later array parent for the whole list and keeps that parent out of the error', async () => {
    const outcome = await readDepartments([
      { dept_id: 2, parent_id: 1, name: 'Synthetic department' },
      { dept_id: 3, parent_id: ['PRIVATE_PARENT_SENTINEL'], name: 'Other department' },
    ]).catch((error: unknown) => error)
    expect(outcome).toBeInstanceOf(DingTalkIncompleteResponseError)
    expect((outcome as Error).message).toBe(INCOMPLETE)
    expect((outcome as Error).message).not.toContain('PRIVATE_PARENT_SENTINEL')
    expect(JSON.stringify(outcome)).not.toContain('PRIVATE_PARENT_SENTINEL')
    expect(String(outcome)).not.toContain('PRIVATE_PARENT_SENTINEL')
  })

  it.each([
    { label: 'omitted', row: { dept_id: 2, name: 'Synthetic department' }, parentId: null },
    { label: 'null', row: { dept_id: 2, parent_id: null, name: 'Synthetic department' }, parentId: null },
    { label: 'empty string', row: { dept_id: 2, parent_id: '', name: 'Synthetic department' }, parentId: null },
    { label: 'blank string', row: { dept_id: 2, parent_id: '   ', name: 'Synthetic department' }, parentId: null },
    { label: 'trimmed out-of-scope string', row: { dept_id: '2', parent_id: ' outside-scope ', name: 'Synthetic department' }, parentId: 'outside-scope' },
    { label: 'string zero', row: { dept_id: 2, parent_id: '0', name: 'Synthetic department' }, parentId: '0' },
    { label: 'trimmed numeric string', row: { dept_id: 2, parent_id: ' 10 ', name: 'Synthetic department' }, parentId: '10' },
    { label: 'safe integer zero', row: { dept_id: 2, parent_id: 0, name: 'Synthetic department' }, parentId: '0' },
    { label: 'safe integer root', row: { dept_id: 2, parent_id: 1, name: 'Synthetic department' }, parentId: '1' },
    { label: 'max safe integer', row: { dept_id: 2, parent_id: Number.MAX_SAFE_INTEGER, name: 'Synthetic department' }, parentId: String(Number.MAX_SAFE_INTEGER) },
  ])('preserves a $label parent', async ({ row, parentId }) => {
    const entry = row
    expect(await readDepartments([entry])).toEqual([
      { id: '2', parentId, name: 'Synthetic department', order: 0, source: entry },
    ])
  })

  it.each([
    ['a bare array', (entry: Record<string, unknown>) => [entry]],
    ['a result.list array', (entry: Record<string, unknown>) => ({ list: [entry] })],
  ] as const)('keeps parent 0, trimmed name, order, and source in %s', async (_label, shape) => {
    const entry = { dept_id: 2, parent_id: 0, name: ' Synthetic department ', order: 4 }
    reply(shape(entry))
    expect(await listDingTalkDepartments('synthetic-token', '1')).toEqual([
      { id: '2', parentId: '0', name: 'Synthetic department', order: 4, source: entry },
    ])
  })

  it.each([[], { list: [] }])('keeps both documented department empty-list shapes', async (result) => {
    reply(result)
    expect(await listDingTalkDepartments('synthetic-token', '1')).toEqual([])
  })
})

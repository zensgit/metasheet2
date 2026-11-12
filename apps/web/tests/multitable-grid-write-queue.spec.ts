import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick, ref } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import { useMultitableGrid } from '../src/multitable/composables/useMultitableGrid'
import { MultitableApiClient } from '../src/multitable/api/client'
import { CELL_WRITE_SUPERSEDED } from '../src/multitable/utils/cell-write'
import type { MetaRecord } from '../src/multitable/types'

// `patchCell` sends a record's writes one at a time. The stand-in server checks every write against the record's
// version, as record-write-service does, and answers only when the test says so (a slow server).

type Change = { recordId: string; fieldId: string; value: unknown; expectedVersion: number }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

type ServerOptions = { reject?: (change: Change) => boolean; linkSummaries?: (change: Change) => Array<{ id: string; display: string }> }

function strictServer(records: MetaRecord[], page: MetaRecord[], options: ServerOptions = {}) {
  const stored = new Map(records.map((record) => [record.id, { version: record.version, data: { ...record.data } }]))
  const waiting: Array<() => void> = []
  const sent: Array<Change & { sheetId?: string }> = []
  const fetchFn = vi.fn((input: string, init?: RequestInit) => {
    const method = String(init?.method ?? 'GET')
    if (input.startsWith('/api/multitable/patch') && method === 'POST') {
      const body = JSON.parse(String(init?.body))
      const change = body.changes[0] as Change
      sent.push({ ...change, sheetId: body.sheetId })
      return new Promise<Response>((resolve) => {
        waiting.push(() => {
          const record = stored.get(change.recordId)!
          if (options.reject?.(change)) {
            resolve(json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Rejected' } }, 400))
          } else if (record.version !== change.expectedVersion) {
            resolve(json({ ok: false, error: { code: 'VERSION_CONFLICT', message: 'Changed elsewhere', serverVersion: record.version } }, 409))
          } else {
            record.version += 1
            record.data[change.fieldId] = change.value
            const linkSummaries = options.linkSummaries ? { [change.recordId]: { [change.fieldId]: options.linkSummaries(change) } } : undefined
            resolve(json({ ok: true, data: { updated: [{ recordId: change.recordId, version: record.version }], records: [{ recordId: change.recordId, data: { [change.fieldId]: change.value } }], linkSummaries } }))
          }
        })
      })
    }
    // The view's load: the page's records.
    const rows = page.map((record) => ({ ...record, data: { ...record.data } }))
    return Promise.resolve(json({ ok: true, data: { fields: FIELDS, rows, page: { offset: 0, limit: 50, total: rows.length, hasMore: false } } }))
  })
  async function tick() {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return {
    stored,
    sent,
    fetchFn,
    pending: () => waiting.length,
    /** Answer the oldest request. */
    async answer() {
      expect(waiting.length).toBeGreaterThan(0)
      waiting.shift()!()
      await tick()
    },
    /** Answer every request, also those sent meanwhile. */
    async answerAll() {
      await tick()
      while (waiting.length) {
        waiting.shift()!()
        await tick()
      }
    },
    tick,
  }
}

const FIELDS = [
  { id: 'f1', name: 'Title', type: 'string' as const },
  { id: 'f2', name: 'Notes', type: 'string' as const },
  { id: 'f_due', name: 'Due', type: 'date' as const },
  { id: 'f_qty', name: 'Qty', type: 'number' as const },
  { id: 'f_link', name: 'Parts', type: 'link' as const },
]

async function setup(records: MetaRecord[], options: ServerOptions & { server?: MetaRecord[] } = {}) {
  const server = strictServer(options.server ?? records, records, options)
  const sheetId = ref('sheet_1')
  const viewId = ref('view_1')
  const grid = useMultitableGrid({ sheetId, viewId, client: new MultitableApiClient({ fetchFn: server.fetchFn }) })
  await grid.loadViewData(0)
  expect(grid.rows.value.map((record) => record.id)).toEqual(records.map((record) => record.id))
  return { grid, server, sheetId }
}

const r1 = (): MetaRecord => ({ id: 'r1', version: 1, data: { f1: 'a', f2: 'x', f_due: '2031-01-02', f_qty: 5, f_link: ['p_a'] } })
const r2 = (): MetaRecord => ({ id: 'r2', version: 7, data: { f1: 'other', f2: '' } })
const row = (grid: ReturnType<typeof useMultitableGrid>, id = 'r1') => grid.rows.value.find((record) => record.id === id)!

describe('useMultitableGrid.patchCell — a record\'s writes go out one at a time', () => {
  beforeEach(() => {
    useLocale().setLocale('en')
  })

  it('two fields of one record left in a row: the second goes once the first is answered, with the version it returned; both are stored', async () => {
    const { grid, server } = await setup([r1()])
    const first = grid.patchCell('r1', 'f1', 'b', 1)
    const second = grid.patchCell('r1', 'f2', 'y', 1)
    expect(server.sent).toHaveLength(1)
    // Both cells show their value at once.
    expect(row(grid).data).toMatchObject({ f1: 'b', f2: 'y' })
    await server.answerAll()
    expect(await first).toBeNull()
    expect(await second).toBeNull()
    expect(server.sent.map((change) => [change.fieldId, change.expectedVersion])).toEqual([['f1', 1], ['f2', 2]])
    expect(server.stored.get('r1')).toEqual({ version: 3, data: expect.objectContaining({ f1: 'b', f2: 'y' }) })
    expect(row(grid).version).toBe(3)
    expect(grid.conflict.value).toBeNull()
    expect(grid.error.value).toBeNull()
  })

  // The four cases measured against a slow server before this change, each stored wrong there.
  it.each([
    ['typing the day 15 (each part commits)', 'f_due', ['2031-01-01', '2031-01-15']],
    ['typing the year 2032', 'f_due', ['0002-01-02', '0020-01-02', '0203-01-02', '2032-01-02']],
    ['typing the day 09 (the half-typed day commits an empty date)', 'f_due', [null, '2031-01-09']],
    ['two arrow-up presses on 5', 'f_qty', [6, 7]],
  ] as const)('%s, faster than the server answers: the value typed last is stored, with no conflict', async (_name, fieldId, commits) => {
    const { grid, server } = await setup([r1()])
    const writes = commits.map((value) => grid.patchCell('r1', fieldId, value, row(grid).version))
    await server.answerAll()
    const last = commits[commits.length - 1]
    expect(server.stored.get('r1')!.data[fieldId]).toBe(last)
    expect(row(grid).data[fieldId]).toBe(last)
    expect(grid.conflict.value).toBeNull()
    // The first goes at once; of those made while it was out, only the newest is sent.
    expect(server.sent.map((change) => change.value)).toEqual(commits.length > 1 ? [commits[0], last] : [last])
    const outcomes = await Promise.all(writes)
    expect(outcomes.filter((outcome) => outcome === CELL_WRITE_SUPERSEDED)).toHaveLength(Math.max(0, commits.length - 2))
    expect(outcomes.filter((outcome) => outcome === null)).toHaveLength(Math.min(2, commits.length))
  })

  it('a write made after the first answer reads the version it returned, and goes as given', async () => {
    const { grid, server } = await setup([r1()])
    void grid.patchCell('r1', 'f_qty', 6, row(grid).version)
    await server.answer()
    void grid.patchCell('r1', 'f_qty', 7, row(grid).version)
    await server.answerAll()
    expect(server.sent.map((change) => change.expectedVersion)).toEqual([1, 2])
    expect(server.stored.get('r1')!.data.f_qty).toBe(7)
  })

  it('a cell written again while its older write waits: the older one is never sent (superseded), and the history goes back to the value before it', async () => {
    const { grid, server } = await setup([r1()])
    const first = grid.patchCell('r1', 'f1', 'b', 1)
    const second = grid.patchCell('r1', 'f1', 'c', 1)
    const third = grid.patchCell('r1', 'f1', 'd', 1)
    expect(await second).toBe(CELL_WRITE_SUPERSEDED)
    expect(row(grid).data.f1).toBe('d')
    await server.answerAll()
    expect(await first).toBeNull()
    expect(await third).toBeNull()
    expect(server.sent.map((change) => [change.value, change.expectedVersion])).toEqual([['b', 1], ['d', 2]])
    expect(grid.editHistory.value.map((edit) => [edit.oldValue, edit.newValue])).toEqual([['a', 'b'], ['b', 'd']])
    // Nothing is left counted as in flight: undo goes to the server again.
    grid.undo()
    await server.tick()
    expect(server.sent.map((change) => change.value)).toEqual(['b', 'd', 'b'])
  })

  it('a waiting write replaced before it is sent takes over what it rolls back to: rejected, the cell goes back to the value before both', async () => {
    const { grid, server } = await setup([r1()], { reject: (change) => change.fieldId === 'f2' })
    void grid.patchCell('r1', 'f1', 'b', 1)
    void grid.patchCell('r1', 'f2', 'y', 1)
    void grid.patchCell('r1', 'f2', 'z', 1)
    await server.answerAll()
    expect(server.sent.map((change) => change.value)).toEqual(['b', 'z'])
    expect(row(grid).data).toMatchObject({ f1: 'b', f2: 'x' })
  })

  it('the answer to an older write of a cell written again meanwhile does not take the cell back to the older value', async () => {
    const { grid, server } = await setup([r1()])
    void grid.patchCell('r1', 'f1', 'b', 1)
    void grid.patchCell('r1', 'f1', 'c', 1)
    await server.answer()
    // The first answer brought f1 = 'b' back; the cell still shows 'c', which is now on its way.
    expect(server.sent).toHaveLength(2)
    expect(row(grid).data.f1).toBe('c')
    await server.answerAll()
    expect(row(grid).data.f1).toBe('c')
  })

  it('the same for link summaries: the older answer\'s summaries do not replace the newer write\'s', async () => {
    const summary = (id: string) => ({ id, display: id.toUpperCase() })
    const { grid, server } = await setup([r1()], { linkSummaries: (change) => (change.value as string[]).map(summary) })
    void grid.patchCell('r1', 'f_link', ['p_a', 'p_b'], 1, { nextLinkSummaries: [summary('p_a'), summary('p_b')] })
    void grid.patchCell('r1', 'f_link', ['p_c'], 1, { nextLinkSummaries: [summary('p_c')] })
    await server.answer()
    expect(server.sent).toHaveLength(2)
    expect(row(grid).data.f_link).toEqual(['p_c'])
    expect(grid.linkSummaries.value.r1.f_link).toEqual([summary('p_c')])
    await server.answerAll()
    expect(grid.linkSummaries.value.r1.f_link).toEqual([summary('p_c')])
  })

  it('a rejected write followed by an accepted one of the same cell: the cell ends on the second value, which is undone to the value before both', async () => {
    const { grid, server } = await setup([r1()], { reject: (change) => change.value === 'bad' })
    const first = grid.patchCell('r1', 'f1', 'bad', 1)
    const second = grid.patchCell('r1', 'f1', 'c', 1)
    await server.answer()
    expect(await first).toMatchObject({ fieldId: 'f1', attemptedValue: 'bad', code: 'VALIDATION_ERROR' })
    // Its rollback leaves the second write shown.
    expect(row(grid).data.f1).toBe('c')
    await server.answerAll()
    expect(await second).toBeNull()
    // The record did not move: the second write goes on the version given.
    expect(server.sent.map((change) => change.expectedVersion)).toEqual([1, 1])
    expect(row(grid).data.f1).toBe('c')
    expect(grid.editHistory.value.map((edit) => [edit.oldValue, edit.newValue])).toEqual([['a', 'c']])
  })

  it('both rejected: the cell goes back to the value before both', async () => {
    const { grid, server } = await setup([r1()], { reject: () => true })
    void grid.patchCell('r1', 'f1', 'b', 1)
    void grid.patchCell('r1', 'f1', 'c', 1)
    await server.answerAll()
    expect(row(grid).data.f1).toBe('a')
  })

  it('link summaries follow the same rule: replaced and rejected, they go back to the ones before the first write', async () => {
    const { grid, server } = await setup([r1()], { reject: () => true })
    grid.linkSummaries.value = { r1: { f_link: [{ id: 'p_a', display: 'A' }] } }
    void grid.patchCell('r1', 'f_link', ['p_a', 'p_b'], 1, { nextLinkSummaries: [{ id: 'p_a', display: 'A' }, { id: 'p_b', display: 'B' }] })
    void grid.patchCell('r1', 'f_link', ['p_b'], 1, { nextLinkSummaries: [{ id: 'p_b', display: 'B' }] })
    void grid.patchCell('r1', 'f_link', ['p_c'], 1, { nextLinkSummaries: [{ id: 'p_c', display: 'C' }] })
    expect(grid.linkSummaries.value.r1.f_link).toEqual([{ id: 'p_c', display: 'C' }])
    await server.answerAll()
    expect(row(grid).data.f_link).toEqual(['p_a'])
    expect(grid.linkSummaries.value.r1.f_link).toEqual([{ id: 'p_a', display: 'A' }])
  })

  it('link summaries of a replaced write: the newer one, rejected after the first is stored, goes back to the summaries stored by the first', async () => {
    const summary = (id: string) => ({ id, display: id.toUpperCase() })
    const { grid, server } = await setup([r1()], { reject: (change) => (change.value as string[]).includes('p_c') })
    void grid.patchCell('r1', 'f_link', ['p_a', 'p_b'], 1, { nextLinkSummaries: [summary('p_a'), summary('p_b')] })
    void grid.patchCell('r1', 'f_link', ['p_b'], 1, { nextLinkSummaries: [summary('p_b')] })
    void grid.patchCell('r1', 'f_link', ['p_c'], 1, { nextLinkSummaries: [summary('p_c')] })
    await server.answerAll()
    expect(server.sent.map((change) => change.value)).toEqual([['p_a', 'p_b'], ['p_c']])
    expect(row(grid).data.f_link).toEqual(['p_a', 'p_b'])
    expect(grid.linkSummaries.value.r1.f_link).toEqual([summary('p_a'), summary('p_b')])
  })

  it('a change from elsewhere between the two writes is still a conflict: the second one is not sent past it', async () => {
    const { grid, server } = await setup([r1()])
    void grid.patchCell('r1', 'f1', 'b', 1)
    const second = grid.patchCell('r1', 'f2', 'y', 1)
    // Someone else writes the record right after the first write is stored.
    const stored = server.stored.get('r1')!
    await server.answer()
    stored.version += 1
    await server.answerAll()
    expect(server.sent.map((change) => change.expectedVersion)).toEqual([1, 2])
    expect(await second).toMatchObject({ fieldId: 'f2', code: 'VERSION_CONFLICT' })
    expect(grid.conflict.value).toMatchObject({ recordId: 'r1', fieldId: 'f2', attemptedValue: 'y' })
    expect(row(grid).data.f2).toBe('x')
  })

  it('a record off the page (a deep-linked one) still goes one at a time, but keeps the version given: its copy takes a write only once it is accepted', async () => {
    const { grid, server } = await setup([r1()], { server: [r1(), { id: 'r9', version: 4, data: { f1: 'far', f2: '' } }] })
    void grid.patchCell('r9', 'f1', 'b', 4)
    const second = grid.patchCell('r9', 'f2', 'y', 4)
    expect(server.sent).toHaveLength(1)
    await server.answerAll()
    expect(server.sent.map((change) => change.expectedVersion)).toEqual([4, 4])
    expect(await second).toMatchObject({ code: 'VERSION_CONFLICT' })
  })

  it('another record\'s write is not held behind this one', async () => {
    const { grid, server } = await setup([r1(), r2()])
    void grid.patchCell('r1', 'f1', 'b', 1)
    void grid.patchCell('r2', 'f1', 'c', 7)
    expect(server.sent.map((change) => change.recordId)).toEqual(['r1', 'r2'])
    await server.answerAll()
    expect(server.stored.get('r2')!.data.f1).toBe('c')
  })

  it('undo and redo do nothing while a write waits or is out', async () => {
    const { grid, server } = await setup([r1()])
    grid.editHistory.value = [{ recordId: 'r1', fieldId: 'f2', oldValue: 'w', newValue: 'x', version: 0 }]
    grid.historyIndex.value = 0
    void grid.patchCell('r1', 'f1', 'b', 1)
    void grid.patchCell('r1', 'f1', 'c', 1)
    grid.undo()
    await server.answer()
    // The second write is out now.
    grid.undo()
    await server.tick()
    expect(server.sent.map((change) => change.value)).toEqual(['b', 'c'])
    await server.answerAll()
    grid.undo()
    await server.tick()
    expect(server.sent.map((change) => change.value)).toEqual(['b', 'c', 'b'])
  })

  it('a write that waits past a move to another sheet goes to the sheet it was made in, and does not enter the new sheet\'s history', async () => {
    const { grid, server, sheetId } = await setup([r1()])
    void grid.patchCell('r1', 'f1', 'b', 1)
    void grid.patchCell('r1', 'f2', 'y', 1)
    sheetId.value = 'sheet_2'
    await nextTick()
    await server.answerAll()
    expect(server.sent.map((change) => change.sheetId)).toEqual(['sheet_1', 'sheet_1'])
    expect(grid.editHistory.value).toEqual([])
  })
})

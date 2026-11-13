import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick, ref } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import { useMultitableGrid } from '../src/multitable/composables/useMultitableGrid'
import { MultitableApiClient } from '../src/multitable/api/client'
import { CELL_WRITE_SUPERSEDED } from '../src/multitable/utils/cell-write'
import type { MetaRecord } from '../src/multitable/types'

// `patchCell` sends a record's writes one at a time. The stand-in answers the way the real `/patch` does
// (record-write-service): it checks every write against the record's version and moves it one version on; its answer
// carries the new version and the link summaries of every link field of the record, never the field just written;
// a view load returns what it stores. It answers only when the test says so (a slow server).

type Change = { recordId: string; fieldId: string; value: unknown; expectedVersion: number }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const summary = (id: string) => ({ id, display: id.toUpperCase() })

type ServerOptions = {
  reject?: (change: Change) => boolean
  /** The version an accepted write moves the record to (the real server: one on). */
  nextVersion?: (version: number) => number
}

function strictServer(records: MetaRecord[], pageIds: string[], options: ServerOptions = {}) {
  const stored = new Map(records.map((record) => [record.id, { version: record.version, data: { ...record.data } }]))
  const waiting: Array<() => Response> = []
  const resolvers: Array<(response: Response) => void> = []
  const held: Array<() => void> = []
  const sent: Array<Change & { sheetId?: string }> = []
  const fetchFn = vi.fn((input: string, init?: RequestInit) => {
    const method = String(init?.method ?? 'GET')
    if (input.startsWith('/api/multitable/patch') && method === 'POST') {
      const body = JSON.parse(String(init?.body))
      const change = body.changes[0] as Change
      sent.push({ ...change, sheetId: body.sheetId })
      return new Promise<Response>((resolve) => {
        resolvers.push(resolve)
        waiting.push(() => {
          const record = stored.get(change.recordId)!
          if (options.reject?.(change)) return json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Rejected' } }, 400)
          if (record.version !== change.expectedVersion) {
            return json({ ok: false, error: { code: 'VERSION_CONFLICT', message: 'Changed elsewhere', serverVersion: record.version } }, 409)
          }
          record.version = options.nextVersion ? options.nextVersion(record.version) : record.version + 1
          for (const each of body.changes as Change[]) record.data[each.fieldId] = each.value
          const links = Array.isArray(record.data.f_link) ? { [change.recordId]: { f_link: (record.data.f_link as string[]).map(summary) } } : undefined
          return json({ ok: true, data: { updated: [{ recordId: change.recordId, version: record.version }], ...(links ? { linkSummaries: links } : {}) } })
        })
      })
    }
    // A view load: what the server stores for the page's records (another sheet has none of them).
    const ids = input.includes('sheetId=sheet_2') ? [] : pageIds
    const rows = ids.map((id) => ({ id, version: stored.get(id)!.version, data: { ...stored.get(id)!.data } }))
    return Promise.resolve(json({ ok: true, data: { fields: FIELDS, rows, page: { offset: 0, limit: 50, total: rows.length, hasMore: false } } }))
  })
  async function tick() {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return {
    stored,
    sent,
    fetchFn,
    tick,
    /** Answer the oldest request. */
    async answer() {
      expect(waiting.length).toBeGreaterThan(0)
      const response = waiting.shift()!()
      resolvers.shift()!(response)
      await tick()
    },
    /** Answer every request, also those sent meanwhile. */
    async answerAll() {
      await tick()
      while (waiting.length) {
        const response = waiting.shift()!()
        resolvers.shift()!(response)
        await tick()
      }
    },
    /** Store the oldest request now; its answer is on the way until `release`. */
    store() {
      const response = waiting.shift()!()
      const resolve = resolvers.shift()!
      held.push(() => resolve(response))
    },
    async release() {
      held.shift()!()
      await tick()
    },
  }
}

const FIELDS = [
  { id: 'f1', name: 'Title', type: 'string' as const },
  { id: 'f2', name: 'Notes', type: 'string' as const },
  { id: 'f3', name: 'Code', type: 'string' as const },
  { id: 'f_due', name: 'Due', type: 'date' as const },
  { id: 'f_qty', name: 'Qty', type: 'number' as const },
  { id: 'f_link', name: 'Parts', type: 'link' as const },
]

async function setup(records: MetaRecord[], options: ServerOptions & { server?: MetaRecord[] } = {}) {
  const server = strictServer(options.server ?? records, records.map((record) => record.id), options)
  const sheetId = ref('sheet_1')
  const viewId = ref('view_1')
  const grid = useMultitableGrid({ sheetId, viewId, client: new MultitableApiClient({ fetchFn: server.fetchFn }) })
  await grid.loadViewData(0)
  expect(grid.rows.value.map((record) => record.id)).toEqual(records.map((record) => record.id))
  return { grid, server, sheetId, viewId }
}

const r1 = (): MetaRecord => ({ id: 'r1', version: 1, data: { f1: 'a', f2: 'x', f3: 'k', f_due: '2031-01-02', f_qty: 5, f_link: ['p_a'] } })
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

  it('three fields of one record left within one answer, all on the version shown: each goes with the version the one before returned, and all are stored', async () => {
    const { grid, server } = await setup([r1()])
    const writes = [grid.patchCell('r1', 'f1', 'b', 1), grid.patchCell('r1', 'f2', 'y', 1), grid.patchCell('r1', 'f3', 'z', 1)]
    await server.answerAll()
    expect(await Promise.all(writes)).toEqual([null, null, null])
    expect(server.sent.map((change) => [change.fieldId, change.expectedVersion])).toEqual([['f1', 1], ['f2', 2], ['f3', 3]])
    expect(server.stored.get('r1')!.data).toMatchObject({ f1: 'b', f2: 'y', f3: 'z' })
    expect(grid.conflict.value).toBeNull()
  })

  it('a write made on the version the first answer returned, while the second is out: it goes with the version the second returns', async () => {
    const { grid, server } = await setup([r1()])
    void grid.patchCell('r1', 'f1', 'b', 1)
    void grid.patchCell('r1', 'f2', 'y', 1)
    await server.answer()
    expect(row(grid).version).toBe(2)
    const third = grid.patchCell('r1', 'f3', 'z', row(grid).version)
    await server.answerAll()
    expect(server.sent.map((change) => change.expectedVersion)).toEqual([1, 2, 3])
    expect(await third).toBeNull()
  })

  it('writes waiting behind the one out go in the order they were made', async () => {
    const { grid, server } = await setup([r1()])
    void grid.patchCell('r1', 'f1', 'b', 1)
    void grid.patchCell('r1', 'f2', 'y', 1)
    void grid.patchCell('r1', 'f3', 'z', 1)
    await server.answerAll()
    expect(server.sent.map((change) => change.fieldId)).toEqual(['f1', 'f2', 'f3'])
  })

  it('a waiting write replaced by a newer one of its cell goes last, so the undo history keeps the order of the edits', async () => {
    const { grid, server } = await setup([r1()])
    void grid.patchCell('r1', 'f1', 'b', 1)
    void grid.patchCell('r1', 'f2', 'y', 1)
    void grid.patchCell('r1', 'f3', 'z', 1)
    void grid.patchCell('r1', 'f2', 'w', 1)
    await server.answerAll()
    expect(server.sent.map((change) => [change.fieldId, change.value])).toEqual([['f1', 'b'], ['f3', 'z'], ['f2', 'w']])
    expect(grid.editHistory.value.map((edit) => edit.fieldId)).toEqual(['f1', 'f3', 'f2'])
  })

  it('a replaced write leaves nothing counted as in flight: a range write is refused while writes are out, and goes once they are answered', async () => {
    const { grid, server } = await setup([r1()])
    void grid.patchCell('r1', 'f1', 'b', 1)
    const replaced = grid.patchCell('r1', 'f2', 'y', 1)
    void grid.patchCell('r1', 'f2', 'z', 1)
    expect(await replaced).toBe(CELL_WRITE_SUPERSEDED)
    await expect(grid.patchRange([{ recordId: 'r1', fieldId: 'f3', value: 'q', expectedVersion: 1 }])).rejects.toThrow('RANGE_BUSY')
    await server.answerAll()
    let refusal: unknown = null
    const range = grid.patchRange([{ recordId: 'r1', fieldId: 'f3', value: 'q', expectedVersion: row(grid).version }]).catch((error) => { refusal = error })
    await server.answerAll()
    await range
    expect((refusal as Error | null)?.message ?? null).not.toBe('RANGE_BUSY')
  })

  it('an answer that does not move the version on (a malformed one) is not chained: the next write goes with the version given', async () => {
    const { grid, server } = await setup([r1()], { nextVersion: (version) => version })
    void grid.patchCell('r1', 'f1', 'b', 1)
    const second = grid.patchCell('r1', 'f2', 'y', 1)
    await server.answerAll()
    expect(await second).toBeNull()
    expect(server.sent.map((change) => change.expectedVersion)).toEqual([1, 1])
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

  it('the row reloaded while a newer write of the cell waits: the older answer puts the newer value back on it, which then stays once accepted', async () => {
    const { grid, server } = await setup([r1()])
    void grid.patchCell('r1', 'f1', 'b', 1)
    void grid.patchCell('r1', 'f1', 'c', 1)
    server.store()
    // A reload (a sort or filter applied, another user's new record, ...) replaces the row: it shows what is stored.
    await grid.loadViewData(0)
    expect(row(grid).data.f1).toBe('b')
    await server.release()
    expect(row(grid).data.f1).toBe('c')
    await server.answerAll()
    expect(server.stored.get('r1')!.data.f1).toBe('c')
    expect(row(grid).data.f1).toBe('c')
  })

  it.each([
    ['a reload', async (grid: ReturnType<typeof useMultitableGrid>) => { await grid.loadViewData(0) }],
    ['a realtime merge of the record', async (grid: ReturnType<typeof useMultitableGrid>, server: ReturnType<typeof strictServer>) => {
      const stored = server.stored.get('r1')!
      grid.mergeRemoteRecord({ id: 'r1', version: stored.version, data: { ...stored.data } })
    }],
  ] as const)('the row replaced by %s while a newer write of the cell waits, and that write rejected: the row goes back to the value stored', async (_name, replace) => {
    const { grid, server } = await setup([r1()], { reject: (change) => change.value === 'c' })
    void grid.patchCell('r1', 'f1', 'b', 1)
    const second = grid.patchCell('r1', 'f1', 'c', 1)
    server.store()
    await replace(grid, server)
    expect(row(grid).data.f1).toBe('b')
    await server.release()
    await server.answerAll()
    expect(await second).toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(server.stored.get('r1')!.data.f1).toBe('b')
    expect(row(grid).data.f1).toBe('b')
  })

  it('the row reloaded while a write of another field waits: once accepted, the row shows it', async () => {
    const { grid, server } = await setup([r1()])
    void grid.patchCell('r1', 'f1', 'b', 1)
    void grid.patchCell('r1', 'f2', 'y', 1)
    server.store()
    await grid.loadViewData(0)
    await server.release()
    await server.answerAll()
    expect(server.stored.get('r1')!.data.f2).toBe('y')
    expect(row(grid).data).toMatchObject({ f1: 'b', f2: 'y' })
  })

  it('the row reloaded before the server stores the one write in flight: once accepted, the row shows it', async () => {
    const { grid, server } = await setup([r1()])
    void grid.patchCell('r1', 'f2', 'y', 1)
    await grid.loadViewData(0)
    expect(row(grid).data.f2).toBe('x')
    await server.answerAll()
    expect(row(grid).data.f2).toBe('y')
  })

  it('the row reloaded before the first write is stored, while a newer write of the cell waits: the first answer shows the newer value, not its own', async () => {
    const { grid, server } = await setup([r1()])
    void grid.patchCell('r1', 'f1', 'b', 1)
    void grid.patchCell('r1', 'f1', 'c', 1)
    await grid.loadViewData(0)
    expect(row(grid).data.f1).toBe('a')
    await server.answer()
    expect(row(grid).data.f1).toBe('c')
    await server.answerAll()
    expect(row(grid).data.f1).toBe('c')
  })

  it('a write rejected after the row was reloaded: the row shows the write of another field still waiting', async () => {
    const { grid, server } = await setup([r1()], { reject: (change) => change.value === 'bad' })
    void grid.patchCell('r1', 'f1', 'bad', 1)
    void grid.patchCell('r1', 'f2', 'y', 1)
    await grid.loadViewData(0)
    expect(row(grid).data.f2).toBe('x')
    await server.answer()
    expect(row(grid).data).toMatchObject({ f1: 'a', f2: 'y' })
    await server.answerAll()
    expect(row(grid).data.f2).toBe('y')
  })

  it.each([
    ['a realtime merge', async (grid: ReturnType<typeof useMultitableGrid>, server: ReturnType<typeof strictServer>) => {
      const stored = server.stored.get('r1')!
      grid.mergeRemoteRecord({ id: 'r1', version: stored.version, data: { ...stored.data } })
    }],
    ['a reload', async (grid: ReturnType<typeof useMultitableGrid>) => { await grid.loadViewData(0) }],
  ] as const)('one write out, another user writes the cell first and %s shows their value; the write conflicts: the row keeps their value', async (_name, replace) => {
    const { grid, server } = await setup([r1()])
    const only = grid.patchCell('r1', 'f1', 'b', 1)
    const stored = server.stored.get('r1')!
    stored.version += 1
    stored.data.f1 = 'theirs'
    await replace(grid, server)
    await server.answerAll()
    expect(await only).toMatchObject({ code: 'VERSION_CONFLICT' })
    expect(row(grid).data.f1).toBe('theirs')
  })

  it('the row reloaded after another user moved the record on: an accepted write does not overwrite what the reload showed', async () => {
    const { grid, server } = await setup([r1()])
    void grid.patchCell('r1', 'f2', 'y', 1)
    server.store()
    const stored = server.stored.get('r1')!
    stored.version += 1
    stored.data.f2 = 'theirs'
    await grid.loadViewData(0)
    await server.release()
    expect(row(grid).data.f2).toBe('theirs')
  })

  it('a row reloaded from a version before another user\'s change (the reload landed after their merge) keeps its version when a write made on their version is accepted: a write made on it conflicts, and their value stays', async () => {
    const { grid, server } = await setup([r1()])
    const stored = server.stored.get('r1')!
    // Another user stores f2 = 'theirs' (version 2), and their merge reaches the grid.
    stored.version = 2
    stored.data.f2 = 'theirs'
    grid.mergeRemoteRecord({ id: 'r1', version: 2, data: { ...stored.data } })
    const first = grid.patchCell('r1', 'f1', 'b', row(grid).version)
    // A reload that read version 1, before their change, lands now.
    grid.rows.value = [r1()]
    await server.answerAll()
    expect(await first).toBeNull()
    expect(row(grid)).toMatchObject({ version: 1, data: { f1: 'b', f2: 'x' } })
    const second = grid.patchCell('r1', 'f2', 'mine', row(grid).version)
    await server.answerAll()
    expect(await second).toMatchObject({ code: 'VERSION_CONFLICT' })
    expect(server.stored.get('r1')!.data.f2).toBe('theirs')
  })

  it('a row reloaded from a version before an earlier write of the record still in its chain takes the version of the next accepted write', async () => {
    const { grid, server } = await setup([r1()])
    void grid.patchCell('r1', 'f1', 'b', 1)
    const second = grid.patchCell('r1', 'f2', 'y', 1)
    await server.answer()
    // A reload that read version 1, before the first write, lands while the second is out.
    grid.rows.value = [r1()]
    await server.answerAll()
    expect(await second).toBeNull()
    expect(row(grid).version).toBe(3)
    const third = grid.patchCell('r1', 'f3', 'z', row(grid).version)
    await server.answerAll()
    expect(await third).toBeNull()
  })

  it('a row reloaded after the write was stored and another user moved the record on keeps its newer version: the next write made on it is stored', async () => {
    const { grid, server } = await setup([r1()])
    const only = grid.patchCell('r1', 'f2', 'y', 1)
    server.store()
    const stored = server.stored.get('r1')!
    stored.version += 1
    stored.data.f3 = 'theirs'
    await grid.loadViewData(0)
    await server.release()
    expect(await only).toBeNull()
    expect(row(grid)).toMatchObject({ version: 3, data: { f2: 'y', f3: 'theirs' } })
    const next = grid.patchCell('r1', 'f1', 'b', row(grid).version)
    await server.answerAll()
    expect(await next).toBeNull()
  })

  it('an older answer brings every link field\'s summaries: a waiting link write keeps its own', async () => {
    const { grid, server } = await setup([r1()])
    grid.linkSummaries.value = { r1: { f_link: [summary('p_a')] } }
    void grid.patchCell('r1', 'f1', 'b', 1)
    void grid.patchCell('r1', 'f_link', ['p_c'], 1, { nextLinkSummaries: [summary('p_c')] })
    await server.answer()
    // The answer to the f1 write carried the stored f_link chips ([P_A]); the waiting write's stay.
    expect(row(grid).data.f_link).toEqual(['p_c'])
    expect(grid.linkSummaries.value.r1.f_link).toEqual([summary('p_c')])
    await server.answerAll()
    expect(grid.linkSummaries.value.r1.f_link).toEqual([summary('p_c')])
  })

  it('the same when the older write is of the link field itself', async () => {
    const { grid, server } = await setup([r1()])
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
    grid.linkSummaries.value = { r1: { f_link: [summary('p_a')] } }
    void grid.patchCell('r1', 'f_link', ['p_a', 'p_b'], 1, { nextLinkSummaries: [summary('p_a'), summary('p_b')] })
    void grid.patchCell('r1', 'f_link', ['p_b'], 1, { nextLinkSummaries: [summary('p_b')] })
    void grid.patchCell('r1', 'f_link', ['p_c'], 1, { nextLinkSummaries: [summary('p_c')] })
    expect(grid.linkSummaries.value.r1.f_link).toEqual([summary('p_c')])
    await server.answerAll()
    expect(row(grid).data.f_link).toEqual(['p_a'])
    expect(grid.linkSummaries.value.r1.f_link).toEqual([summary('p_a')])
  })

  it('link summaries of a replaced write: the newer one, rejected after the first is stored, goes back to the summaries stored by the first', async () => {
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

  it('a waiting write rejected as a conflict after a move to another sheet: the caller gets the failure; the new sheet shows no conflict', async () => {
    const { grid, server, sheetId } = await setup([r1()])
    void grid.patchCell('r1', 'f1', 'b', 1)
    const second = grid.patchCell('r1', 'f2', 'y', 1)
    sheetId.value = 'sheet_2'
    await nextTick()
    await server.answer()
    server.stored.get('r1')!.version += 1
    await server.answerAll()
    expect(await second).toMatchObject({ code: 'VERSION_CONFLICT' })
    expect(grid.conflict.value).toBeNull()
  })

  it('a waiting write rejected as a conflict after a move to another view of the sheet, with the record still on the page: the conflict is raised (its retry works)', async () => {
    const { grid, server, viewId } = await setup([r1()])
    void grid.patchCell('r1', 'f1', 'b', 1)
    const second = grid.patchCell('r1', 'f2', 'y', 1)
    viewId.value = 'view_2'
    await nextTick()
    await server.answer()
    server.stored.get('r1')!.version += 1
    await server.answerAll()
    expect(await second).toMatchObject({ code: 'VERSION_CONFLICT' })
    expect(grid.conflict.value).toMatchObject({ recordId: 'r1', fieldId: 'f2', attemptedValue: 'y' })
  })

  it('a waiting write rejected as a conflict after a move to another view whose page does not hold the record: no conflict is raised (its retry could not find the record)', async () => {
    const server = strictServer([r1(), r2()], ['r1', 'r2'])
    const fetchFn = vi.fn((input: string, init?: RequestInit) => {
      if (String(input).includes('viewId=view_2')) {
        const stored = server.stored.get('r2')!
        return Promise.resolve(json({ ok: true, data: { fields: FIELDS, rows: [{ id: 'r2', version: stored.version, data: { ...stored.data } }], page: { offset: 0, limit: 50, total: 1, hasMore: false } } }))
      }
      return server.fetchFn(input, init)
    })
    const viewId = ref('view_1')
    const grid = useMultitableGrid({ sheetId: ref('sheet_1'), viewId, client: new MultitableApiClient({ fetchFn }) })
    await grid.loadViewData(0)
    void grid.patchCell('r1', 'f1', 'b', 1)
    const second = grid.patchCell('r1', 'f2', 'y', 1)
    viewId.value = 'view_2'
    await nextTick()
    await server.answer()
    server.stored.get('r1')!.version += 1
    await server.answerAll()
    expect(grid.rows.value.map((record) => record.id)).toEqual(['r2'])
    expect(await second).toMatchObject({ code: 'VERSION_CONFLICT' })
    expect(grid.conflict.value).toBeNull()
  })
})

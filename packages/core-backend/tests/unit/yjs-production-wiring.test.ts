/**
 * The realtime editing closures of the server start-up code, executed.
 *
 * The three closures the start-up code hands to the record editing adapter and bridge — the record
 * access checker, the fresh field-write checker and the write-input builder — are taken from
 * src/index.ts as they are written there, compiled, and run. Only what reads the database is
 * replaced: the pool, sheet liveness, capability resolution and the per-subject scope read answer
 * from an in-memory fixture. The permission derivation, the write-forbidden predicate, the
 * read-only predicate, the per-writer field check and the error classes are the real ones.
 *
 * The first part runs the closures directly over a matrix of fields and subjects. The second part
 * puts them behind the real adapter, bridge, sync service and invalidator over a real transport.
 * The last part pins how the start-up code attaches them (text pins, labelled as such).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { fieldPermissionsOfWriters } from '../../src/collab/yjs-contribution-writers'
import type { YjsContribution } from '../../src/collab/yjs-record-bridge'
import {
  FieldWritePermissionDeniedError,
  deriveFieldPermissions,
  isFieldReadOnlyForPeople,
  isFieldWriteForbidden,
} from '../../src/multitable/permission-derivation'
import { SheetNotLiveError } from '../../src/multitable/sheet-liveness'
import { settle, until } from '../helpers/realtime-protection-harness'
import { RECORD, change, editor, sendUpdate, shared, stage, teardown, type Stage } from '../helpers/yjs-realtime-stage'

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(here, '../../src/index.ts'), 'utf8')
const TREE = ts.createSourceFile('index.ts', SOURCE, ts.ScriptTarget.Latest, true)

function findOne<T extends ts.Node>(match: (node: ts.Node) => node is T): T {
  const found: T[] = []
  const visit = (node: ts.Node): void => {
    if (match(node)) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(TREE)
  if (found.length !== 1) throw new Error(`expected exactly one match in index.ts, found ${found.length}`)
  return found[0]
}

function argumentOfCall(callee: string, index: number): string {
  const call = findOne((node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText(TREE) === callee)
  return call.arguments[index].getText(TREE)
}

const AUTH_CHECKER_TEXT = argumentOfCall('yjsWsAdapter.setAuthChecker', 0)
const FIELD_WRITE_CHECKER_TEXT = argumentOfCall('yjsWsAdapter.setFieldWriteChecker', 0)
const WRITE_INPUT_BUILDER_TEXT = findOne((node): node is ts.NewExpression => ts.isNewExpression(node) && node.expression.getText(TREE) === 'YjsRecordBridge')
  .arguments![2].getText(TREE)

/** Compiles a closure taken from the start-up code and binds the free names it uses. */
function compile<T>(closureText: string, bindings: Record<string, unknown>): T {
  const js = ts.transpileModule(`exports.__closure = ${closureText}`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  // eslint-disable-next-line no-new-func
  const factory = new Function(...Object.keys(bindings), 'exports', `${js}\nreturn exports.__closure`)
  return factory(...Object.values(bindings), {}) as T
}

interface FieldRow { id: string; name: string; type: string; property: Record<string, unknown>; order: number }
interface Subject { canRead: boolean; canEditRecord: boolean; scope: Map<string, { visible?: boolean; readOnly?: boolean }> }
interface Facts {
  fields: FieldRow[]
  live: boolean
  recordExists: boolean
  readFails: boolean
  /** Only the read of the field definitions fails; the record and the capabilities are read. */
  fieldsReadFails: boolean
  /** The record is denied to non-administrators at row level. */
  rowDenied: boolean
  /** Whether every field of the record may be read by the subject. */
  everyFieldReadable: boolean
  /** Whether the subject holds the administrator role. */
  admin: boolean
  subjects: Map<string, Subject>
  /** How often capabilities and the per-subject scope were read, per subject. */
  reads: string[]
}

const field = (id: string, property: Record<string, unknown> = {}, type = 'string'): FieldRow => ({ id, name: id, type, property, order: 0 })
const subject = (overrides: Partial<Subject> = {}): Subject => ({ canRead: true, canEditRecord: true, scope: new Map(), ...overrides })

function facts(overrides: Partial<Facts> = {}): Facts {
  return {
    fields: [field('f1'), field('f2')],
    live: true,
    recordExists: true,
    readFails: false,
    fieldsReadFails: false,
    rowDenied: false,
    everyFieldReadable: true,
    admin: false,
    subjects: new Map([['u', subject()]]),
    reads: [],
    ...overrides,
  }
}

function bindingsOf(f: Facts): Record<string, unknown> {
  const pool = {
    async query(sql: string) {
      if (f.readFails) throw new Error('connection reset')
      if (/FROM meta_records/.test(sql)) return { rows: f.recordExists ? [{ id: RECORD, sheet_id: 'sheet-1', created_by: 'u' }] : [] }
      if (/FROM meta_fields/.test(sql)) {
        if (f.fieldsReadFails) throw new Error('timeout exceeded when trying to connect')
        return { rows: f.fields }
      }
      throw new Error(`unexpected statement: ${sql}`)
    },
  }
  const subjectOf = (userId: string): Subject => f.subjects.get(userId) ?? subject({ canEditRecord: false })
  return {
    pool,
    poolManager: { get: () => pool },
    loadSheetLiveness: async () => (f.live ? 'live' : 'deleted'),
    assertSheetLive: async () => { if (!f.live) throw new SheetNotLiveError('sheet-1', 'deleted' as never) },
    resolveSheetCapabilitiesForUser: async (_query: unknown, _sheetId: string, userId: string) => {
      f.reads.push(`capabilities:${userId}`)
      return {
        capabilities: { canRead: subjectOf(userId).canRead, canEditRecord: subjectOf(userId).canEditRecord, canCreateRecord: true },
        sheetScope: undefined,
        isAdminRole: f.admin,
        permissions: [],
      }
    },
    loadFieldPermissionScopeMap: async (_query: unknown, _sheetId: string, userId: string) => {
      f.reads.push(`scope:${userId}`)
      return subjectOf(userId).scope
    },
    isRecordReadDeniedForUser: async () => {
      f.reads.push('row-denial')
      return f.rowDenied
    },
    canReadEveryYjsFieldForUser: async () => {
      f.reads.push('every-field')
      return f.everyFieldReadable
    },
    canWriteRecord: (capabilities: { canEditRecord: boolean }) => capabilities.canEditRecord,
    deriveFieldPermissions,
    isFieldReadOnlyForPeople,
    isFieldWriteForbidden,
    fieldPermissionsOfWriters,
    FieldWritePermissionDeniedError,
    SheetNotLiveError,
  }
}

type AuthChecker = (userId: string, recordId: string) => Promise<unknown>
type FieldWriteChecker = (userId: string, recordId: string, fieldIds: string[]) => Promise<boolean | 'unknown'>
type WriteInputBuilder = (recordId: string, patch: Record<string, unknown>, actorId: string, all: string[], contributions?: YjsContribution[]) => Promise<Record<string, unknown> | null>

const authCheckerOf = (f: Facts): AuthChecker => compile<AuthChecker>(AUTH_CHECKER_TEXT, bindingsOf(f))
const fieldWriteCheckerOf = (f: Facts): FieldWriteChecker => compile<FieldWriteChecker>(FIELD_WRITE_CHECKER_TEXT, bindingsOf(f))
const writeInputBuilderOf = (f: Facts): WriteInputBuilder => compile<WriteInputBuilder>(WRITE_INPUT_BUILDER_TEXT, bindingsOf(f))

async function builderVerdict(f: Facts, fieldIds: string[], actorId = 'u', contributions?: YjsContribution[]): Promise<'allow' | 'refuse' | 'null' | 'not-live'> {
  try {
    const input = await writeInputBuilderOf(f)(RECORD, Object.fromEntries(fieldIds.map((id) => [id, 'x'])), actorId, [actorId], contributions)
    return input ? 'allow' : 'null'
  } catch (error) {
    if (error instanceof FieldWritePermissionDeniedError) return 'refuse'
    if (error instanceof SheetNotLiveError) return 'not-live'
    throw error
  }
}

const scoped = (entries: Array<[string, { visible?: boolean; readOnly?: boolean }]>): Subject => subject({ scope: new Map(entries) })

/** [label, facts, fields written by subject `u`, expected answer of the fresh field-write check] */
const MATRIX: Array<[string, Facts, string[], boolean]> = [
  ['a plain field', facts(), ['f1'], true],
  ['two plain fields', facts(), ['f1', 'f2'], true],
  ['a formula field', facts({ fields: [field('f1'), field('fx', {}, 'formula')] }), ['fx'], false],
  ['a lookup field', facts({ fields: [field('fl', {}, 'lookup')] }), ['fl'], false],
  ['a field marked read-only', facts({ fields: [field('f1', { readOnly: true })] }), ['f1'], false],
  ['a hidden field', facts({ fields: [field('f1', { hidden: true })] }), ['f1'], false],
  ['a permission-hidden field', facts({ fields: [field('f1', { permissionHidden: true })] }), ['f1'], false],
  ['the mirror side of a two-way link', facts({ fields: [field('f1', { mirrorOf: 'other' }, 'link')] }), ['f1'], false],
  ['a field that is read-only for this subject', facts({ subjects: new Map([['u', scoped([['f1', { readOnly: true }]])]]) }), ['f1'], false],
  ['a field that is not visible to this subject', facts({ subjects: new Map([['u', scoped([['f1', { visible: false }]])]]) }), ['f1'], false],
  ['a subject that may not edit records', facts({ subjects: new Map([['u', subject({ canEditRecord: false })]]) }), ['f1'], false],
  ['a key that is not a field of the sheet', facts(), ['zz'], false],
  ['two fields, one read-only for this subject', facts({ subjects: new Map([['u', scoped([['f2', { readOnly: true }]])]]) }), ['f1', 'f2'], false],
  ['another field is read-only for this subject, not the one written', facts({ subjects: new Map([['u', scoped([['f2', { readOnly: true }]])]]) }), ['f1'], true],
]

describe('the closures are taken from the start-up code as written', () => {
  it('each closure is found exactly once and has the expected parameters', () => {
    expect(AUTH_CHECKER_TEXT.startsWith('async (userId, recordId) =>')).toBe(true)
    expect(FIELD_WRITE_CHECKER_TEXT.startsWith('async (userId, recordId, fieldIds) =>')).toBe(true)
    expect(WRITE_INPUT_BUILDER_TEXT.startsWith('async (recordId, patch, actorId, _allActorIds, contributions) =>')).toBe(true)
  })
})

describe('fresh field-write check of the start-up code', () => {
  it.each(MATRIX)('%s', async (_label, f, fieldIds, expected) => {
    expect(await fieldWriteCheckerOf(f)('u', RECORD, fieldIds)).toBe(expected)
  })

  it('agrees with the write-input builder on every cell: what is refused when a change arrives is refused when it is written', async () => {
    for (const [label, f, fieldIds] of MATRIX) {
      const arrival = await fieldWriteCheckerOf(f)('u', RECORD, fieldIds)
      const write = await builderVerdict(f, fieldIds)
      expect({ label, arrival, write }).toEqual({ label, arrival: write === 'allow', write })
    }
  })

  it('a deleted sheet takes no realtime write; a record that is gone takes none', async () => {
    expect(await fieldWriteCheckerOf(facts({ live: false }))('u', RECORD, ['f1'])).toBe(false)
    expect(await builderVerdict(facts({ live: false }), ['f1'])).toBe('not-live')
    expect(await fieldWriteCheckerOf(facts({ recordExists: false }))('u', RECORD, ['f1'])).toBe(false)
    expect(await builderVerdict(facts({ recordExists: false }), ['f1'])).toBe('null')
  })

  it('a read that fails is answered as unknown, never as a refusal and never as permission', async () => {
    expect(await fieldWriteCheckerOf(facts({ readFails: true }))('u', RECORD, ['f1'])).toBe('unknown')
    expect(await authCheckerOf(facts({ readFails: true }))('u', RECORD)).toBe('unknown')
  })

  it('the record is read and the field definitions are not: the record access check answers, the field-write check answers unknown', async () => {
    const f = facts({ fieldsReadFails: true })
    expect(await authCheckerOf(f)('u', RECORD)).toEqual({ canRead: true, canWrite: true, canReadAllFields: true })
    expect(await fieldWriteCheckerOf(f)('u', RECORD, ['f1'])).toBe('unknown')
  })
})

describe('record access check of the start-up code', () => {
  it('answers access for a live record, a closed answer for a deleted sheet and null for a record that is gone', async () => {
    expect(await authCheckerOf(facts())('u', RECORD)).toEqual({ canRead: true, canWrite: true, canReadAllFields: true })
    expect(await authCheckerOf(facts({ subjects: new Map([['u', subject({ canEditRecord: false })]]) }))('u', RECORD)).toMatchObject({ canRead: true, canWrite: false })
    expect(await authCheckerOf(facts({ live: false }))('u', RECORD)).toEqual({ canRead: false, canWrite: false })
    expect(await authCheckerOf(facts({ recordExists: false }))('u', RECORD)).toBeNull()
  })

  it('a record denied at row level is closed to read and write, except for an administrator', async () => {
    expect(await authCheckerOf(facts({ rowDenied: true }))('u', RECORD)).toEqual({ canRead: false, canWrite: false })
    expect(await authCheckerOf(facts({ rowDenied: true, admin: true }))('u', RECORD)).toEqual({ canRead: true, canWrite: true, canReadAllFields: true })
  })

  it('a subject that may not read every field is told so, and still has its own read and write answers', async () => {
    expect(await authCheckerOf(facts({ everyFieldReadable: false }))('u', RECORD)).toEqual({ canRead: true, canWrite: true, canReadAllFields: false })
  })

  it('a subject without read access cannot read, cannot read every field, and the field read is not consulted for it', async () => {
    const f = facts({ subjects: new Map([['u', subject({ canRead: false, canEditRecord: false })]]) })
    expect(await authCheckerOf(f)('u', RECORD)).toEqual({ canRead: false, canWrite: false, canReadAllFields: false })
    expect(f.reads).not.toContain('every-field')
    expect(f.reads).not.toContain('row-denial')
  })

  it('answers per subject: one subject may write, another only read, on the same record', async () => {
    const f = facts({ subjects: new Map([['w', subject()], ['r', subject({ canEditRecord: false })]]) })
    expect(await authCheckerOf(f)('w', RECORD)).toMatchObject({ canRead: true, canWrite: true })
    expect(await authCheckerOf(f)('r', RECORD)).toMatchObject({ canRead: true, canWrite: false })
    expect(await authCheckerOf(f)('stranger', RECORD)).toMatchObject({ canWrite: false })
  })
})

describe('write-input builder of the start-up code: every field against the actors that changed it', () => {
  const twoSubjects = (): Facts => facts({
    subjects: new Map([
      ['a', scoped([['f2', { readOnly: true }]])],
      ['b', scoped([['f1', { readOnly: true }]])],
    ]),
  })
  const by = (originId: string, actorId: string, fieldIds: string[]): YjsContribution => ({ originId, actorId, fieldIds })

  it('one actor, a field it may write: the write input is built for that actor', async () => {
    const input = await writeInputBuilderOf(facts())(RECORD, { f1: 'x' }, 'u', ['u'], [by('s1', 'u', ['f1'])])
    expect(input).toMatchObject({ sheetId: 'sheet-1', actorId: 'u', source: 'yjs-bridge' })
    expect([...(input?.changesByRecord as Map<string, unknown>).keys()]).toEqual([RECORD])
  })

  it('one actor, a forbidden field next to an allowed one: the whole write is refused', async () => {
    const f = facts({ subjects: new Map([['u', scoped([['f2', { readOnly: true }]])]]) })
    expect(await builderVerdict(f, ['f1', 'f2'], 'u', [by('s1', 'u', ['f1', 'f2'])])).toBe('refuse')
    expect(await builderVerdict(f, ['f2'], 'u', [by('s1', 'u', ['f2'])])).toBe('refuse')
    expect(await builderVerdict(f, ['f1'], 'u', [by('s1', 'u', ['f1'])])).toBe('allow')
  })

  it('two actors with different field permissions, each changing a field it may write: the write is built', async () => {
    const contributions = [by('s1', 'a', ['f1']), by('s2', 'b', ['f2'])]
    expect(await builderVerdict(twoSubjects(), ['f1', 'f2'], 'a', contributions)).toBe('allow')
    expect(await builderVerdict(twoSubjects(), ['f1', 'f2'], 'b', contributions)).toBe('allow')
  })

  it('two actors, one changed a field it may not write: the whole write is refused, whoever flushes', async () => {
    const contributions = [by('s1', 'a', ['f1']), by('s2', 'b', ['f1'])]
    expect(await builderVerdict(twoSubjects(), ['f1'], 'a', contributions)).toBe('refuse')
    expect(await builderVerdict(twoSubjects(), ['f1'], 'b', contributions)).toBe('refuse')
    const mixed = [by('s1', 'a', ['f1', 'f2']), by('s2', 'b', ['f2'])]
    expect(await builderVerdict(twoSubjects(), ['f1', 'f2'], 'b', mixed)).toBe('refuse')
  })

  it('no actor borrows the permission of another: a field is not let through because the flushing actor may write it', async () => {
    const contributions = [by('s1', 'a', ['f1']), by('s2', 'b', ['f1'])]
    // a may write f1, b may not; a flushes.
    expect(await builderVerdict(twoSubjects(), ['f1'], 'a', contributions)).toBe('refuse')
  })

  it('without contribution records every field is checked against the flushing actor', async () => {
    expect(await builderVerdict(twoSubjects(), ['f1', 'f2'], 'a')).toBe('refuse')
    expect(await builderVerdict(twoSubjects(), ['f1'], 'a')).toBe('allow')
  })

  it('reads capabilities and the per-subject scope once for the flushing actor and once for each further writer', async () => {
    const f = twoSubjects()
    await builderVerdict(f, ['f1', 'f2'], 'a', [by('s1', 'a', ['f1']), by('s2', 'b', ['f2']), by('s3', 'b', ['f2'])])
    expect(f.reads.sort()).toEqual(['capabilities:a', 'capabilities:b', 'scope:a', 'scope:b'])
    const single = facts()
    await builderVerdict(single, ['f1'], 'u', [by('s1', 'u', ['f1'])])
    expect(single.reads.sort()).toEqual(['capabilities:u', 'scope:u'])
  })

  it('a read that fails while the write input is built gives no input, as before', async () => {
    expect(await builderVerdict(facts({ readFails: true }), ['f1'])).toBe('null')
  })
})

describe('the closures of the start-up code behind the real adapter, bridge and sync service', () => {
  let current: Stage | null = null
  let world: Facts

  async function open(f: Facts): Promise<Stage> {
    world = f
    current = await stage({
      mergeWindowMs: 120,
      bridgeOptions: { deferRetryMinMs: 20, deferRetryMaxMs: 40 },
      adapterOptions: { heldUpdateRetryMs: 20 },
      wiring: {
        authChecker: (userId, recordId) => authCheckerOf(world)(userId, recordId),
        fieldWriteChecker: (userId, recordId, fieldIds) => fieldWriteCheckerOf(world)(userId, recordId, fieldIds),
        getWriteInput: (recordId, patch, actorId, all, contributions) => writeInputBuilderOf(world)(recordId, patch, actorId, all, contributions),
      },
    })
    return current
  }

  afterEach(async () => {
    if (current) await teardown(current)
    current = null
  })

  const twoSubjects = (): Facts => facts({
    subjects: new Map([
      ['a', scoped([['f2', { readOnly: true }]])],
      ['b', scoped([['f1', { readOnly: true }]])],
    ]),
  })
  const recordOf = (s: Stage): Record<string, unknown> | undefined => s.world.records.get(RECORD)

  it('a change to a field the sender may write is shared and written', async () => {
    const s = await open(facts({ subjects: new Map([['a', subject()], ['b', subject()]]) }))
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    sendUpdate(a, change(a, 'f1', 'written'))
    await until(() => b.fields().f1 === 'written' && recordOf(s)?.f1 === 'written')
    expect(s.world.patches).toHaveLength(1)
    expect(a.errors).toEqual([])
  })

  it('the field definitions cannot be read when a change arrives, the record can: the change waits, it is not refused, and it is shared and written once they can', async () => {
    const f = facts({ subjects: new Map([['a', subject()], ['b', subject()]]), fieldsReadFails: true })
    const s = await open(f)
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    sendUpdate(a, change(a, 'f1', 'held'))
    await settle(200)
    expect(b.fields().f1).toBe('one')
    expect(s.world.patches).toEqual([])
    expect(a.errors).toEqual([])
    expect(a.invalidated).toEqual([])
    f.fieldsReadFails = false
    await until(() => b.fields().f1 === 'held' && recordOf(s)?.f1 === 'held', 2000, 'the change once the field definitions can be read')
    expect(a.errors).toEqual([])
  })

  it('the field definitions cannot be read when the write is re-checked, the record can: the write waits, the document stays, nobody is told, and it is written once they can', async () => {
    const f = facts({ subjects: new Map([['a', subject()], ['b', subject()]]) })
    const s = await open(f)
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    sendUpdate(a, change(a, 'f1', 'written-later'))
    await until(() => b.fields().f1 === 'written-later')
    f.fieldsReadFails = true // inside the merge window: the re-check and the builder cannot read them
    await settle(350)
    expect(s.world.patches).toEqual([])
    expect(b.fields().f1).toBe('written-later')
    expect(a.invalidated).toEqual([])
    expect(b.invalidated).toEqual([])
    expect(s.bridge.getMetrics().flushFailureCount).toBe(0)
    f.fieldsReadFails = false
    await until(() => recordOf(s)?.f1 === 'written-later', 2000, 'the write once the field definitions can be read')
    expect(a.invalidated).toEqual([])
  })

  it('a change to a field that is read-only for the sender is refused when it arrives: not shared, not written', async () => {
    const s = await open(twoSubjects())
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    sendUpdate(a, change(a, 'f2', 'forbidden'))
    await until(() => a.errors.length === 1)
    await settle(250)
    expect(a.errors[0]).toMatchObject({ code: 'FORBIDDEN' })
    expect(shared(s).f2).toBe('two')
    expect(b.received).toEqual([])
    expect(s.world.patches).toEqual([])
    expect(b.invalidated).toEqual([])
  })

  it('two senders with different field permissions, each changing a field it may write, in one window: both are written', async () => {
    const s = await open(twoSubjects())
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    sendUpdate(a, change(a, 'f1', 'by-a'))
    sendUpdate(b, change(b, 'f2', 'by-b'))
    await until(() => recordOf(s)?.f1 === 'by-a' && recordOf(s)?.f2 === 'by-b')
    expect(s.world.patches).toHaveLength(1)
    expect(a.invalidated).toEqual([])
    expect(b.invalidated).toEqual([])
    expect(s.bridge.getMetrics().flushFailureCount).toBe(0)
  })

  it('a sender loses a field after its change was shared: the write is refused, the generation invalidated, every editor told', async () => {
    const s = await open(facts({ subjects: new Map([['a', subject()], ['b', subject()]]) }))
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    sendUpdate(a, change(a, 'f1', 'by-a'))
    sendUpdate(b, change(b, 'f2', 'by-b'))
    await until(() => shared(s).f1 === 'by-a' && shared(s).f2 === 'by-b')
    world.subjects.set('b', scoped([['f2', { readOnly: true }]]))
    await until(() => a.invalidated.length === 1 && b.invalidated.length === 1)
    expect(s.world.patches).toEqual([])
    expect(recordOf(s)).toEqual({ f1: 'one', f2: 'two' })
  })

  it('the reads fail when the write is re-checked: nothing is lost, and it is written once they answer', async () => {
    const s = await open(facts({ subjects: new Map([['a', subject()]]) }))
    const a = await editor(s, 'a')
    sendUpdate(a, change(a, 'f1', 'kept'))
    await until(() => shared(s).f1 === 'kept')
    world.readFails = true
    await settle(350)
    expect(a.invalidated).toEqual([])
    expect(s.world.patches).toEqual([])
    expect(shared(s).f1).toBe('kept')
    world.readFails = false
    await until(() => recordOf(s)?.f1 === 'kept')
    expect(a.errors).toEqual([])
  })
})

describe('how the start-up code attaches them (text pins)', () => {
  const position = (text: string): number => {
    expect(SOURCE.split(text), text).toHaveLength(2)
    return SOURCE.indexOf(text)
  }

  it('the field-write checker, the contribution re-check and realtime protection are attached before the namespace is registered', () => {
    const register = position('yjsWsAdapter.register(collabIO)')
    expect(position('yjsWsAdapter.setFieldWriteChecker(')).toBeLessThan(register)
    expect(position('yjsBridge.setContributionChecker((recordId, contribution) => yjsWsAdapter.checkContribution(recordId, contribution))')).toBeLessThan(register)
    expect(position('yjsWsAdapter.setRealtimeProtection(this.realtimeProtection.protection, this.realtimeProtection.connections)')).toBeLessThan(register)
    expect(position('yjsWsAdapter.setBridge(yjsBridge)')).toBeLessThan(register)
  })

  it('realtime protection is created and started before the collaboration server accepts connections, and the record editing namespace comes after', () => {
    const created = position('this.realtimeProtection = createProductionRealtimeProtection()')
    const attached = position('collabService.setRealtimeProtection(this.realtimeProtection.protection, this.realtimeProtection.connections)')
    const started = position('await this.realtimeProtection.protection.start()')
    const initialized = position('collabService.initialize(this.httpServer)')
    expect([created, attached, started, initialized].every((value, index, all) => index === 0 || all[index - 1] < value)).toBe(true)
    expect(initialized).toBeLessThan(position('yjsWsAdapter.register(collabIO)'))
  })
})

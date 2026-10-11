import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  loadCensusSources,
  runFenceHolderCensus,
  type CensusSource,
} from '../utils/fence-holder-census'
import {
  checkViewMutationLedger,
  collectViewMutationCensus,
  type ViewMutationDisposition,
} from '../utils/recovery-archive-view-mutation-census'

const sources = loadCensusSources(resolve('src'))
const actual = collectViewMutationCensus(sources)
const ledger = JSON.parse(readFileSync(resolve('tests/fixtures/recovery-archive/view-mutation-dispositions.json'), 'utf8')) as ViewMutationDisposition[]
const source = (text: string, rel = 'writer.ts'): CensusSource => ({ rel, text })
const sites = (text: string) => collectViewMutationCensus([source(text)])
const reviewed = (text: string): ViewMutationDisposition[] => sites(text).map(site => ({
  key: site.key, count: site.count, disposition: 'ambiguous', reason: 'Synthetic candidate identity remains unresolved.',
}))

describe('bounded recovery archive view mutation companion', () => {
  it('accounts for every current candidate/caller and exact count without stale dispositions', () => {
    expect(checkViewMutationLedger(actual, ledger)).toEqual([])
    expect(actual.filter(site => site.kind === 'mutation')).toHaveLength(13)
    expect(actual.filter(site => site.kind === 'mutation').reduce((sum, site) => sum + site.count, 0)).toBe(14)
    expect(actual.filter(site => site.kind === 'caller')).toHaveLength(20)
  })

  it('includes actual finite config restore, Kysely backfill and new-sheet copy', () => {
    for (const file of ['multitable/config-restore.ts', 'multitable/copy-sheet-service.ts',
      'db/migrations/zzzz20260321124000_add_meta_view_config.ts']) {
      expect(actual.some(site => site.kind === 'mutation' && site.file === file)).toBe(true)
    }
    expect(actual.some(site => site.file === 'routes/multitable-copy-sheet.ts' && site.operation.endsWith('#executeCopySheet'))).toBe(true)
  })

  it('keeps each known inherited leaf and template fallback distinct', () => {
    const calls = actual.filter(site => site.file === 'routes/univer-meta.ts' && site.kind === 'caller')
    expect(calls.filter(site => site.operation.endsWith('#applyConfigRevert'))).toHaveLength(2)
    expect(calls.filter(site => site.operation.endsWith('#dropViewCascade'))).toHaveLength(2)
    expect(calls.filter(site => site.operation.endsWith('#dropFieldCascade'))).toHaveLength(2)
    expect(calls.filter(site => site.operation.endsWith('#recreateViewFromConfig'))).toHaveLength(1)
    expect(calls.filter(site => site.operation.endsWith('#runInstall'))).toHaveLength(2)
    expect(calls.filter(site => site.operation.startsWith('callback:'))).toHaveLength(1)
  })

  it('discovers an unseeded new writer independently of unchanged holder metadata', () => {
    const before = [source('export async function legacy(q: unknown) { return 0 }')]
    const after = [...before, source('export async function unfenced(q: any) { await q("UPDATE public.meta_views SET config = $1 WHERE id = $2", []) }', 'new-writer.ts')]
    expect(collectViewMutationCensus(before)).toEqual([])
    expect(collectViewMutationCensus(after)).toHaveLength(1)
    expect(runFenceHolderCensus(after)).toEqual(runFenceHolderCensus(before))
    expect(checkViewMutationLedger(collectViewMutationCensus(after), [])).toHaveLength(1)
  })

  it('requires a new disposition even for a fenced new candidate', () => {
    const added = sites('async function fenced(q: any) { await fenceWriterEntry(q, sheetId); await q("DELETE FROM meta_views WHERE id=$1", []) }')
    expect(added).toHaveLength(1)
    expect(checkViewMutationLedger(added, [])).toEqual([`UNKNOWN_SITE:${added[0]!.key}`])
  })

  it('rejects a new unfenced caller of the existing config mutator', () => {
    const added = source("import { applyConfigRevert as undo } from './multitable/config-restore'; export async function unsafe(q: any, revision: any) { await undo(q, revision) }", 'new-caller.ts')
    const withCaller = collectViewMutationCensus([...sources, added])
    expect(withCaller.filter(site => site.file === 'new-caller.ts' && site.kind === 'caller')).toHaveLength(1)
    expect(checkViewMutationLedger(withCaller, ledger)).toEqual([expect.stringMatching(/^UNKNOWN_SITE:new-caller\.ts#unsafe#caller#/)])
  })

  it.each([
    ['UPDATE meta_views SET config=$1', 'UPDATE'],
    ['uPdAtE ONLY "public" . "meta_views" SET config=$1', 'UPDATE'],
    ['INSERT\nINTO public.meta_views(id) VALUES($1)', 'INSERT INTO'],
    ['DELETE FROM ONLY "meta_views" WHERE id=$1', 'DELETE FROM'],
    ['/* inert */ UPDATE meta_views SET config=$1', 'UPDATE'],
  ])('recognizes bounded SQL target form %s', (sql, operation) => {
    const found = sites(`async function write(q: any) { await q(${JSON.stringify(sql)}, []) }`)
    expect(found.map(site => site.operation)).toEqual([operation])
  })

  it.each([
    'const statement = "UPDATE meta_views SET config=$1"; await q(statement, [])',
    'await q(`UPDATE meta_views SET config=${value} WHERE id=$1`, [])',
    'const table = kind === "view" ? "meta_views" : "meta_fields"; await q(`UPDATE ${table} SET config=$1`, [])',
    'await q({ text: "DELETE FROM meta_views WHERE id=$1", values: [id] })',
    'const sql = "UPDATE " + "meta_views SET config=$1"; await q(sql, [])',
  ])('recognizes declared expression form %s', (body) => {
    expect(sites(`async function write(q: any) { ${body} }`).filter(site => site.kind === 'mutation')).toHaveLength(1)
  })

  it('retains otherwise unknown SQL-carrying call as ambiguous', () => {
    expect(sites('submit("UPDATE meta_views SET config=$1")')[0]?.queryIdentity).toBe('ambiguous')
  })

  it.each([
    '// q("DELETE FROM meta_views");\nconst x=0',
    'const example = "UPDATE meta_views SET config=$1"',
    'console.log("UPDATE meta_views SET config=$1")',
    'logger.warn("DELETE FROM meta_views")',
    'q("SELECT \'UPDATE meta_views SET config=$1\'")',
    'q("UPDATE meta_views_trash SET config=$1")',
    'q("UPDATE other_meta_views SET config=$1")',
    'db.schema.alterTable("meta_views").execute()',
  ])('does not mistake comments, documentation, log calls or other targets for covered DML: %s', (body) => {
    expect(sites(body)).toEqual([])
  })

  it.each(['insertInto', 'updateTable', 'deleteFrom'])('recognizes Kysely %s separately from schema DDL', (method) => {
    const found = sites(`async function up(db: any) { await db.${method}('meta_views').execute() }`)
    expect(found.map(site => site.operation)).toEqual([`KYSELY ${method}`])
  })

  it('resolves imported and local aliases to a named helper and enumerates each caller', () => {
    const found = collectViewMutationCensus([
      source('export async function mutate(q: any) { await q("UPDATE meta_views SET config=$1",[]) }', 'helper.ts'),
      source("import {mutate as imported} from './helper.js'; const local=imported; async function caller(q: any) { await local(q); await imported(q) }", 'caller.ts'),
    ])
    expect(found.filter(site => site.kind === 'caller')).toHaveLength(2)
  })

  it('resolves local helper aliases in their own lexical scope despite a later same-name alias', () => {
    const found = sites(`
      async function editView(q: any) { await q("UPDATE public.meta_views SET config=$1", []) }
      async function first(q: any) { const run=editView; await run(q) }
      async function second(q: any) { const run=other; await run(q) }
    `)
    expect(found.filter(site => site.kind === 'caller' && site.owner === 'first')).toHaveLength(1)
    expect(found.filter(site => site.kind === 'caller' && site.owner === 'second')).toHaveLength(0)
  })

  it('discovers literal CTE DELETE independently of fence seeds', () => {
    expect(sites('q("WITH marker AS (SELECT 1) DELETE FROM public.meta_views WHERE id=$1", [])')
      .map(site => site.operation)).toEqual(['DELETE FROM'])
  })

  it('keeps quoted SQL comment markers from hiding a later executable DELETE', () => {
    expect(sites(`q("SELECT '--'; DELETE FROM public.meta_views WHERE id=$1", [])`)
      .map(site => site.operation)).toEqual(['DELETE FROM'])
  })

  it('does not turn a quoted SELECT value containing a semicolon and UPDATE into DML', () => {
    expect(sites(`q("SELECT 'note; UPDATE public.meta_views SET config=1'", [])`)).toEqual([])
  })

  it('rejects a new caller of a named helper whose mutation is inside its transaction callback', () => {
    const leaf = source("export async function editView(pool) {return pool.transaction(async ({query}) => query('UPDATE public.meta_views SET name=$1', []))}", 'leaf.ts')
    const extra = source("import {editView} from './leaf'; export async function newCaller(pool) {return editView(pool)}", 'caller.ts')
    const before = collectViewMutationCensus([leaf])
    const entries: ViewMutationDisposition[] = before.map(site => ({
      key: site.key, count: site.count, disposition: 'ambiguous', reason: 'Synthetic transaction helper before adding caller.',
    }))
    expect(before.filter(site => site.kind === 'mutation')).toHaveLength(1)
    const after = collectViewMutationCensus([leaf, extra])
    expect(after.filter(site => site.kind === 'caller')).toHaveLength(1)
    expect(checkViewMutationLedger(after, entries)).toEqual([expect.stringMatching(/^UNKNOWN_SITE:caller\.ts#newCaller#caller#/)])
  })

  it('keeps an anonymous route handler containing a transaction mutation as a leaf', () => {
    const found = collectViewMutationCensus([
      source("export function routes(router, pool) {router.post('/synthetic', async () => pool.transaction(async ({query}) => query('UPDATE public.meta_views SET name=$1', [])))}", 'routes.ts'),
      source("import {routes} from './routes'; routes(router, pool)", 'registration.ts'),
    ])
    expect(found.filter(site => site.kind === 'mutation')).toHaveLength(1)
    expect(found.filter(site => site.kind === 'caller')).toHaveLength(0)
  })

  it('retains a same-name property caller as ambiguous rather than proving receiver identity', () => {
    const found = collectViewMutationCensus([
      source('export async function mutate(q: any) { await q("UPDATE meta_views SET config=$1",[]) }', 'helper.ts'),
      source('unknownReceiver.mutate(query)', 'caller.ts'),
    ])
    expect(found.find(site => site.kind === 'caller')?.queryIdentity).toBe('ambiguous')
  })

  it('discovers callback handoff and the public wrapper caller without treating route registration as a writer', () => {
    const found = collectViewMutationCensus([
      source('async function mutate(q: any) { await q("UPDATE meta_views SET config=$1",[]) } export async function wrapper(q: any) { await dedupe({ install: async () => mutate(q) }) }', 'helper.ts'),
      source("import {wrapper} from './helper'; export function routes(router: any) { router.post('/synthetic', async () => wrapper(q)) }", 'caller.ts'),
    ])
    expect(found.some(site => site.operation === 'callback:helper.ts#install')).toBe(true)
    expect(found.some(site => site.file === 'caller.ts' && site.operation === 'helper.ts#wrapper')).toBe(true)
    expect(found.some(site => site.operation === 'caller.ts#routes')).toBe(false)
  })

  it('rejects repeated same-key mutation count drift', () => {
    const one = 'async function write(q:any) { await q("UPDATE meta_views SET config=$1", []) }'
    const twice = one.replace(' }', '; await q("UPDATE meta_views SET config=$1", []) }')
    const found = sites(twice)
    expect(found).toHaveLength(1)
    expect(found[0]?.count).toBe(2)
    expect(checkViewMutationLedger(found, reviewed(one))).toEqual([`COUNT_DRIFT:${found[0]!.key}`])
  })

  it.each([
    ['query("UPDATE meta_views SET config=$1", [value])', 'otherQuery("UPDATE meta_views SET config=$1", [value])'],
    ['query("UPDATE meta_views SET config=$1", [value])', 'query("UPDATE meta_views SET config=$1", [otherValue])'],
  ])('requires review when the actual mutation receiver or argument plumbing changes', (before, after) => {
    const errors = checkViewMutationLedger(sites(after), reviewed(before))
    expect(errors).toHaveLength(2)
    expect(errors.some(error => error.startsWith('UNKNOWN_SITE:'))).toBe(true)
    expect(errors.some(error => error.startsWith('STALE_SITE:'))).toBe(true)
  })

  it('rejects stale, duplicate and invalid dispositions', () => {
    const text = 'q("DELETE FROM meta_views")'
    const entries = reviewed(text)
    expect(checkViewMutationLedger([], entries)).toEqual([`STALE_SITE:${entries[0]!.key}`])
    expect(checkViewMutationLedger(sites(text), [...entries, ...entries])).toEqual([`DUPLICATE_LEDGER:${entries[0]!.key}`])
    expect(checkViewMutationLedger(sites(text), [{ ...entries[0]!, reason: '' }])).toEqual([`INVALID_DISPOSITION:${entries[0]!.key}`])
  })
})

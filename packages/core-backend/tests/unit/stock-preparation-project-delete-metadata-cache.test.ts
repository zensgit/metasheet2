import { describe, expect, it, vi } from 'vitest'
import { tryResolveView, type MultitableViewConfig } from '../../src/multitable/loaders'
import { currentSheetMetadataEntry } from '../../src/multitable/stock-preparation-metadata-cache'

const sheetId = 'sheet_' + 'a'.repeat(24)

describe('project cleanup metadata on a second API worker', () => {
  it('rechecks the live sheet across deletion and same-ID recreation, also on workers with cleanup disabled', async () => {
    let incarnation: string | null = 'first'
    let label: string | null = 'original'
    let metadataReads = 0
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM meta_sheets')) return { rows: incarnation ? [{ incarnation }] : [] }
      expect(sql).toContain('FROM meta_views')
      metadataReads++
      return { rows: label ? [{ id: 'view', sheet_id: sheetId, type: 'grid', name: label }] : [] }
    })
    const cache = new Map<string, MultitableViewConfig>()
    const resolve = () => tryResolveView(query, 'view', cache)
    expect((await resolve())?.name).toBe('original')
    expect((await resolve())?.name).toBe('original')
    const readsBeforeHit = metadataReads
    expect((await resolve())?.name).toBe('original')
    expect(metadataReads).toBe(readsBeforeHit)
    incarnation = null
    label = null
    expect(await resolve()).toBeNull()
    incarnation = 'second'
    label = 'new default'
    expect((await resolve())?.name).toBe('new default')
  })

  it('rejects an old field list or summary reinserted after recreation by an in-flight load', async () => {
    let incarnation = 'first'
    const query = vi.fn(async () => ({ rows: [{ incarnation }] }))
    const cache = new Map<string, { name: string }>()
    const entry = () => currentSheetMetadataEntry(query, sheetId, cache, sheetId)
    const late = await entry()
    incarnation = 'second'
    const fresh = await entry()
    fresh.store({ name: 'new' })
    expect((await entry()).cached).toEqual({ name: 'new' })
    late.store({ name: 'obsolete' })
    expect((await entry()).cached).toBeUndefined()
  })

  it('keeps normal non-provisioned sheets on their existing cache path', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    const value = { name: 'ordinary' }
    const cache = new Map([['ordinary-sheet', value]])
    const { cached } = await currentSheetMetadataEntry(query, 'ordinary-sheet', cache, 'ordinary-sheet')
    expect(cached).toBe(value)
    expect(query).not.toHaveBeenCalled()
  })
})

/**
 * Tests for YjsSyncService's fresh-doc seed from meta_records.
 *
 * This closes the P0 data-overwrite vector from the 2026-04-20 review
 * of PR #960: before the fix, opening an existing text cell for the
 * first time in Yjs mode would show an empty textbox (no Y.Text yet)
 * and the first user edit would overwrite the real value in meta_records
 * with whatever they typed on top of the empty state.
 *
 * The fix: when getOrCreateDoc runs and the persistence adapter returns
 * no state, call the injected recordSeed to load the record's current
 * data and seed the Y.Doc fields map with one Y.Text per string field.
 */
import { describe, it, expect, vi } from 'vitest'
import * as Y from 'yjs'
import { YjsSyncService } from '../../src/collab/yjs-sync-service'

function makePersistence(load: Uint8Array | null = null) {
  return {
    loadDoc: vi.fn().mockResolvedValue(load),
    storeUpdate: vi.fn().mockResolvedValue(undefined),
    storeSnapshot: vi.fn().mockResolvedValue(undefined),
    compactDoc: vi.fn().mockResolvedValue(undefined),
  }
}

describe('YjsSyncService fresh-doc seed', () => {
  it('seeds Y.Text entries from meta_records.data when no Yjs state exists', async () => {
    const persistence = makePersistence(null)
    const recordSeed = vi.fn().mockResolvedValue({
      fld_title: 'existing value',
      fld_name: 'alice',
      fld_count: 42, // non-string, must NOT be seeded
    })
    const svc = new YjsSyncService(persistence as any, recordSeed)

    const doc = await svc.getOrCreateDoc('rec_1')

    expect(recordSeed).toHaveBeenCalledWith('rec_1')

    const fields = doc.getMap('fields')
    const title = fields.get('fld_title')
    const name = fields.get('fld_name')
    const count = fields.get('fld_count')

    expect(title).toBeInstanceOf(Y.Text)
    expect((title as Y.Text).toString()).toBe('existing value')
    expect(name).toBeInstanceOf(Y.Text)
    expect((name as Y.Text).toString()).toBe('alice')
    // Non-string left out of fields map on purpose — frontend only
    // binds Y.Text entries; other field types continue using REST.
    expect(count).toBeUndefined()

    await svc.destroy()
  })

  it('does NOT seed if the persistence adapter returns existing state', async () => {
    // Simulate existing Y.Doc with a different value in the snapshot.
    const primer = new Y.Doc()
    const primerFields = primer.getMap('fields')
    const primerText = new Y.Text()
    primerText.insert(0, 'persisted value')
    primerFields.set('fld_title', primerText)
    const persistedState = Y.encodeStateAsUpdate(primer)
    primer.destroy()

    const persistence = makePersistence(persistedState)
    const recordSeed = vi.fn().mockResolvedValue({
      fld_title: 'stale DB value',
    })
    const svc = new YjsSyncService(persistence as any, recordSeed)

    const doc = await svc.getOrCreateDoc('rec_1')

    expect(recordSeed).not.toHaveBeenCalled()

    const title = doc.getMap('fields').get('fld_title') as Y.Text
    expect(title).toBeInstanceOf(Y.Text)
    // Persisted Y.Doc wins — the record_seed's stale DB value would
    // have silently reverted concurrent edits.
    expect(title.toString()).toBe('persisted value')

    await svc.destroy()
  })

  it('seeding does NOT create a DB update row (origin=seed is filtered)', async () => {
    const persistence = makePersistence(null)
    const recordSeed = vi.fn().mockResolvedValue({ fld_title: 'v' })
    const svc = new YjsSyncService(persistence as any, recordSeed)

    await svc.getOrCreateDoc('rec_seed')

    // The persistence listener should skip origin='seed' so the seed
    // stays in memory; it's only written to DB on the first compact()
    // (e.g. after an actual user edit triggered a flush).
    expect(persistence.storeUpdate).not.toHaveBeenCalled()

    await svc.destroy()
  })

  it('returning null from recordSeed leaves the Y.Doc empty (no crash)', async () => {
    const persistence = makePersistence(null)
    const recordSeed = vi.fn().mockResolvedValue(null)
    const svc = new YjsSyncService(persistence as any, recordSeed)

    const doc = await svc.getOrCreateDoc('rec_missing')

    expect(doc.getMap('fields').size).toBe(0)

    await svc.destroy()
  })

  it('recordSeed throwing is caught and yields an empty Y.Doc', async () => {
    const persistence = makePersistence(null)
    const recordSeed = vi.fn().mockRejectedValue(new Error('db down'))
    const svc = new YjsSyncService(persistence as any, recordSeed)

    const doc = await svc.getOrCreateDoc('rec_err')

    expect(doc.getMap('fields').size).toBe(0)

    await svc.destroy()
  })

  it('does NOT overwrite an existing entry via seed (idempotent)', async () => {
    // Two calls to getOrCreateDoc for the same record should not
    // re-seed. First creates the doc; second returns cached.
    const persistence = makePersistence(null)
    const recordSeed = vi.fn().mockResolvedValue({ fld_title: 'first' })
    const svc = new YjsSyncService(persistence as any, recordSeed)

    const doc1 = await svc.getOrCreateDoc('rec_1')
    // User edits
    const text = doc1.getMap('fields').get('fld_title') as Y.Text
    text.delete(0, text.length)
    text.insert(0, 'edited')

    // Second getOrCreateDoc should return the same cached doc; recordSeed
    // should NOT be called again.
    const doc2 = await svc.getOrCreateDoc('rec_1')
    expect(doc2).toBe(doc1)
    expect(recordSeed).toHaveBeenCalledTimes(1)
    const stillEdited = doc2.getMap('fields').get('fld_title') as Y.Text
    expect(stillEdited.toString()).toBe('edited')

    await svc.destroy()
  })

  it('no recordSeed provided → behavior unchanged (empty Y.Doc, no error)', async () => {
    const persistence = makePersistence(null)
    // Legacy call site with no seeder — must still work.
    const svc = new YjsSyncService(persistence as any)

    const doc = await svc.getOrCreateDoc('rec_1')
    expect(doc.getMap('fields').size).toBe(0)

    await svc.destroy()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validateImportPending, type ResourceImportPending } from '../src/services/welding/resourceImportContracts'
import { WeldingResourceImportError } from '../src/services/welding/planClient'
import { EXPLICIT_SESSION_ORG_KEY } from '../src/utils/explicitSessionOrg'
import { importCrypto, importPending, importPreview, importRaw, importOwner, importReceipt, rawHash } from './utils/weldingResourceImportFixtures'
import { deferred, importHarness, importMemory } from './utils/weldingResourceImportHarness'
let dispose: Array<() => void> = [], locks: PropertyDescriptor | undefined
function setup(memory = importMemory(), count = 1) { const f = importHarness(memory, count); dispose.push(f.session.dispose); return f }
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('auth_token', 'synthetic-token'); vi.stubGlobal('crypto', importCrypto); vi.spyOn(window, 'confirm').mockReturnValue(true)
  locks = Object.getOwnPropertyDescriptor(navigator, 'locks'); const tails = new Map<string, Promise<unknown>>()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (name: string, _options: unknown, action: () => unknown) => {
    const next = (tails.get(name) ?? Promise.resolve()).catch(() => {}).then(action); tails.set(name, next); return next
  } } })
})
afterEach(() => { dispose.forEach(stop => stop()); dispose = []; vi.restoreAllMocks(); vi.unstubAllGlobals(); if (locks) Object.defineProperty(navigator, 'locks', locks); else Reflect.deleteProperty(navigator, 'locks') })
describe('owner-bound durable whole import session', () => {
  it('does not dispatch before durable claim completion; then confirms all 100 rows and only explicit fixed read', async () => {
    const f = setup(undefined, 100); await f.ready()
    const claim = deferred<boolean>(), actual = f.memory.store.claimResourceImport
    vi.mocked(f.memory.store.claimResourceImport).mockImplementationOnce(async value => { await claim.promise; return actual(value) })
    const committing = f.session.commit(); await vi.waitFor(() => expect(f.session.state.phase).toBe('saving'))
    expect(f.api.commitResourceImport).not.toHaveBeenCalled(); expect(f.session.prepareLeave()).toBe(false)
    claim.resolve(true); await committing
    expect(f.session.state.receipt?.items).toHaveLength(100); expect(f.memory.rows.size).toBe(0); expect(f.api.readResource).not.toHaveBeenCalled()
    expect(f.session.canCommit.value).toBe(false); expect(f.session.state.pending).toBeNull()
    await f.session.readItem(f.session.state.receipt!.items[0]); expect(f.session.state.detail?.resource_id).toBe('resource-2')
    expect(f.api.readResource).toHaveBeenCalledTimes(1)
  })
  it('lost ACK survives a new session without automatic preview/commit; explicit retry sends the same bytes and metadata', async () => {
    const f = setup(); await f.ready(); f.api.commitResourceImport.mockRejectedValueOnce(new Error('lost ACK'))
    await f.session.commit(); expect(f.session.state.phase).toBe('unknown'); expect(f.memory.rows.size).toBe(1)
    const saved = validateImportPending([...f.memory.rows.values()][0]); f.session.dispose()
    const reload = setup(f.memory); await reload.session.initialize()
    expect(reload.api.previewResourceImport).not.toHaveBeenCalled(); expect(reload.api.commitResourceImport).not.toHaveBeenCalled()
    expect(reload.session.state.pending?.import_id).toBe(saved.import_id)
    await reload.session.replay()
    const sent = reload.api.commitResourceImport.mock.calls[0][0]
    expect(sent).toEqual(saved); expect(new Uint8Array(sent.bytes)).toEqual(new Uint8Array(saved.bytes)); expect(reload.session.state.phase).toBe('confirmed')
  })
  it.each([403, 404, 409])('keeps the original after HTTP %s and never automatically re-previews', async status => {
    const f = setup(); await f.ready(); f.api.commitResourceImport.mockRejectedValueOnce(new WeldingResourceImportError('server rejection', status, 'DENIED'))
    await f.session.commit(); expect(f.session.state.phase).toBe('unknown'); expect(f.memory.rows.size).toBe(1); expect(f.session.state.receipt).toBeNull()
    expect(f.session.state.responseStatus).toBe(status); expect(f.session.state.responseCode).toBe('DENIED')
    expect(f.api.previewResourceImport).toHaveBeenCalledTimes(1); expect(f.api.commitResourceImport).toHaveBeenCalledTimes(1)
    await expect(f.session.selectFile(f.file())).rejects.toThrow(); expect(() => f.session.selectFormat('xlsx')).toThrow()
  })
  it('quota/claim false cause zero dispatch and preserve selected file and existing records', async () => {
    for (const error of [false, new DOMException('synthetic quota injection', 'QuotaExceededError')]) {
      const f = setup(); await f.ready(); f.memory.rows.set('other-owner', importPending())
      vi.mocked(f.memory.store.claimResourceImport).mockImplementationOnce(async () => { if (error instanceof Error) throw error; return error })
      await f.session.commit(); expect(f.api.commitResourceImport).not.toHaveBeenCalled(); expect(f.memory.rows.size).toBe(1)
      expect(f.session.state.fileName).toBe('synthetic.csv'); expect(f.session.state.preview?.ready).toBe(true); expect(f.session.state.storageBlocked).toBe(true)
    }
  })
  it('a committed claim followed by failed readback preserves the new original and sends nothing', async () => {
    const f = setup(); await f.ready(); const read = f.memory.store.getResourceImport
    vi.mocked(f.memory.store.claimResourceImport).mockImplementationOnce(async value => {
      f.memory.rows.set(JSON.stringify(value.owner), validateImportPending(value)); vi.mocked(read).mockRejectedValueOnce(new Error('readback failed')); return true
    })
    await f.session.commit(); expect(f.memory.rows.size).toBe(1); expect(f.api.commitResourceImport).not.toHaveBeenCalled(); expect(f.session.state.pending).not.toBeNull()
  })
  it('clear CAS false occurs after dispatch, remains unknown, and cannot apply confirmed receipt', async () => {
    const f = setup(); await f.ready(); vi.mocked(f.memory.store.clearResourceImport).mockResolvedValue(false)
    await f.session.commit(); expect(f.api.commitResourceImport).toHaveBeenCalledTimes(1); expect(f.session.state.phase).toBe('unknown')
    expect(f.session.state.message).toContain('已发送'); expect(f.session.state.receipt).toBeNull(); expect(f.memory.rows.size).toBe(1)
  })
  it('rejects a malformed hundredth ACK and does not clear the whole original', async () => {
    const f = setup(undefined, 100); await f.ready()
    f.api.commitResourceImport.mockImplementationOnce(async pending => { const receipt = importReceipt(pending); receipt.items[99].row_key = 'wrong'; return receipt })
    await f.session.commit(); expect(f.session.state.phase).toBe('unknown'); expect(f.session.state.receipt).toBeNull(); expect(f.memory.store.clearResourceImport).not.toHaveBeenCalled()
  })
  it('displays final-row and file issues and never dispatches not-ready subsets', async () => {
    const f = setup(undefined, 100); await f.session.initialize(); await f.session.selectFile(f.file())
    const preview = importPreview(100); preview.ready = false; preview.preview_digest = null; preview.rows.pop()
    preview.errors = [{ row: 101, column: 'name', code: 'invalid', message: 'last row invalid' }, { row: null, column: '', code: 'file', message: 'file invalid' }]
    f.api.previewResourceImport.mockResolvedValue(preview); await f.session.preview()
    expect(f.session.state.issues).toEqual(preview.errors); expect(f.session.canCommit.value).toBe(false)
    await expect(f.session.commit()).rejects.toThrow(); expect(f.api.commitResourceImport).not.toHaveBeenCalled()
  })
  it('a changed file/format rejects late File/hash/preview results, even for the same file name', async () => {
    const f = setup(); await f.session.initialize(); const reading = deferred<ArrayBuffer>()
    const old = f.session.selectFile({ name: 'same.csv', size: 8, arrayBuffer: () => reading.promise } as File)
    await f.session.selectFile(f.file(importRaw(), 'same.csv')); reading.resolve(new Uint8Array(8).buffer); await old
    expect(f.session.state.rawHash).toBe(importPreview().raw_sha256)
    const preview = deferred<ReturnType<typeof importPreview>>(); f.api.previewResourceImport.mockImplementationOnce(() => preview.promise)
    const request = f.session.preview(); await vi.waitFor(() => expect(f.api.previewResourceImport).toHaveBeenCalled())
    f.session.selectFormat('xlsx'); preview.resolve(importPreview()); await request
    expect(f.session.state.preview).toBeNull(); expect(f.session.state.format).toBe('xlsx'); expect(f.session.canCommit.value).toBe(false)
  })
  it('owner change during final authority and flags/org/dispose invalidate old ACK without clearing old-owner storage', async () => {
    for (const change of ['owner', 'flag', 'org', 'dispose']) {
      const f = setup(); await f.ready(); const ack = deferred<ReturnType<typeof importReceipt>>()
      f.api.commitResourceImport.mockImplementationOnce(() => ack.promise); const request = f.session.commit()
      await vi.waitFor(() => expect(f.api.commitResourceImport).toHaveBeenCalled())
      if (change === 'owner') f.current.owner = { ...importOwner, rbac_user_id: 20 }
      else if (change === 'flag') f.flags.writable = false
      else if (change === 'org') window.dispatchEvent(new StorageEvent('storage', { key: EXPLICIT_SESSION_ORG_KEY }))
      else f.session.dispose()
      ack.resolve(importReceipt()); await request
      expect(f.session.state.receipt).toBeNull(); expect(f.memory.rows.size).toBe(1); expect(f.memory.store.clearResourceImport).not.toHaveBeenCalled()
    }
  })
  it('two sessions retry serially; later page cannot dispatch after the first exact clear', async () => {
    const memory = importMemory(); memory.rows.set(JSON.stringify(importOwner), importPending())
    const a = setup(memory), b = setup(memory); await a.session.initialize(); await b.session.initialize()
    await Promise.all([a.session.replay(), b.session.replay()])
    expect(a.api.commitResourceImport.mock.calls.length + b.api.commitResourceImport.mock.calls.length).toBe(1)
    expect(memory.rows.size).toBe(0)
  })
  it.each([
    { format: 'csv' as const, previewed: false, differentBytes: true },
    { format: 'csv' as const, previewed: true, differentBytes: true },
    { format: 'xlsx' as const, previewed: false, differentBytes: false },
  ])('replaying another page original preserves a different selection %s', async ({ format, previewed, differentBytes }) => {
    const f = setup(), bytes = differentBytes ? new Uint8Array([...new Uint8Array(importRaw()), 2]).buffer : importRaw()
    await f.session.initialize(); f.session.selectFormat(format); await f.session.selectFile(f.file(bytes, 'later.' + format))
    if (previewed) { f.api.previewResourceImport.mockResolvedValueOnce(importPreview(1, bytes)); await f.session.preview() }
    const preview = f.session.state.preview
    f.memory.rows.set(JSON.stringify(importOwner), importPending()); await f.session.initialize(); await f.session.replay()
    expect(f.api.commitResourceImport).toHaveBeenCalledTimes(1)
    expect(f.api.commitResourceImport.mock.calls[0][0]).toEqual(importPending())
    expect(f.memory.rows.size).toBe(0); expect(f.session.state.pending).toBeNull()
    expect(f.session.state.receipt).toEqual(importReceipt())
    expect(f.session.state.fileName).toBe('later.' + format); expect(f.session.state.format).toBe(format)
    expect(f.session.state.rawHash).toBe(rawHash(bytes)); expect(f.session.state.fileSize).toBe(bytes.byteLength)
    expect(f.session.state.preview).toEqual(preview); expect(f.session.state.phase).toBe(previewed ? 'ready' : 'selection')
    expect(f.session.canPreview.value).toBe(true); expect(f.session.canCommit.value).toBe(previewed)
    expect(f.session.state.message).toContain('当前选件保留')
  })
  it('replaying the same bytes and format consumes the selection even under another filename', async () => {
    const f = setup(); await f.session.initialize(); await f.session.selectFile(f.file(importRaw(), 'renamed.csv'))
    f.memory.rows.set(JSON.stringify(importOwner), importPending()); await f.session.initialize(); await f.session.replay()
    expect(f.session.state.phase).toBe('confirmed'); expect(f.session.state.fileName).toBe('')
    expect(f.session.state.rawHash).toBe(''); expect(f.session.canPreview.value).toBe(false); expect(f.session.canCommit.value).toBe(false)
  })
  it('drains busy notification hints with a locked reread while retaining the local selection', async () => {
    const f = setup(); await f.ready(); const response = deferred<ReturnType<typeof importPreview>>()
    f.api.previewResourceImport.mockImplementationOnce(() => response.promise); const request = f.session.preview()
    await vi.waitFor(() => expect(f.api.previewResourceImport).toHaveBeenCalledTimes(2)); f.memory.emit()
    f.memory.rows.set(JSON.stringify(importOwner), importPending()); response.resolve(importPreview()); await request
    await vi.waitFor(() => expect(f.session.state.pending?.import_id).toBe('batch-original'))
    expect(f.session.state.fileName).toBe('synthetic.csv'); expect(f.api.commitResourceImport).not.toHaveBeenCalled()
  })
  it('leave warns for selection or pending; route reset invalidates selection without deleting durable original', async () => {
    const f = setup(); await f.ready(); vi.mocked(window.confirm).mockReturnValue(false); expect(f.session.prepareLeave()).toBe(false)
    vi.mocked(window.confirm).mockReturnValue(true); expect(f.session.prepareLeave()).toBe(true); f.session.resetEntry()
    expect(f.session.state.preview).toBeNull(); expect(f.session.state.fileName).toBe('')
    f.memory.rows.set(JSON.stringify(importOwner), importPending()); await f.session.initialize(); expect(f.session.prepareLeave()).toBe(true)
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining('服务器可能已经提交')); f.session.resetEntry(); expect(f.memory.rows.size).toBe(1)
  })
})

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BOM_WRITE_PENDING_STORAGE_KEY,
  commitFrozenBomWrite,
  findFrozenBomWrite,
  irrecoverableBomWriteKeys,
  listFrozenBomWritesForTarget,
  rememberIrrecoverableBomWrite,
  openBomWritePending,
  removeFrozenBomWrite,
  type BomWriteIdentity,
  type BomWritePendingStorage,
  type FrozenBomWrite,
} from '../src/services/plm/plmBomWritePending'

function identity(overrides: Partial<BomWriteIdentity> = {}): BomWriteIdentity {
  return {
    ownerId: 'owner-1',
    metaTenantId: 'tenant-1',
    dataSourceId: 'plm-ds',
    connectionId: 'conn-1',
    subjectId: 'person-1',
    targetOrigin: 'https://plm.example',
    yuantusTenantId: 'yt-1',
    yuantusOrgId: 'yo-1',
    workspaceId: null,
    scopeKind: 'workspace',
    ...overrides,
  }
}

function line(overrides: Partial<FrozenBomWrite> = {}): FrozenBomWrite {
  return {
    clientKey: 'submit-key-1',
    operationKind: 'line',
    dataSourceId: 'plm-ds',
    partId: 'P1',
    bomLineId: 'R1',
    patch: { refdes: 'R9' },
    ifMatch: '"bom-line:etag-r1"',
    identity: identity(),
    ...overrides,
  }
}

function memory(): BomWritePendingStorage & { raw: () => string; writes: number } {
  const items = new Map<string, string>()
  let writes = 0
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, next) => {
      writes += 1
      items.set(key, next)
    },
    removeItem: (key) => {
      items.delete(key)
    },
    keys: () => [...items.keys()],
    raw: () => [...items.values()].join('\n'),
    get writes() {
      return writes
    },
  }
}

function heldMemory(): BomWritePendingStorage & { raw: () => string; release: () => void } {
  const visible = new Map<string, string>()
  const queued: Array<{ key: string; value: string }> = []
  let hold = true
  return {
    getItem: (key) => visible.get(key) ?? null,
    setItem: (key, value) => {
      if (hold) {
        queued.push({ key, value })
        return
      }
      visible.set(key, value)
    },
    removeItem: (key) => {
      visible.delete(key)
    },
    keys: () => [...visible.keys()],
    raw: () => [...visible.values()].join('\n'),
    release: () => {
      hold = false
      for (const item of queued) visible.set(item.key, item.value)
      queued.length = 0
    },
  }
}

describe('plmBomWritePending', () => {
  it('does not key storage from a session signature or token', () => {
    const candidates = [
      resolve(process.cwd(), 'src/services/plm/plmBomWritePending.ts'),
      resolve(process.cwd(), 'apps/web/src/services/plm/plmBomWritePending.ts'),
    ]
    const found = candidates.find((path) => existsSync(path))
    expect(found).toBeTruthy()
    const source = readFileSync(found ?? '', 'utf8')
    expect(source).not.toContain('readAuthSessionSignature')
    expect(source).not.toContain('getAuthPrincipalKey')
    expect(source).not.toContain('auth_token')
    expect(source).not.toContain('authPrincipal')
  })

  it('refuses to store an auth principal fallback token or a session signature', () => {
    const store = memory()
    const fallback = 'token:opaque-session-token'
    const signature = JSON.stringify([fallback, 'opaque-session-token'])
    expect(commitFrozenBomWrite(line({ clientKey: fallback }), store)).toEqual({ ok: false, reason: 'storage' })
    expect(commitFrozenBomWrite(line({ identity: identity({ ownerId: fallback }) }), store)).toEqual({ ok: false, reason: 'storage' })
    expect(commitFrozenBomWrite(line({ identity: identity({ subjectId: signature }) }), store)).toEqual({ ok: false, reason: 'storage' })
    expect(commitFrozenBomWrite(line({ identity: identity({ metaTenantId: signature }) }), store)).toEqual({ ok: false, reason: 'storage' })
    expect(store.raw()).toBe('')
    expect(store.writes).toBe(0)
    const kept = commitFrozenBomWrite(line(), store)
    expect(kept).toMatchObject({ ok: true, mode: 'created' })
    expect(store.raw()).not.toContain('token:')
    expect(store.raw()).not.toContain('opaque-session-token')
    expect(store.raw()).toContain('owner-1')
    expect(store.raw()).toContain('person-1')
  })

  it('replays the original line and ECO snapshots and ignores a rotated body', () => {
    const store = memory()
    const eco: FrozenBomWrite = {
      clientKey: 'eco-key-1',
      operationKind: 'eco-intent',
      dataSourceId: 'plm-ds',
      partId: 'P1',
      bomLineId: null,
      patch: null,
      ifMatch: null,
      identity: identity(),
    }
    expect(commitFrozenBomWrite(line(), store)).toMatchObject({ ok: true, mode: 'created' })
    expect(commitFrozenBomWrite(eco, store)).toMatchObject({ ok: true, mode: 'created' })
    const again = commitFrozenBomWrite(line({ clientKey: 'submit-key-2', patch: { refdes: 'R10' } }), store)
    expect(again).toMatchObject({
      ok: true,
      mode: 'existing',
      frozen: { clientKey: 'submit-key-1', patch: { refdes: 'R9' }, ifMatch: '"bom-line:etag-r1"' },
    })
    const reread = memory()
    for (const key of store.keys()) reread.setItem(key, store.getItem(key) ?? '')
    expect(findFrozenBomWrite(eco, reread).status === 'existing' && findFrozenBomWrite(eco, reread)).toMatchObject({
      status: 'existing',
      frozen: { clientKey: 'eco-key-1', patch: null, ifMatch: null },
    })
    expect(store.raw()).not.toContain('R10')
    expect(store.raw()).not.toContain('submit-key-2')
  })

  it('refuses a changed identity without replacing the frozen intent', () => {
    const store = memory()
    commitFrozenBomWrite(line(), store)
    const changed = commitFrozenBomWrite(line({
      clientKey: 'submit-key-2',
      patch: { quantity: 8 },
      identity: identity({ subjectId: 'person-2' }),
    }), store)
    expect(changed).toEqual({ ok: false, reason: 'identity-changed' })
    expect(store.raw()).toContain('person-1')
    expect(store.raw()).not.toContain('person-2')
    expect(store.raw()).toContain('R9')
    expect(findFrozenBomWrite(line(), store)).toMatchObject({ status: 'existing' })
  })

  it('does not write or invent a snapshot when storage cannot be read or saved', () => {
    const broken: BomWritePendingStorage = {
      keys: () => [`${BOM_WRITE_PENDING_STORAGE_KEY}.orphan`],
      getItem: () => '{',
      setItem: () => {
        throw new Error('should not store over an unreadable snapshot')
      },
      removeItem: () => {
        throw new Error('should not remove an unreadable snapshot')
      },
    }
    expect(commitFrozenBomWrite(line(), broken)).toEqual({ ok: false, reason: 'storage' })
    expect(listFrozenBomWritesForTarget('plm-ds', 'P1', broken)).toBeNull()

    const throwing = memory()
    throwing.setItem = () => {
      throw new Error('quota')
    }
    expect(commitFrozenBomWrite(line(), throwing)).toEqual({ ok: false, reason: 'storage' })
    expect(throwing.raw()).toBe('')
  })

  it('keeps both operations when two helpers prepare before either write is visible', () => {
    const store = heldMemory()
    const left = openBomWritePending(store)
    const right = openBomWritePending(store)
    const eco: FrozenBomWrite = {
      clientKey: 'eco-key-1',
      operationKind: 'eco-intent',
      dataSourceId: 'plm-ds',
      partId: 'P1',
      bomLineId: null,
      patch: null,
      ifMatch: null,
      identity: identity(),
    }
    const secondLine = line({ clientKey: 'submit-key-2', bomLineId: 'R2', patch: { refdes: 'R2' } })
    expect(left.findFrozenBomWrite(line())).toEqual({ status: 'none' })
    expect(right.findFrozenBomWrite(eco)).toEqual({ status: 'none' })
    expect(left.findFrozenBomWrite(secondLine)).toEqual({ status: 'none' })
    expect(left.commitFrozenBomWrite(line())).toMatchObject({ ok: true, mode: 'created', frozen: { clientKey: 'submit-key-1' } })
    expect(right.commitFrozenBomWrite(eco)).toMatchObject({ ok: true, mode: 'created', frozen: { clientKey: 'eco-key-1' } })
    expect(right.commitFrozenBomWrite(secondLine)).toMatchObject({ ok: true, mode: 'created', frozen: { clientKey: 'submit-key-2' } })
    expect(store.raw()).toBe('')
    store.release()
    const saved = openBomWritePending(store).listFrozenBomWritesForTarget('plm-ds', 'P1')
    expect(saved?.map((row) => row.clientKey).sort()).toEqual(['eco-key-1', 'submit-key-1', 'submit-key-2'])
    expect(saved?.find((row) => row.clientKey === 'submit-key-1')?.patch).toEqual({ refdes: 'R9' })
    expect(saved?.find((row) => row.clientKey === 'eco-key-1')?.patch).toBeNull()
    expect(store.keys().every((key) => key.startsWith(`${BOM_WRITE_PENDING_STORAGE_KEY}.`))).toBe(true)
    expect(store.keys()).toHaveLength(3)
  })

  it('does not drop either same-slot snapshot prepared by two helpers', () => {
    const store = heldMemory()
    const left = openBomWritePending(store)
    const right = openBomWritePending(store)
    const first = line({ clientKey: 'submit-key-1', patch: { refdes: 'R9' } })
    const second = line({ clientKey: 'submit-key-2', patch: { refdes: 'R10' }, ifMatch: '"bom-line:etag-r2"' })
    expect(left.findFrozenBomWrite(first)).toEqual({ status: 'none' })
    expect(right.findFrozenBomWrite(second)).toEqual({ status: 'none' })
    expect(left.commitFrozenBomWrite(first)).toMatchObject({ ok: true, mode: 'created' })
    expect(right.commitFrozenBomWrite(second)).toMatchObject({ ok: true, mode: 'created' })
    store.release()
    const saved = listFrozenBomWritesForTarget('plm-ds', 'P1', store) ?? []
    expect(saved).toHaveLength(2)
    expect(saved.find((row) => row.clientKey === 'submit-key-1')).toMatchObject({
      patch: { refdes: 'R9' },
      ifMatch: '"bom-line:etag-r1"',
    })
    expect(saved.find((row) => row.clientKey === 'submit-key-2')).toMatchObject({
      patch: { refdes: 'R10' },
      ifMatch: '"bom-line:etag-r2"',
    })
    expect(findFrozenBomWrite(first, store)).toEqual({ status: 'multiple' })
    expect(findFrozenBomWrite({ ...second, pinClientKey: 'submit-key-2' }, store)).toMatchObject({
      status: 'existing',
      frozen: { clientKey: 'submit-key-2', patch: { refdes: 'R10' } },
    })
    const third = commitFrozenBomWrite(line({ clientKey: 'submit-key-3', patch: { quantity: 4 } }), store)
    expect(third).toEqual({ ok: false, reason: 'multiple' })
    expect(store.raw()).not.toContain('submit-key-3')
    expect(store.raw()).toContain('submit-key-1')
    expect(store.raw()).toContain('submit-key-2')
    expect(store.raw()).toContain('R9')
    expect(store.raw()).toContain('R10')
    expect(removeFrozenBomWrite(first, store)).toBe(true)
    expect(listFrozenBomWritesForTarget('plm-ds', 'P1', store)?.map((row) => row.clientKey)).toEqual(['submit-key-2'])
  })

  it('keeps an irrecoverable snapshot and stores a separate explicit operation beside it', () => {
    const store = memory()
    const helper = openBomWritePending(store)
    expect(helper.commitFrozenBomWrite(line())).toMatchObject({ ok: true, mode: 'created' })
    const replay = helper.commitFrozenBomWrite(line({ clientKey: 'submit-key-2', patch: { refdes: 'R10' } }))
    expect(replay).toMatchObject({
      ok: true,
      mode: 'existing',
      frozen: { clientKey: 'submit-key-1', patch: { refdes: 'R9' } },
    })
    const separate = helper.commitFrozenBomWrite(
      line({ clientKey: 'submit-key-2', patch: { refdes: 'R10' }, ifMatch: '"bom-line:etag-r2"' }),
      { separate: true },
    )
    expect(separate).toMatchObject({
      ok: true,
      mode: 'created',
      frozen: { clientKey: 'submit-key-2', patch: { refdes: 'R10' }, ifMatch: '"bom-line:etag-r2"' },
    })
    const changed = helper.commitFrozenBomWrite(line({
      clientKey: 'submit-key-3',
      patch: { quantity: 3 },
      identity: identity({ subjectId: 'person-2' }),
    }))
    expect(changed).toEqual({ ok: false, reason: 'identity-changed' })
    const explicit = helper.commitFrozenBomWrite(line({
      clientKey: 'submit-key-3',
      patch: { quantity: 3 },
      identity: identity({ subjectId: 'person-2' }),
    }), { separate: true })
    expect(explicit).toMatchObject({
      ok: true,
      mode: 'created',
      frozen: { clientKey: 'submit-key-3', identity: { subjectId: 'person-2' }, patch: { quantity: 3 } },
    })
    const replaced = helper.commitFrozenBomWrite(line({ clientKey: 'submit-key-1', patch: { refdes: 'R11' } }), { separate: true })
    expect(replaced).toMatchObject({
      ok: true,
      mode: 'existing',
      frozen: { clientKey: 'submit-key-1', patch: { refdes: 'R9' } },
    })
    expect(rememberIrrecoverableBomWrite('submit-key-1', 412, store)).toBe(true)
    expect(rememberIrrecoverableBomWrite('submit-key-2', 422, store)).toBe(true)
    expect(irrecoverableBomWriteKeys(store).sort()).toEqual(['submit-key-1', 'submit-key-2'])
    const saved = listFrozenBomWritesForTarget('plm-ds', 'P1', store) ?? []
    expect(saved.map((row) => row.clientKey).sort()).toEqual(['submit-key-1', 'submit-key-2', 'submit-key-3'])
    expect(saved.find((row) => row.clientKey === 'submit-key-1')?.patch).toEqual({ refdes: 'R9' })
    expect(saved.find((row) => row.clientKey === 'submit-key-1')?.identity.subjectId).toBe('person-1')
    expect(store.raw()).not.toContain('R11')
    expect(removeFrozenBomWrite(line(), store)).toBe(true)
    expect(irrecoverableBomWriteKeys(store)).toEqual(['submit-key-2'])
    expect(listFrozenBomWritesForTarget('plm-ds', 'P1', store)?.map((row) => row.clientKey).sort())
      .toEqual(['submit-key-2', 'submit-key-3'])
  })

  it('resolves pinned scopes in either storage order and keeps every old record', () => {
    const scopeA = identity({
      metaTenantId: 'tenant-a',
      subjectId: 'person-a',
      targetOrigin: 'https://a.example',
    })
    const scopeB = identity({
      metaTenantId: 'tenant-b',
      subjectId: 'person-b',
      targetOrigin: 'https://b.example',
    })
    const recordA = line({
      clientKey: 'submit-key-a',
      patch: { refdes: 'BODY-A' },
      ifMatch: '"etag-a"',
      identity: scopeA,
    })
    const recordB = line({
      clientKey: 'submit-key-b',
      patch: { refdes: 'BODY-B' },
      ifMatch: '"etag-b"',
      identity: scopeB,
    })
    for (const [first, second] of [[recordA, recordB], [recordB, recordA]]) {
      const store = memory()
      expect(commitFrozenBomWrite(first, store)).toMatchObject({ ok: true, mode: 'created' })
      expect(commitFrozenBomWrite(second, store, { separate: true })).toMatchObject({ ok: true, mode: 'created' })
      expect(findFrozenBomWrite({ ...recordB, pinClientKey: 'submit-key-b' }, store)).toMatchObject({
        status: 'existing',
        frozen: { clientKey: 'submit-key-b', patch: { refdes: 'BODY-B' }, ifMatch: '"etag-b"' },
      })
      expect(findFrozenBomWrite({ ...recordA, pinClientKey: 'submit-key-a' }, store)).toMatchObject({
        status: 'existing',
        frozen: { clientKey: 'submit-key-a', patch: { refdes: 'BODY-A' }, ifMatch: '"etag-a"' },
      })
      const rotated = commitFrozenBomWrite(line({
        clientKey: 'submit-key-rotated',
        patch: { refdes: 'ROTATED' },
        ifMatch: '"etag-rotated"',
        identity: scopeA,
      }), store)
      expect(rotated).toMatchObject({
        ok: true,
        mode: 'existing',
        frozen: { clientKey: 'submit-key-a', patch: { refdes: 'BODY-A' }, ifMatch: '"etag-a"' },
      })
      expect(store.raw()).not.toContain('submit-key-rotated')
      expect(store.raw()).not.toContain('ROTATED')
      expect(commitFrozenBomWrite(line({
        clientKey: 'submit-key-c',
        patch: { quantity: 3 },
        identity: identity({
          metaTenantId: 'tenant-c',
          subjectId: 'person-c',
          targetOrigin: 'https://c.example',
        }),
      }), store)).toEqual({ ok: false, reason: 'identity-changed' })
      expect(store.raw()).not.toContain('submit-key-c')
      const recovery = commitFrozenBomWrite(line({
        clientKey: 'submit-key-a-recovery',
        patch: { refdes: 'RECOVER-A' },
        ifMatch: '"etag-a-recovery"',
        identity: scopeA,
      }), store, { separate: true })
      expect(recovery).toMatchObject({
        ok: true,
        mode: 'created',
        frozen: {
          clientKey: 'submit-key-a-recovery',
          patch: { refdes: 'RECOVER-A' },
          ifMatch: '"etag-a-recovery"',
        },
      })
      const saved = listFrozenBomWritesForTarget('plm-ds', 'P1', store) ?? []
      expect(saved.map((row) => row.clientKey).sort()).toEqual([
        'submit-key-a',
        'submit-key-a-recovery',
        'submit-key-b',
      ])
      expect(saved.find((row) => row.clientKey === 'submit-key-a')).toMatchObject({
        patch: { refdes: 'BODY-A' },
        ifMatch: '"etag-a"',
        identity: { subjectId: 'person-a', metaTenantId: 'tenant-a' },
      })
      expect(saved.find((row) => row.clientKey === 'submit-key-b')).toMatchObject({
        patch: { refdes: 'BODY-B' },
        ifMatch: '"etag-b"',
        identity: { subjectId: 'person-b', metaTenantId: 'tenant-b' },
      })
    }
  })

  it('round-trips exact JSON cell scalars and rejects a NUL or a lone surrogate', () => {
    const store = memory()
    const longRefdes = 'R'.repeat(501)
    const cells: Array<{ key: string; line: string; patch: FrozenBomWrite['patch'] }> = [
      { key: 'cell-empty', line: 'L-empty', patch: { refdes: '' } },
      { key: 'cell-space', line: 'L-space', patch: { refdes: ' R1 ' } },
      { key: 'cell-long', line: 'L-long', patch: { refdes: longRefdes } },
      { key: 'cell-yuw', line: 'L-yuw', patch: { refdes: 'yuw_not_a_credential' } },
      { key: 'cell-json', line: 'L-json', patch: { refdes: '["ordinary"]' } },
      { key: 'cell-unicode', line: 'L-unicode', patch: { quantity: '数量', uom: '  ', find_num: '位号', refdes: '😀' } },
      { key: 'cell-qty', line: 'L-qty', patch: { quantity: 12.5 } },
      { key: 'cell-qty-space', line: 'L-qty-space', patch: { quantity: ' 2 ' } },
      { key: 'cell-nulls', line: 'L-nulls', patch: { uom: null, find_num: null, refdes: null } },
    ]
    for (const cell of cells) {
      expect(commitFrozenBomWrite(line({
        clientKey: cell.key,
        bomLineId: cell.line,
        patch: cell.patch,
      }), store)).toMatchObject({ ok: true, mode: 'created', frozen: { patch: cell.patch } })
    }
    const saved = listFrozenBomWritesForTarget('plm-ds', 'P1', store) ?? []
    for (const cell of cells) {
      expect(saved.find((row) => row.clientKey === cell.key)?.patch).toEqual(cell.patch)
    }
    const raw = store.raw()
    expect(raw).toContain('"refdes":""')
    expect(raw).toContain(' R1 ')
    expect(raw).toContain(longRefdes)
    expect(raw).toContain('yuw_not_a_credential')
    expect(raw).toContain(JSON.stringify('["ordinary"]').slice(1, -1))
    expect(raw).toContain('数量')
    expect(raw).toContain('位号')
    expect(raw).toContain('😀')
    expect(raw).toContain(' 2 ')

    const invalid: Array<Record<string, unknown>> = [
      { refdes: 'a\u0000b' },
      { refdes: '\uD800' },
      { refdes: '\uDC00' },
      { refdes: 'ok\uD800tail' },
      { uom: '\uD800' },
      { find_num: 'x\u0000' },
      { quantity: Number.POSITIVE_INFINITY },
      { quantity: Number.NaN },
      { quantity: '1\u0000' },
      { quantity: '\uD800' },
      { quantity: true },
      { uom: 1 },
    ]
    for (const patch of invalid) {
      const rejected = memory()
      expect(commitFrozenBomWrite(line({
        clientKey: 'bad-cell',
        patch: patch as FrozenBomWrite['patch'],
      }), rejected)).toEqual({ ok: false, reason: 'storage' })
      expect(rejected.raw()).toBe('')
      expect(rejected.writes).toBe(0)
    }
    expect(listFrozenBomWritesForTarget('plm-ds', 'P1', store)).toHaveLength(cells.length)
  })

  it('scopes a target list by owner and keeps the other record', () => {
    const store = memory()
    commitFrozenBomWrite(line(), store)
    commitFrozenBomWrite(line({
      clientKey: 'submit-key-2',
      bomLineId: 'R2',
      patch: { refdes: 'OWN-2' },
      identity: identity({ ownerId: 'owner-2', subjectId: 'person-2' }),
    }), store)
    expect(listFrozenBomWritesForTarget('plm-ds', 'P1', store)?.map((row) => row.identity.ownerId).sort())
      .toEqual(['owner-1', 'owner-2'])
    expect(listFrozenBomWritesForTarget('plm-ds', 'P1', store, 'owner-1')?.map((row) => row.clientKey))
      .toEqual(['submit-key-1'])
    expect(listFrozenBomWritesForTarget('plm-ds', 'P1', store, 'owner-2')?.map((row) => row.patch))
      .toEqual([{ refdes: 'OWN-2' }])
    expect(listFrozenBomWritesForTarget('plm-ds', 'P1', store, 'owner-3')).toEqual([])
    expect(store.raw()).toContain('owner-1')
    expect(store.raw()).toContain('owner-2')
    expect(store.raw()).toContain('OWN-2')
    expect(store.keys()).toHaveLength(2)
  })

  it('removes only an accepted slot', () => {
    const store = memory()
    commitFrozenBomWrite(line(), store)
    commitFrozenBomWrite(line({ bomLineId: 'R2', clientKey: 'submit-key-2' }), store)
    expect(removeFrozenBomWrite(line(), store)).toBe(true)
    const left = listFrozenBomWritesForTarget('plm-ds', 'P1', store)
    expect(left?.map((row) => row.bomLineId)).toEqual(['R2'])
  })
})

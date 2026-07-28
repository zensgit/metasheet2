/** Attachment slice ④ — storage containment + download-auth goldens (required lane; local tmp fs). */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { afterAll, describe, expect, test } from 'vitest'

import {
  APPROVAL_STORAGE_PREFIX,
  authorizeAttachmentDownload,
  deriveStorageKey,
  LocalFsApprovalAttachmentStore,
  ObjectStoreApprovalAttachmentStore,
  type KeyAddressedObjectStore,
} from '../../src/services/approval-attachment-storage'
import { StorageServiceImpl } from '../../src/services/StorageService'

const root = mkdtempSync(path.join(tmpdir(), 'att-store-'))
const store = new LocalFsApprovalAttachmentStore(root)

describe('attachment storage + download auth', () => {
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test('server-side key: extension from VALIDATED mime, client filename never involved; unknown mime throws', () => {
    const k = deriveStorageKey('image/jpeg', () => new Date(Date.UTC(2026, 6, 15)))
    // Pinned to the §7 approval scope prefix — the reconciler's scope containment on a SHARED store
    // rests on every approval key living under it, so the prefix is part of the contract, not cosmetic.
    expect(k).toMatch(/^approval-attachments\/2026-07\/[0-9a-f-]{36}\.jpg$/)
    expect(k.startsWith(APPROVAL_STORAGE_PREFIX)).toBe(true)
    expect(() => deriveStorageKey('application/zip')).toThrow(/allowlist/)
  })

  test('containment: put/get/delete round-trip inside root; traversal/absolute/NUL keys refused', async () => {
    const k = deriveStorageKey('text/plain')
    await store.put(k, Buffer.from('hello'))
    expect((await store.get(k)).toString()).toBe('hello')
    await expect(store.put(k, Buffer.from('x'))).rejects.toThrow() // wx: never overwrite
    expect(await store.delete(k)).toBe(true)
    expect(await store.delete(k)).toBe(false) // idempotent missing-is-ok
    for (const bad of ['../escape.txt', '../../etc/passwd', '/abs/path', 'a\0b', '  ']) {
      await expect(store.get(bad)).rejects.toThrow(/refused|invalid/)
    }
  })

  const base = {
    uploaderId: 'u1',
    fieldId: 'f',
    orgId: 'org1',
    scanState: 'unscanned' as const,
  }
  const auth = (
    row: Parameters<typeof authorizeAttachmentDownload>[0],
    viewerId: string,
    checks: Parameters<typeof authorizeAttachmentDownload>[3],
    viewerOrg = 'org1',
  ) => authorizeAttachmentDownload(row, viewerId, viewerOrg, checks)

  test('download auth: unbound=uploader-only; bound=participant (fail-closed on error); deleted=gone', async () => {
    const yes = { isInstanceParticipant: async () => true, isFieldHiddenAtActiveNode: async () => false }
    const no = { isInstanceParticipant: async () => false, isFieldHiddenAtActiveNode: async () => false }
    const boom = {
      isInstanceParticipant: async () => {
        throw new Error('acl down')
      },
      isFieldHiddenAtActiveNode: async () => false,
    }
    expect(await auth({ ...base, status: 'unbound', instanceId: null }, 'u1', no)).toEqual({ ok: true })
    expect(await auth({ ...base, status: 'unbound', instanceId: null }, 'u2', yes)).toEqual({ ok: false, code: 'not_uploader' })
    expect(await auth({ ...base, status: 'bound', instanceId: 'i1' }, 'u2', yes)).toEqual({ ok: true })
    expect(await auth({ ...base, status: 'bound', instanceId: 'i1' }, 'u2', no)).toEqual({ ok: false, code: 'not_participant' })
    expect(await auth({ ...base, status: 'bound', instanceId: 'i1' }, 'u2', boom)).toEqual({ ok: false, code: 'not_participant' })
    expect(await auth({ ...base, status: 'deleted', instanceId: 'i1' }, 'u1', yes)).toEqual({ ok: false, code: 'gone' })
  })

  test('org pin: cross-org viewer is denied before participant/lifecycle (no existence oracle)', async () => {
    const yes = { isInstanceParticipant: async () => true, isFieldHiddenAtActiveNode: async () => false }
    expect(await auth({ ...base, status: 'bound', instanceId: 'i1' }, 'u2', yes, 'org2')).toEqual({ ok: false, code: 'cross_org' })
    expect(await auth({ ...base, status: 'deleted', instanceId: 'i1' }, 'u2', yes, 'org2')).toEqual({ ok: false, code: 'cross_org' })
  })

  test('§6 infected is refused only after authorization (authorized → infected; outsider → not_participant)', async () => {
    const yes = { isInstanceParticipant: async () => true, isFieldHiddenAtActiveNode: async () => false }
    const no = { isInstanceParticipant: async () => false, isFieldHiddenAtActiveNode: async () => false }
    expect(await auth({ ...base, status: 'bound', instanceId: 'i1', scanState: 'infected' }, 'u2', yes)).toEqual({
      ok: false,
      code: 'infected',
    })
    expect(await auth({ ...base, status: 'bound', instanceId: 'i1', scanState: 'infected' }, 'u2', no)).toEqual({
      ok: false,
      code: 'not_participant',
    })
  })

  test('G6 no deleted-row oracle: an UNAUTHORIZED viewer of a deleted row gets the SAME denial as a live row (not gone)', async () => {
    const yes = { isInstanceParticipant: async () => true, isFieldHiddenAtActiveNode: async () => false }
    const no = { isInstanceParticipant: async () => false, isFieldHiddenAtActiveNode: async () => false }
    // deleted bound row: a NON-participant must see not_participant (→404), NEVER gone (→410) — no lifecycle oracle
    expect(await auth({ ...base, status: 'deleted', instanceId: 'i1' }, 'u2', no)).toEqual({ ok: false, code: 'not_participant' })
    // deleted unbound row: a NON-uploader must see not_uploader (→404), NEVER gone
    expect(await auth({ ...base, status: 'deleted', instanceId: null }, 'u2', yes)).toEqual({ ok: false, code: 'not_uploader' })
    // only an AUTHORIZED viewer sees the tombstone (gone → 410)
    expect(await auth({ ...base, status: 'deleted', instanceId: 'i1' }, 'u2', yes)).toEqual({ ok: false, code: 'gone' })
    expect(await auth({ ...base, status: 'deleted', instanceId: null }, 'u1', no)).toEqual({ ok: false, code: 'gone' })
  })

  test('G7 hidden-field byte gate: a hidden-at-active-node field serves NO bytes even to a participant; fail-closed', async () => {
    const participantHidden = { isInstanceParticipant: async () => true, isFieldHiddenAtActiveNode: async () => true }
    const participantVisible = { isInstanceParticipant: async () => true, isFieldHiddenAtActiveNode: async () => false }
    const participantHiddenThrows = {
      isInstanceParticipant: async () => true,
      isFieldHiddenAtActiveNode: async () => {
        throw new Error('graph load down')
      },
    }
    // hidden ⇒ refused with the 'hidden' code (route maps it to 404, the snapshot-redaction shape)
    expect(await auth({ ...base, status: 'bound', instanceId: 'i1', fieldId: 'secret' }, 'u2', participantHidden)).toEqual({
      ok: false,
      code: 'hidden',
    })
    // not hidden ⇒ the same participant still gets the bytes (positive control)
    expect(await auth({ ...base, status: 'bound', instanceId: 'i1', fieldId: 'open' }, 'u2', participantVisible)).toEqual({ ok: true })
    // fail-closed: a hidden-check failure must refuse, never leak the byte
    expect(await auth({ ...base, status: 'bound', instanceId: 'i1', fieldId: 'secret' }, 'u2', participantHiddenThrows)).toEqual({
      ok: false,
      code: 'hidden',
    })
  })
})

/**
 * B3-07 §2/§7 — the PRODUCTION store: an `ApprovalAttachmentStore` backed by the SHARED
 * `StorageService` substrate instead of an approval-owned transport. These goldens pin the two
 * properties the reuse rests on: the adapter uses ONLY the key-addressed triple, and the approval
 * scope prefix is an unbypassable partition (refused in BOTH directions, on EVERY operation).
 */
describe('ObjectStoreApprovalAttachmentStore (shared-substrate reuse)', () => {
  const KEY = `${APPROVAL_STORAGE_PREFIX}2026-07/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.pdf`

  function recordingProvider() {
    const calls: string[] = []
    const blobs = new Map<string, Buffer>()
    const provider: KeyAddressedObjectStore & { listApprovalBlobs: () => Promise<Array<{ key: string; ageMs: number }>> } = {
      uploadByKey: async (k, c) => {
        calls.push(`uploadByKey:${k}`)
        blobs.set(k, c)
      },
      downloadByKey: async (k) => {
        calls.push(`downloadByKey:${k}`)
        const b = blobs.get(k)
        if (!b) throw new Error('missing')
        return b
      },
      deleteByKey: async (k) => {
        calls.push(`deleteByKey:${k}`)
        blobs.delete(k)
      },
      listApprovalBlobs: async () => [...blobs.keys()].map((key) => ({ key, ageMs: 0 })),
    }
    return { provider, calls, blobs }
  }

  test('delegates to the substrate key-addressed triple ONLY (never the index-based upload/download/delete)', async () => {
    const { provider, calls, blobs } = recordingProvider()
    // A provider that ALSO exposes the index-based methods: if the adapter ever reached for them the
    // spy would fire. This is the "must not fork the blob substrate / must not use the index-based
    // API" contract (§4.2 downloadByKey, §7 deleteByKey) as a behavioural assertion, not a comment.
    let indexBasedCalls = 0
    const withIndexApi = Object.assign({}, provider, {
      upload: async () => void indexBasedCalls++,
      download: async () => {
        indexBasedCalls++
        return Buffer.alloc(0)
      },
      delete: async () => void indexBasedCalls++,
    })
    const store = new ObjectStoreApprovalAttachmentStore(withIndexApi)
    await store.put(KEY, Buffer.from('hello'))
    expect((await store.get(KEY)).toString()).toBe('hello')
    expect(await store.delete(KEY)).toBe(true)
    expect(calls).toEqual([`uploadByKey:${KEY}`, `downloadByKey:${KEY}`, `deleteByKey:${KEY}`])
    expect(indexBasedCalls).toBe(0)
    expect(blobs.size).toBe(0)
  })

  test('scope partition: a key outside the approval prefix is refused on put AND get AND delete', async () => {
    const { provider, calls } = recordingProvider()
    const store = new ObjectStoreApprovalAttachmentStore(provider)
    // NEGATIVE: another product's key (multitable/files blobs live in the same shared store) — the
    // adapter must never read, write or DELETE it. A delete leak here is the "reconciler deletes other
    // products' blobs" risk the §7 owner-P1 scope confinement exists to prevent.
    for (const foreign of ['multitable/attachments/x.png', 'files/abc/report.pdf', '../escape.pdf', 'approval-attachmentsX/y.pdf']) {
      await expect(store.put(foreign, Buffer.from('x'))).rejects.toThrow(/outside the approval attachment scope|traversal/)
      await expect(store.get(foreign)).rejects.toThrow(/outside the approval attachment scope|traversal/)
      await expect(store.delete(foreign)).rejects.toThrow(/outside the approval attachment scope|traversal/)
    }
    // Not one call reached the provider for ANY refused key.
    expect(calls).toEqual([])
    // POSITIVE CONTROL: an in-scope key still works — the guard rejects by scope, not by rejecting all.
    await store.put(KEY, Buffer.from('ok'))
    expect((await store.get(KEY)).toString()).toBe('ok')
  })

  test('traversal INSIDE the prefix is refused too (prefix match alone is not containment)', async () => {
    const { provider } = recordingProvider()
    const store = new ObjectStoreApprovalAttachmentStore(provider)
    // Starts with the prefix, yet climbs out of it — accepted by a naive startsWith check alone.
    await expect(store.put(`${APPROVAL_STORAGE_PREFIX}../../etc/passwd`, Buffer.from('x'))).rejects.toThrow(/traversal/)
  })

  test('delete reports success for an already-gone key (ENOENT-as-success ⇒ purge terminal-success)', async () => {
    const { provider } = recordingProvider()
    const store = new ObjectStoreApprovalAttachmentStore(provider)
    // Nothing was ever put at this key; the substrate's deleteByKey resolves, so the purge worker
    // marks the intent `done` instead of retrying forever (§7 not-found is terminal-SUCCESS).
    expect(await store.delete(KEY)).toBe(true)
  })

  test('G15 reconciler seam is mandatory and enumerates only the provider approval view', async () => {
    const { provider } = recordingProvider()
    const listable = Object.assign({}, provider, {
      listApprovalBlobs: async () => [{ key: KEY, ageMs: 10 }],
    })
    const withList = new ObjectStoreApprovalAttachmentStore(listable)
    expect(withList.canList()).toBe(true)
    expect(await withList.list()).toEqual([{ key: KEY, ageMs: 10 }])
  })

  test('REAL substrate round-trip: rides StorageServiceImpl (the shared service), containment enforced there too', async () => {
    // Not a stub — the actual repository StorageService, proving the new key-addressed write is a real
    // capability of the shared substrate and that approval blobs need no transport of their own.
    const svcRoot = mkdtempSync(path.join(tmpdir(), 'att-svc-'))
    try {
      const svc = StorageServiceImpl.createLocalService(svcRoot)
      const store = new ObjectStoreApprovalAttachmentStore(svc)
      const key = deriveStorageKey('application/pdf')
      await store.put(key, Buffer.from('%PDF-1.4 real'))
      expect((await store.get(key)).toString()).toBe('%PDF-1.4 real')
      // exclusive-create: the same key is never silently overwritten
      await expect(store.put(key, Buffer.from('overwrite'))).rejects.toThrow()
      expect((await store.get(key)).toString()).toBe('%PDF-1.4 real')
      expect(await store.delete(key)).toBe(true)
      await expect(store.get(key)).rejects.toThrow()
      // deleting again is success, not a throw (ENOENT-as-success, the purge worker's contract)
      expect(await store.delete(key)).toBe(true)
    } finally {
      rmSync(svcRoot, { recursive: true, force: true })
    }
  })
})

/** Attachment slice ④ — storage containment + download-auth goldens (required lane; local tmp fs). */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { afterAll, describe, expect, test } from 'vitest'

import {
  authorizeAttachmentDownload,
  deriveStorageKey,
  LocalFsApprovalAttachmentStore,
} from '../../src/services/approval-attachment-storage'

const root = mkdtempSync(path.join(tmpdir(), 'att-store-'))
const store = new LocalFsApprovalAttachmentStore(root)

describe('attachment storage + download auth', () => {
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test('server-side key: extension from VALIDATED mime, client filename never involved; unknown mime throws', () => {
    const k = deriveStorageKey('image/jpeg', () => new Date(Date.UTC(2026, 6, 15)))
    expect(k).toMatch(/^approval\/2026-07\/[0-9a-f-]{36}\.jpg$/)
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

  test('download auth: unbound=uploader-only; bound=participant (fail-closed on error); deleted=gone', async () => {
    const yes = { isInstanceParticipant: async () => true }
    const no = { isInstanceParticipant: async () => false }
    const boom = {
      isInstanceParticipant: async () => {
        throw new Error('acl down')
      },
    }
    expect(await authorizeAttachmentDownload({ status: 'unbound', uploaderId: 'u1', instanceId: null }, 'u1', no)).toEqual({ ok: true })
    expect(await authorizeAttachmentDownload({ status: 'unbound', uploaderId: 'u1', instanceId: null }, 'u2', yes)).toEqual({ ok: false, code: 'not_uploader' })
    expect(await authorizeAttachmentDownload({ status: 'bound', uploaderId: 'u1', instanceId: 'i1' }, 'u2', yes)).toEqual({ ok: true })
    expect(await authorizeAttachmentDownload({ status: 'bound', uploaderId: 'u1', instanceId: 'i1' }, 'u2', no)).toEqual({ ok: false, code: 'not_participant' })
    expect(await authorizeAttachmentDownload({ status: 'bound', uploaderId: 'u1', instanceId: 'i1' }, 'u2', boom)).toEqual({ ok: false, code: 'not_participant' })
    expect(await authorizeAttachmentDownload({ status: 'deleted', uploaderId: 'u1', instanceId: 'i1' }, 'u1', yes)).toEqual({ ok: false, code: 'gone' })
  })
})

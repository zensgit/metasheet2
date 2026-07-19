/** Attachment slice ④ — storage containment + download-auth goldens (required lane; local tmp fs). */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { afterAll, describe, expect, test } from 'vitest'

import {
  authorizeAttachmentDownload,
  deriveStorageKey,
  LocalFsApprovalAttachmentStore,
  resolveApprovalAttachmentStore,
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
    const yes = { isInstanceParticipant: async () => true, isFieldHiddenAtActiveNode: async () => false }
    const no = { isInstanceParticipant: async () => false, isFieldHiddenAtActiveNode: async () => false }
    const boom = {
      isInstanceParticipant: async () => {
        throw new Error('acl down')
      },
      isFieldHiddenAtActiveNode: async () => false,
    }
    expect(await authorizeAttachmentDownload({ status: 'unbound', uploaderId: 'u1', instanceId: null, fieldId: 'f' }, 'u1', no)).toEqual({ ok: true })
    expect(await authorizeAttachmentDownload({ status: 'unbound', uploaderId: 'u1', instanceId: null, fieldId: 'f' }, 'u2', yes)).toEqual({ ok: false, code: 'not_uploader' })
    expect(await authorizeAttachmentDownload({ status: 'bound', uploaderId: 'u1', instanceId: 'i1', fieldId: 'f' }, 'u2', yes)).toEqual({ ok: true })
    expect(await authorizeAttachmentDownload({ status: 'bound', uploaderId: 'u1', instanceId: 'i1', fieldId: 'f' }, 'u2', no)).toEqual({ ok: false, code: 'not_participant' })
    expect(await authorizeAttachmentDownload({ status: 'bound', uploaderId: 'u1', instanceId: 'i1', fieldId: 'f' }, 'u2', boom)).toEqual({ ok: false, code: 'not_participant' })
    expect(await authorizeAttachmentDownload({ status: 'deleted', uploaderId: 'u1', instanceId: 'i1', fieldId: 'f' }, 'u1', yes)).toEqual({ ok: false, code: 'gone' })
  })

  test('G6 no deleted-row oracle: an UNAUTHORIZED viewer of a deleted row gets the SAME denial as a live row (not gone)', async () => {
    const yes = { isInstanceParticipant: async () => true, isFieldHiddenAtActiveNode: async () => false }
    const no = { isInstanceParticipant: async () => false, isFieldHiddenAtActiveNode: async () => false }
    // deleted bound row: a NON-participant must see not_participant (→404), NEVER gone (→410) — no lifecycle oracle
    expect(await authorizeAttachmentDownload({ status: 'deleted', uploaderId: 'u1', instanceId: 'i1', fieldId: 'f' }, 'u2', no)).toEqual({ ok: false, code: 'not_participant' })
    // deleted unbound row: a NON-uploader must see not_uploader (→404), NEVER gone
    expect(await authorizeAttachmentDownload({ status: 'deleted', uploaderId: 'u1', instanceId: null, fieldId: 'f' }, 'u2', yes)).toEqual({ ok: false, code: 'not_uploader' })
    // only an AUTHORIZED viewer sees the tombstone (gone → 410)
    expect(await authorizeAttachmentDownload({ status: 'deleted', uploaderId: 'u1', instanceId: 'i1', fieldId: 'f' }, 'u2', yes)).toEqual({ ok: false, code: 'gone' })
    expect(await authorizeAttachmentDownload({ status: 'deleted', uploaderId: 'u1', instanceId: null, fieldId: 'f' }, 'u1', no)).toEqual({ ok: false, code: 'gone' })
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
    expect(await authorizeAttachmentDownload({ status: 'bound', uploaderId: 'u1', instanceId: 'i1', fieldId: 'secret' }, 'u2', participantHidden)).toEqual({ ok: false, code: 'hidden' })
    // not hidden ⇒ the same participant still gets the bytes (positive control)
    expect(await authorizeAttachmentDownload({ status: 'bound', uploaderId: 'u1', instanceId: 'i1', fieldId: 'open' }, 'u2', participantVisible)).toEqual({ ok: true })
    // fail-closed: a hidden-check failure must refuse, never leak the byte
    expect(await authorizeAttachmentDownload({ status: 'bound', uploaderId: 'u1', instanceId: 'i1', fieldId: 'secret' }, 'u2', participantHiddenThrows)).toEqual({ ok: false, code: 'hidden' })
  })
})

  test('O3 production fail-closed: local provider in production → store null (values-free)', () => {
    const r = resolveApprovalAttachmentStore({
      NODE_ENV: 'production',
      APPROVAL_ATTACHMENT_STORAGE_PROVIDER: 'local',
    } as NodeJS.ProcessEnv)
    expect(r.store).toBeNull()
    expect(r.unavailableReason).toBe('local_in_production')
  })

  test('O3 production fail-closed: missing S3 bucket → misconfigured; positive control s3+bucket resolves', () => {
    const missing = resolveApprovalAttachmentStore({
      NODE_ENV: 'production',
      APPROVAL_ATTACHMENT_STORAGE_PROVIDER: 's3',
      APPROVAL_ATTACHMENT_S3_BUCKET: '',
    } as NodeJS.ProcessEnv)
    expect(missing.store).toBeNull()
    expect(missing.unavailableReason).toBe('misconfigured')

    const ok = resolveApprovalAttachmentStore({
      NODE_ENV: 'production',
      APPROVAL_ATTACHMENT_STORAGE_PROVIDER: 's3',
      APPROVAL_ATTACHMENT_S3_BUCKET: 'approval-bucket',
      APPROVAL_ATTACHMENT_S3_REGION: 'us-east-1',
      APPROVAL_ATTACHMENT_S3_ACCESS_KEY_ID: 'test',
      APPROVAL_ATTACHMENT_S3_SECRET_ACCESS_KEY: 'test',
    } as NodeJS.ProcessEnv)
    expect(ok.kind).toBe('s3')
    expect(ok.store).not.toBeNull()
  })

  test('O3 positive control: non-production local store is usable', () => {
    const r = resolveApprovalAttachmentStore({
      NODE_ENV: 'development',
      APPROVAL_ATTACHMENT_STORAGE_PROVIDER: 'local',
      APPROVAL_ATTACHMENT_LOCAL_ROOT: root,
    } as NodeJS.ProcessEnv)
    expect(r.kind).toBe('local')
    expect(r.store).not.toBeNull()
  })

  test('list is prefix-scoped: non-approval sibling files are never enumerated', async () => {
    const k = deriveStorageKey('text/plain')
    await store.put(k, Buffer.from('in-prefix'))
    // Write a sibling outside the approval/ prefix under the same root
    const fs = await import('node:fs/promises')
    await fs.writeFile(path.join(root, 'other-product-blob.bin'), Buffer.from('outside'))
    const listed = await store.list()
    expect(listed.some((b) => b.key === k)).toBe(true)
    expect(listed.every((b) => b.key.startsWith('approval/'))).toBe(true)
    expect(listed.some((b) => b.key.includes('other-product'))).toBe(false)
    await store.delete(k)
  })

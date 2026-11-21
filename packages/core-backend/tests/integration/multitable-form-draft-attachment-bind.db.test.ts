/**
 * Draft attachments bound on write (real DB).
 *
 * A file uploaded before its record exists — the workbench form view creating a new record uploads with no
 * recordId — is stored as a draft (`multitable_attachments.record_id` NULL). Nothing bound it when the form was
 * submitted, and the draft sweep (`cleanupOrphanMultitableAttachments`, on by default when NODE_ENV=production)
 * deletes drafts older than the retention time without looking at any record's list: the file was deleted about
 * a day after it was saved, while the record still listed its id.
 *
 * Every record write that stores attachment ids now binds the writer's own drafts among them to the record
 * (`bindOwnDraftAttachments`): form submit (create and edit), POST /records, PATCH /records/:id and the bulk
 * POST /patch. Everything is driven through the real routes; the first test uploads through the real upload
 * route, the others seed the draft row the way that route writes it (created_by = the uploader's id).
 *
 * Runs only with DATABASE_URL (tasks-realdb.yml, its own step).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import * as fsp from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { cleanupOrphanMultitableAttachments } from '../../src/multitable/attachment-orphan-retention'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE = `base_o2bind_${TS}`
const SHEET = `sheet_o2bind_${TS}`
const FLD_NAME = `fld_o2bind_name_${TS}`
const FLD_FILES = `fld_o2bind_files_${TS}`
const FORM_VIEW = `view_o2bind_form_${TS}`
const PUBLIC_VIEW = `view_o2bind_public_${TS}`
const PUB_TOKEN = `pub_o2bind_${TS}`
const MEMBER = `u_o2bind_member_${TS}`
const OTHER = `u_o2bind_other_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

let app: Express
let attachmentDir = ''
let currentUser: { id: string; roles: string[]; perms: string[] } | undefined
const asUser = (id: string): void => {
  currentUser = { id, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
}
const asAnonymous = (): void => { currentUser = undefined }

let seedCounter = 0
function nextId(prefix: string): string {
  seedCounter += 1
  return `${prefix}_o2bind_${TS}_${seedCounter}`
}

type AttachmentRow = { record_id: string | null; field_id: string | null; created_by: string | null; deleted_at: unknown }

async function attachmentRow(id: string): Promise<AttachmentRow | undefined> {
  const r = await q('SELECT record_id, field_id, created_by, deleted_at FROM multitable_attachments WHERE id = $1', [id])
  return r.rows[0] as AttachmentRow | undefined
}

/** A draft row as the upload route writes it with no recordId (attachment-service.ts storeAttachment). */
async function seedDraft(uploader: string, fieldId: string | null = FLD_FILES): Promise<string> {
  const id = nextId('att')
  await q(
    `INSERT INTO multitable_attachments
       (id, sheet_id, record_id, field_id, storage_file_id, filename, original_name, mime_type, size, storage_path, storage_provider, metadata, created_by)
     VALUES ($1,$2,NULL,$3,$4,'draft.txt','draft.txt','text/plain',5,$5,'local','{}'::jsonb,$6)`,
    [id, SHEET, fieldId, `storage_${id}`, `${SHEET}/${id}.txt`, uploader],
  )
  return id
}

async function uploadDraft(name: string): Promise<string> {
  const res = await request(app)
    .post('/api/multitable/attachments')
    .field('sheetId', SHEET)
    .field('fieldId', FLD_FILES)
    .attach('file', Buffer.from(`content of ${name}`), name)
  expect(res.status).toBe(201)
  return String((res.body as { data?: { attachment?: { id?: string } } }).data?.attachment?.id)
}

async function submitForm(body: Record<string, unknown>, viewId: string = FORM_VIEW): Promise<{ id: string; version: number }> {
  const res = await request(app).post(`/api/multitable/views/${viewId}/submit`).send(body)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  const record = (res.body as { data?: { record?: { id?: string; version?: number } } }).data?.record
  return { id: String(record?.id), version: Number(record?.version) }
}

async function createRecord(data: Record<string, unknown>): Promise<string> {
  const res = await request(app).post('/api/multitable/records').send({ sheetId: SHEET, data })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return String((res.body as { data?: { record?: { id?: string } } }).data?.record?.id)
}

async function backdate(ids: string[]): Promise<void> {
  await q(`UPDATE multitable_attachments SET created_at = now() - interval '48 hours' WHERE id = ANY($1::text[])`, [ids])
}

describeIfDatabase('draft attachments are bound to the record they are saved into (real DB)', () => {
  beforeAll(async () => {
    // The route module reads ATTACHMENT_PATH when it loads: point it at a temporary directory first.
    attachmentDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'o2-draft-bind-'))
    process.env.ATTACHMENT_PATH = attachmentDir
    const { univerMetaRouter } = await import('../../src/routes/univer-meta')

    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      if (currentUser) (req as unknown as { user?: unknown }).user = currentUser
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'O2 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'O2 Sheet'])
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_NAME, SHEET, 'Name', 'string', '{}', 1],
    )
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_FILES, SHEET, 'Files', 'attachment', '{}', 2],
    )
    await q(
      'INSERT INTO meta_views (id, sheet_id, name, type, config) VALUES ($1,$2,$3,$4,$5::jsonb)',
      [FORM_VIEW, SHEET, 'Form', 'form', '{}'],
    )
    await q(
      'INSERT INTO meta_views (id, sheet_id, name, type, config) VALUES ($1,$2,$3,$4,$5::jsonb)',
      [PUBLIC_VIEW, SHEET, 'Public form', 'form', JSON.stringify({ publicForm: { enabled: true, publicToken: PUB_TOKEN, accessMode: 'public' } })],
    )
    for (const userId of [MEMBER, OTHER]) {
      await q(
        "INSERT INTO users (id, password_hash, permissions) VALUES ($1,'x',$2::jsonb) ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions, is_active = TRUE",
        [userId, JSON.stringify(['multitable:read', 'multitable:write'])],
      )
    }
  })

  afterAll(async () => {
    await q('DELETE FROM multitable_attachments WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[MEMBER, OTHER]]).catch(() => {})
    if (attachmentDir) await fsp.rm(attachmentDir, { recursive: true, force: true }).catch(() => {})
    delete process.env.ATTACHMENT_PATH
  })

  test('sentinel: DATABASE_URL is set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('form view, new record: the uploaded file is bound to the new record and the draft sweep keeps it', async () => {
    asUser(MEMBER)
    const saved = await uploadDraft('saved.txt')
    const neverSaved = await uploadDraft('never-saved.txt')
    // The upload route stores both as drafts of their uploader.
    expect(await attachmentRow(saved)).toMatchObject({ record_id: null, field_id: FLD_FILES, created_by: MEMBER })
    expect(await attachmentRow(neverSaved)).toMatchObject({ record_id: null, created_by: MEMBER })

    const record = await submitForm({ data: { [FLD_NAME]: 'with a file', [FLD_FILES]: [saved] } })

    expect(await attachmentRow(saved)).toMatchObject({ record_id: record.id, field_id: FLD_FILES, deleted_at: null })
    expect(await attachmentRow(neverSaved)).toMatchObject({ record_id: null, deleted_at: null })

    // Both older than the retention time; the sweep deletes the draft nobody saved and keeps the saved file.
    await backdate([saved, neverSaved])
    const paths = await q('SELECT id, storage_path FROM multitable_attachments WHERE id = ANY($1::text[])', [[saved, neverSaved]])
    const pathOf = new Map((paths.rows as Array<{ id: string; storage_path: string }>).map((row) => [row.id, row.storage_path]))
    const deletedPaths: string[] = []
    await cleanupOrphanMultitableAttachments({
      retentionHours: 24,
      batchSize: 1000,
      storage: { delete: async (_fileId: string, storagePath: string) => { deletedPaths.push(storagePath) } },
    })
    expect((await attachmentRow(neverSaved))?.deleted_at).not.toBeNull()
    expect(deletedPaths).toContain(pathOf.get(neverSaved))
    expect((await attachmentRow(saved))?.deleted_at).toBeNull()
    expect(deletedPaths).not.toContain(pathOf.get(saved))

    const live = await q('SELECT data FROM meta_records WHERE id = $1', [record.id])
    expect((live.rows[0] as { data: Record<string, unknown> }).data[FLD_FILES]).toEqual([saved])
  })

  test('form view, edit: a draft added to an existing record is bound to it', async () => {
    asUser(MEMBER)
    const record = await submitForm({ data: { [FLD_NAME]: 'no files yet' } })
    const draft = await seedDraft(MEMBER)

    await submitForm({ recordId: record.id, expectedVersion: record.version, data: { [FLD_FILES]: [draft] } })

    expect(await attachmentRow(draft)).toMatchObject({ record_id: record.id, field_id: FLD_FILES })
  })

  test('a draft with no field pin is bound and pinned to the field it was saved into', async () => {
    asUser(MEMBER)
    const draft = await seedDraft(MEMBER, null)

    const record = await submitForm({ data: { [FLD_FILES]: [draft] } })

    expect(await attachmentRow(draft)).toMatchObject({ record_id: record.id, field_id: FLD_FILES })
  })

  test("another user's draft is saved into the record but not bound", async () => {
    asUser(MEMBER)
    const othersDraft = await seedDraft(OTHER)

    await submitForm({ data: { [FLD_FILES]: [othersDraft] } })

    expect(await attachmentRow(othersDraft)).toMatchObject({ record_id: null, created_by: OTHER })
  })

  test('an anonymous public-form submission binds nothing', async () => {
    const draft = await seedDraft(MEMBER)
    asAnonymous()

    await submitForm({ publicToken: PUB_TOKEN, data: { [FLD_FILES]: [draft] } }, PUBLIC_VIEW)

    expect(await attachmentRow(draft)).toMatchObject({ record_id: null })
  })

  test('POST /records binds the writer\'s draft to the created record', async () => {
    asUser(MEMBER)
    const draft = await seedDraft(MEMBER)

    const recordId = await createRecord({ [FLD_FILES]: [draft] })

    expect(await attachmentRow(draft)).toMatchObject({ record_id: recordId, field_id: FLD_FILES })
  })

  test('PATCH /records/:id binds the writer\'s draft to the patched record', async () => {
    asUser(MEMBER)
    const recordId = await createRecord({ [FLD_NAME]: 'patch target' })
    const draft = await seedDraft(MEMBER)

    const res = await request(app).patch(`/api/multitable/records/${recordId}`).send({ sheetId: SHEET, data: { [FLD_FILES]: [draft] } })
    expect(res.status, JSON.stringify(res.body)).toBe(200)

    expect(await attachmentRow(draft)).toMatchObject({ record_id: recordId, field_id: FLD_FILES })
  })

  test('bulk POST /patch binds the writer\'s draft to the patched record', async () => {
    asUser(MEMBER)
    const recordId = await createRecord({ [FLD_NAME]: 'bulk target' })
    const draft = await seedDraft(MEMBER)

    const res = await request(app).post('/api/multitable/patch').send({
      sheetId: SHEET,
      changes: [{ recordId, fieldId: FLD_FILES, value: [draft] }],
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)

    expect(await attachmentRow(draft)).toMatchObject({ record_id: recordId, field_id: FLD_FILES })
  })

  test('once bound, deleting the file takes it out of the record and moves the record version', async () => {
    asUser(MEMBER)
    const draft = await seedDraft(MEMBER)
    const record = await submitForm({ data: { [FLD_FILES]: [draft] } })

    const res = await request(app).delete(`/api/multitable/attachments/${draft}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)

    const live = await q('SELECT data, version FROM meta_records WHERE id = $1', [record.id])
    const row = live.rows[0] as { data: Record<string, unknown>; version: number }
    expect(row.data[FLD_FILES]).toEqual([])
    expect(Number(row.version)).toBe(record.version + 1)
  })
})

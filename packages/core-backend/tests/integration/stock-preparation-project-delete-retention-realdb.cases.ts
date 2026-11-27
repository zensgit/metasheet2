import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Express } from 'express'
import request from 'supertest'
import { expect, test } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import type { ProjectDeleteTestStack } from './stock-preparation-project-delete-realdb.cases'

type Scope = { tenantId: string; projectNo: string; actor: string }
const q = (sql: string, args: unknown[] = []) => poolManager.get().query(sql, args)

export function registerProjectDeleteRetentionCases(getFixture: () => ProjectDeleteTestStack,
  newScope: (no: string) => Scope, app: () => Express, snapshot: (scope: Scope, sheetId: string, ids: string[]) => Promise<unknown>) {
  test.each(['before preview', 'before confirmation'] as const)('retains attachment bytes and both project snapshots %s', async when => {
    const fixture = getFixture()
    const scope = newScope('attached')
    const control = { ...scope, projectNo: 'attached-control' }
    const clean = newScope('no-dependencies')
    const targetSheet = await fixture.dedicated(scope)
    const controlSheet = await fixture.dedicated(control)
    await fixture.dedicated(clean)
    const oldPath = process.env.ATTACHMENT_PATH
    const root = await mkdtemp(join(tmpdir(), 'stock-prep-retention-'))
    process.env.ATTACHMENT_PATH = root
    const api = request(app())
    const ids: string[] = []
    const schemaField = async (sheetId: string) => {
      const id = 'attachment-' + randomUUID()
      await q('INSERT INTO meta_fields(id,sheet_id,name,type,property,"order") VALUES($1,$2,$3,$4,$5,1000)', [id, sheetId, 'Files', 'attachment', {}])
      return id
    }
    const upload = async (sheet: typeof targetSheet, field: string, bytes: string) => {
      const result = await api.post('/api/multitable/attachments').field('sheetId', sheet.sheetId)
        .field('recordId', sheet.ids[0]).field('fieldId', field).attach('file', Buffer.from(bytes), 'synthetic.txt').expect(201)
      const id = result.body.data.attachment.id as string
      ids.push(id)
      return id
    }
    const download = async (id: string) => {
      const response = await api.get('/api/multitable/attachments/' + id).expect(200)
      return Buffer.isBuffer(response.body) ? response.body.toString('utf8') : response.text
    }
    try {
      const targetField = await schemaField(targetSheet.sheetId)
      const controlField = await schemaField(controlSheet.sheetId)
      const neighborFile = await upload(controlSheet, controlField, 'control file')
      const preview = when === 'before confirmation' ? await fixture.service.preview(scope) : null
      const targetFile = await upload(targetSheet, targetField, 'target file')
      const state = () => Promise.all([snapshot(scope, targetSheet.sheetId, targetSheet.ids), snapshot(control, controlSheet.sheetId, controlSheet.ids)])
      const retained = await state()
      const refusal = { status: 409, code: 'STOCK_PREPARATION_PROJECT_DELETE_DEPENDENCY', details: { reason: 'attachment' } }
      if (preview) await expect(fixture.service.confirm({ ...scope, ...preview })).rejects.toMatchObject(refusal)
      else {
        await expect(fixture.service.preview(scope)).rejects.toMatchObject(refusal)
        expect((await q('SELECT id FROM integration_stock_prep_project_delete_challenges WHERE tenant_id=$1 AND project_no=$2', [scope.tenantId, scope.projectNo])).rowCount).toBe(0)
      }
      expect(await state()).toEqual(retained)
      expect(await download(targetFile)).toBe('target file')
      expect(await download(neighborFile)).toBe('control file')
      expect((await q("SELECT id FROM integration_stock_prep_audit WHERE tenant_id=$1 AND project_id=$2 AND action='project_delete'", [scope.tenantId, scope.projectNo])).rowCount).toBe(0)
      const allowed = await fixture.service.preview(clean)
      expect((await fixture.service.confirm({ ...clean, ...allowed })).counts.dedicatedSheets).toBe(1)
    } finally {
      await q('DELETE FROM multitable_attachments WHERE id=ANY($1::text[])', [ids])
      if (oldPath === undefined) delete process.env.ATTACHMENT_PATH
      else process.env.ATTACHMENT_PATH = oldPath
      await rm(root, { recursive: true, force: true })
    }
  }, 60000)
}

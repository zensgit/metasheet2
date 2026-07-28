/**
 * FWB production authoring — POST /sheets/:sheetId/automations/fwb/confirm
 *
 * Server owns confirmationHash via deriveFwbConfirmationHash. The route must:
 *   - refuse while APPROVAL_FWB_WRITEBACK_ENABLED is OFF (default);
 *   - require canManageAutomation;
 *   - refuse exact-number mappings (PROPOSED decimal lock);
 *   - return a server-derived hash bound to template/version/target sheet+base/mappings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAutomationRoutes } from '../../src/routes/automation'
import { deriveFwbConfirmationHash } from '../../src/multitable/approval-fwb-activation'
import { usePinnedServer } from '../utils/pinned-server'

const resolveSheetCapabilities = vi.fn()
vi.mock('../../src/multitable/permission-service', () => ({
  resolveSheetCapabilities: (...args: unknown[]) => resolveSheetCapabilities(...args),
}))

const canReadApprovalTemplateForAutomation = vi.fn()
vi.mock('../../src/multitable/automation-approval-template-access', () => ({
  canReadApprovalTemplateForAutomation: (...args: unknown[]) => canReadApprovalTemplateForAutomation(...args),
}))

const query = vi.fn()
vi.mock('../../src/integration/db/connection-pool', () => {
  const client = { query: (...args: unknown[]) => query(...args), getInternalPool: () => null }
  return { poolManager: { get: () => client } }
})

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/multitable', createAutomationRoutes({} as never))
  return app
}

const pinned = usePinnedServer()

describe('POST /sheets/:sheetId/automations/fwb/confirm', () => {
  const prev = process.env.APPROVAL_FWB_WRITEBACK_ENABLED

  beforeEach(() => {
    resolveSheetCapabilities.mockReset()
    canReadApprovalTemplateForAutomation.mockReset()
    canReadApprovalTemplateForAutomation.mockResolvedValue(true)
    query.mockReset()
    resolveSheetCapabilities.mockResolvedValue({
      access: { userId: 'author_1' },
      capabilities: { canManageAutomation: true, canManageSheetAccess: true },
    })
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM meta_sheets')) {
        return { rows: [{ base_id: params?.[0] === 'sheet_target' ? 'base_target' : 'base_1' }] }
      }
      if (sql.includes('FROM approval_templates')) {
        return {
          rows: [{
            active_version_id: 'ver_1',
            form_schema: {
              fields: [
                { id: 'f1' },
                { id: 'f2' },
                {
                  id: 'linked',
                  type: 'record-link',
                  props: { baseId: 'base_target', sheetId: 'sheet_target' },
                },
              ],
            },
          }],
        }
      }
      if (sql.includes('FROM meta_fields')) {
        return {
          rows: [
            { id: 't1', type: 'string', property: {} },
            { id: 't2', type: 'string', property: {} },
            { id: 't_select', type: 'select', property: { options: [{ value: 'open' }] } },
          ],
        }
      }
      return { rows: [] }
    })
  })

  afterEach(() => {
    if (prev === undefined) delete process.env.APPROVAL_FWB_WRITEBACK_ENABLED
    else process.env.APPROVAL_FWB_WRITEBACK_ENABLED = prev
  })

  it('returns 403 while the feature flag is OFF (default)', async () => {
    delete process.env.APPROVAL_FWB_WRITEBACK_ENABLED
    pinned.setApp(buildApp())
    const res = await request(pinned.url())
      .post('/api/multitable/sheets/sheet_1/automations/fwb/confirm')
      .send({
        templateId: 'tpl_1',
        sourceTemplateVersionId: 'ver_1',
        mappings: [{ formFieldId: 'f1', targetFieldId: 't1', targetType: 'text' }],
      })
      .expect(403)
    expect(res.body.error?.code).toBe('FWB_WRITEBACK_DISABLED')
  })

  it('returns the server-derived confirmation hash when flag is ON', async () => {
    process.env.APPROVAL_FWB_WRITEBACK_ENABLED = 'true'
    pinned.setApp(buildApp())
    const mappings = [{ formFieldId: 'f1', targetFieldId: 't1', targetType: 'text' as const }]
    const res = await request(pinned.url())
      .post('/api/multitable/sheets/sheet_1/automations/fwb/confirm')
      .send({
        templateId: 'tpl_1',
        sourceTemplateVersionId: 'ver_1',
        mappings,
      })
      .expect(200)

    const expected = deriveFwbConfirmationHash({
      templateId: 'tpl_1',
      sourceTemplateVersionId: 'ver_1',
      targetBaseId: 'base_1',
      targetSheetId: 'sheet_1',
      mappings,
    })
    expect(res.body.confirmationHash).toBe(expected)
    expect(res.body).toMatchObject({
      templateId: 'tpl_1',
      sourceTemplateVersionId: 'ver_1',
      targetSheetId: 'sheet_1',
      targetBaseId: 'base_1',
    })
    const auditCall = query.mock.calls.find(([sql]) => String(sql).includes('operation_audit_logs'))
    expect(auditCall).toBeTruthy()
    expect(auditCall?.[1]?.[0]).toBe('author_1')
    expect(auditCall?.[1]?.[1]).toBe('sheet_1')
    expect(JSON.parse(String(auditCall?.[1]?.[2]))).toEqual({
      templateId: 'tpl_1',
      sourceTemplateVersionId: 'ver_1',
      targetBaseId: 'base_1',
      targetSheetId: 'sheet_1',
      formFieldIds: ['f1'],
      targetFieldIds: ['t1'],
      confirmationHash: expected,
    })
  })

  it('derives update confirmation from the template-pinned record-link target', async () => {
    process.env.APPROVAL_FWB_WRITEBACK_ENABLED = 'true'
    pinned.setApp(buildApp())
    const mappings = [{ formFieldId: 'f1', targetFieldId: 't1', targetType: 'text' as const }]
    const res = await request(pinned.url())
      .post('/api/multitable/sheets/sheet_1/automations/fwb/confirm')
      .send({
        templateId: 'tpl_1',
        sourceTemplateVersionId: 'ver_1',
        mode: 'update',
        recordLinkFieldId: 'linked',
        mappings,
      })
      .expect(200)

    const expected = deriveFwbConfirmationHash({
      templateId: 'tpl_1',
      sourceTemplateVersionId: 'ver_1',
      targetBaseId: 'base_target',
      targetSheetId: 'sheet_target',
      mappings,
      mode: 'update',
      recordLinkFieldId: 'linked',
    })
    expect(res.body).toMatchObject({
      confirmationHash: expected,
      targetBaseId: 'base_target',
      targetSheetId: 'sheet_target',
    })
    expect(resolveSheetCapabilities).toHaveBeenCalledTimes(2)
    expect(resolveSheetCapabilities.mock.calls[1]?.[2]).toBe('sheet_target')
    const auditCall = query.mock.calls.find(([sql]) => String(sql).includes('operation_audit_logs'))
    expect(JSON.parse(String(auditCall?.[1]?.[2]))).toMatchObject({
      targetBaseId: 'base_target',
      targetSheetId: 'sheet_target',
      mode: 'update',
      recordLinkFieldId: 'linked',
      confirmationHash: expected,
    })
  })

  it('refuses an update target that is not a pinned record-link field', async () => {
    process.env.APPROVAL_FWB_WRITEBACK_ENABLED = 'true'
    pinned.setApp(buildApp())
    const res = await request(pinned.url())
      .post('/api/multitable/sheets/sheet_1/automations/fwb/confirm')
      .send({
        templateId: 'tpl_1',
        sourceTemplateVersionId: 'ver_1',
        mode: 'update',
        recordLinkFieldId: 'f1',
        mappings: [{ formFieldId: 'f1', targetFieldId: 't1', targetType: 'text' }],
      })
      .expect(404)
    expect(res.body.error?.code).toBe('FWB_TARGET_UNAVAILABLE')
    expect(query.mock.calls.some(([sql]) => String(sql).includes('operation_audit_logs'))).toBe(false)
  })

  it('refuses update confirmation when the author cannot manage the pinned target sheet', async () => {
    process.env.APPROVAL_FWB_WRITEBACK_ENABLED = 'true'
    resolveSheetCapabilities
      .mockResolvedValueOnce({
        access: { userId: 'author_1' },
        capabilities: { canManageAutomation: true, canManageSheetAccess: true },
      })
      .mockResolvedValueOnce({
        access: { userId: 'author_1' },
        capabilities: { canManageAutomation: false, canManageSheetAccess: false },
      })
    pinned.setApp(buildApp())
    await request(pinned.url())
      .post('/api/multitable/sheets/sheet_1/automations/fwb/confirm')
      .send({
        templateId: 'tpl_1',
        sourceTemplateVersionId: 'ver_1',
        mode: 'update',
        recordLinkFieldId: 'linked',
        mappings: [{ formFieldId: 'f1', targetFieldId: 't1', targetType: 'text' }],
      })
      .expect(403)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('operation_audit_logs'))).toBe(false)
  })

  it('rejects exact-number mappings (decimal lock)', async () => {
    process.env.APPROVAL_FWB_WRITEBACK_ENABLED = 'true'
    pinned.setApp(buildApp())
    const res = await request(pinned.url())
      .post('/api/multitable/sheets/sheet_1/automations/fwb/confirm')
      .send({
        templateId: 'tpl_1',
        sourceTemplateVersionId: 'ver_1',
        mappings: [{ formFieldId: 'f1', targetFieldId: 't1', targetType: 'number' }],
      })
      .expect(400)
    expect(res.body.error?.code).toBe('FWB_EXACT_NUMBER_UNAVAILABLE')
  })

  it('stale subject (different mapping) yields a different hash', async () => {
    process.env.APPROVAL_FWB_WRITEBACK_ENABLED = 'true'
    pinned.setApp(buildApp())
    const a = await request(pinned.url())
      .post('/api/multitable/sheets/sheet_1/automations/fwb/confirm')
      .send({
        templateId: 'tpl_1',
        sourceTemplateVersionId: 'ver_1',
        mappings: [{ formFieldId: 'f1', targetFieldId: 't1', targetType: 'text' }],
      })
      .expect(200)
    const b = await request(pinned.url())
      .post('/api/multitable/sheets/sheet_1/automations/fwb/confirm')
      .send({
        templateId: 'tpl_1',
        sourceTemplateVersionId: 'ver_1',
        mappings: [{ formFieldId: 'f1', targetFieldId: 't2', targetType: 'text' }],
      })
      .expect(200)
    expect(a.body.confirmationHash).not.toBe(b.body.confirmationHash)
  })

  it('refuses authors without canManageAutomation', async () => {
    process.env.APPROVAL_FWB_WRITEBACK_ENABLED = 'true'
    resolveSheetCapabilities.mockResolvedValue({ capabilities: { canManageAutomation: false } })
    pinned.setApp(buildApp())
    await request(pinned.url())
      .post('/api/multitable/sheets/sheet_1/automations/fwb/confirm')
      .send({
        templateId: 'tpl_1',
        sourceTemplateVersionId: 'ver_1',
        mappings: [{ formFieldId: 'f1', targetFieldId: 't1', targetType: 'text' }],
      })
      .expect(403)
  })

  it('refuses automation managers who lack target-sheet access management', async () => {
    process.env.APPROVAL_FWB_WRITEBACK_ENABLED = 'true'
    resolveSheetCapabilities.mockResolvedValue({
      access: { userId: 'author_1' },
      capabilities: { canManageAutomation: true, canManageSheetAccess: false },
    })
    pinned.setApp(buildApp())
    await request(pinned.url())
      .post('/api/multitable/sheets/sheet_1/automations/fwb/confirm')
      .send({
        templateId: 'tpl_1',
        sourceTemplateVersionId: 'ver_1',
        mappings: [{ formFieldId: 'f1', targetFieldId: 't1', targetType: 'text' }],
      })
      .expect(403)
  })

  it('fails source authorization indistinguishably before reading template schema', async () => {
    process.env.APPROVAL_FWB_WRITEBACK_ENABLED = 'true'
    canReadApprovalTemplateForAutomation.mockResolvedValue(false)
    pinned.setApp(buildApp())
    const res = await request(pinned.url())
      .post('/api/multitable/sheets/sheet_1/automations/fwb/confirm')
      .send({
        templateId: 'tpl_hidden_or_missing',
        sourceTemplateVersionId: 'ver_1',
        mappings: [{ formFieldId: 'f1', targetFieldId: 't1', targetType: 'text' }],
      })
      .expect(404)

    expect(res.body.error?.code).toBe('FWB_SOURCE_UNAVAILABLE')
    expect(query.mock.calls.some(([sql]) => String(sql).includes('FROM approval_templates'))).toBe(false)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('FROM meta_fields'))).toBe(false)
  })

  it('rejects a stale template version instead of issuing a doomed confirmation', async () => {
    process.env.APPROVAL_FWB_WRITEBACK_ENABLED = 'true'
    pinned.setApp(buildApp())
    const res = await request(pinned.url())
      .post('/api/multitable/sheets/sheet_1/automations/fwb/confirm')
      .send({
        templateId: 'tpl_1',
        sourceTemplateVersionId: 'ver_old',
        mappings: [{ formFieldId: 'f1', targetFieldId: 't1', targetType: 'text' }],
      })
      .expect(409)
    expect(res.body.error?.code).toBe('FWB_SOURCE_VERSION_STALE')
  })

  it('rejects source-field drift instead of issuing a doomed confirmation', async () => {
    process.env.APPROVAL_FWB_WRITEBACK_ENABLED = 'true'
    pinned.setApp(buildApp())
    const res = await request(pinned.url())
      .post('/api/multitable/sheets/sheet_1/automations/fwb/confirm')
      .send({
        templateId: 'tpl_1',
        sourceTemplateVersionId: 'ver_1',
        mappings: [{ formFieldId: 'removed_field', targetFieldId: 't1', targetType: 'text' }],
      })
      .expect(409)
    expect(res.body.error?.code).toBe('FWB_SOURCE_SCHEMA_STALE')
  })

  it('rejects target type and select-option drift instead of issuing a doomed confirmation', async () => {
    process.env.APPROVAL_FWB_WRITEBACK_ENABLED = 'true'
    pinned.setApp(buildApp())
    const typeDrift = await request(pinned.url())
      .post('/api/multitable/sheets/sheet_1/automations/fwb/confirm')
      .send({
        templateId: 'tpl_1',
        sourceTemplateVersionId: 'ver_1',
        mappings: [{ formFieldId: 'f1', targetFieldId: 't1', targetType: 'date' }],
      })
      .expect(409)
    expect(typeDrift.body.error?.code).toBe('FWB_TARGET_SCHEMA_STALE')

    const optionDrift = await request(pinned.url())
      .post('/api/multitable/sheets/sheet_1/automations/fwb/confirm')
      .send({
        templateId: 'tpl_1',
        sourceTemplateVersionId: 'ver_1',
        mappings: [{
          formFieldId: 'f1',
          targetFieldId: 't_select',
          targetType: 'select',
          selectOptions: ['deleted-option'],
        }],
      })
      .expect(409)
    expect(optionDrift.body.error?.code).toBe('FWB_TARGET_SCHEMA_STALE')
  })

  it('fails closed when the values-free confirmation audit cannot be persisted', async () => {
    process.env.APPROVAL_FWB_WRITEBACK_ENABLED = 'true'
    const defaultQuery = query.getMockImplementation()
    query.mockImplementation(async (...args: unknown[]) => {
      if (String(args[0]).includes('operation_audit_logs')) throw new Error('audit unavailable')
      if (!defaultQuery) return { rows: [] }
      return defaultQuery(...args)
    })
    pinned.setApp(buildApp())
    const res = await request(pinned.url())
      .post('/api/multitable/sheets/sheet_1/automations/fwb/confirm')
      .send({
        templateId: 'tpl_1',
        sourceTemplateVersionId: 'ver_1',
        mappings: [{ formFieldId: 'f1', targetFieldId: 't1', targetType: 'text' }],
      })
      .expect(503)
    expect(res.body.error?.code).toBe('DB_NOT_READY')
    expect(res.body.confirmationHash).toBeUndefined()
  })
})

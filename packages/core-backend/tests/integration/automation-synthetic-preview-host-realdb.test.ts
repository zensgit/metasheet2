// C1/S2 first slice — C01 host half: the synthetic integration preview through the ACTUAL MetaSheetServer
// (real JWT login, real route mount, real AutomationService-owned runtime, fully migrated PostgreSQL):
//   - switch OFF: the fixed 404 for preview and catalog, nothing written;
//   - switch ON: a two-page synthetic read becomes a YiDa pure preview; business network 0 (the host fetch
//     refuses and is counted); business rows, YiDa draft / approval / initialization / delivery tables and
//     record rows unchanged; exactly one values-free summary execution row; the preview digest equals the
//     pure compiler on the same synthetic rows;
//   - a live user without automation capability is 403 before the service.
// The browser half (real Chromium driving MetaAutomationIntegrationPreview) is NOT in this file; see the
// slice report. Only rows this file seeded are removed afterwards.
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { syntheticMaterialFixture, syntheticYidaMappingPreset } from '../../src/integration/automation-operation-catalog'
import { bootYidaHostBoundaryServer, type YidaHostBoundaryHarness } from '../utils/yida-host-boundary-server'

it('sentinel: the synthetic preview host proof requires EXPECT_DB=1 and a dedicated DATABASE_URL', () => {
  expect(process.env.EXPECT_DB).toBe('1')
  expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})
const databaseSuite = process.env.EXPECT_DB === '1' && process.env.DATABASE_URL ? describe : describe.skip
const FLAG = 'AUTOMATION_SYNTHETIC_INTEGRATION_PREVIEW_ENABLED'
const BODY = { planId: 'plm-material-to-yida-preview.v1', fixtureId: 'synthetic-materials.two-page.v1', mappingPresetId: 'yida-material-v3.original.v1' }
const VALUE_MARKERS = /SYN-DRW|SYN-LINE|SYN-SPEC|合成部件|SYN-MAT/

databaseSuite('synthetic integration preview — actual MetaSheetServer', () => {
  let h: YidaHostBoundaryHarness
  const savedFlag = process.env[FLAG]
  const sheetId = `sheet_synthetic_preview_${randomUUID().replace(/-/g, '')}`
  const ruleId = `atr_synthetic_preview_${randomUUID().replace(/-/g, '')}`
  const previewPath = `/api/multitable/sheets/${sheetId}/automations/${ruleId}/integration-preview`
  const catalogPath = `/api/multitable/sheets/${sheetId}/automations/integration-preview/catalog`

  async function businessCounts(): Promise<Record<string, number>> {
    const counts: Record<string, number> = { ...(await h.yidaTableCounts()) }
    for (const table of ['meta_records', 'automation_rules', 'meta_sheets', 'multitable_automation_jobs', 'meta_automation_outbox']) {
      const exists = (await h.pool.query('SELECT to_regclass($1) AS name', [table])).rows[0]?.name
      if (exists) counts[table] = Number((await h.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n)
    }
    return counts
  }
  async function summaryRows() {
    return (await h.pool.query('SELECT * FROM multitable_automation_executions WHERE rule_id = $1 ORDER BY triggered_at', [ruleId])).rows
  }

  beforeAll(async () => {
    delete process.env[FLAG]
    h = await bootYidaHostBoundaryServer()
    await h.pool.query('INSERT INTO meta_sheets (id, name) VALUES ($1, $2)', [sheetId, 'Synthetic preview sheet'])
    await h.pool.query(`INSERT INTO automation_rules (id, sheet_id, name, trigger_type, trigger_config, action_type, action_config, enabled, created_by)
      VALUES ($1, $2, 'Synthetic preview rule', 'record.created', '{}'::jsonb, 'send_webhook', '{}'::jsonb, false, $3)`, [ruleId, sheetId, h.admin.id])
  }, 120000)

  afterAll(async () => {
    try {
      if (h) {
        await h.pool.query('DELETE FROM multitable_automation_executions WHERE rule_id = $1', [ruleId])
        await h.pool.query('DELETE FROM automation_rules WHERE id = $1', [ruleId])
        await h.pool.query('DELETE FROM meta_sheets WHERE id = $1', [sheetId])
      }
    } finally {
      if (savedFlag === undefined) delete process.env[FLAG]
      else process.env[FLAG] = savedFlag
      await h?.cleanup()
    }
  }, 60000)

  it('switch OFF (and every other automation/YiDa switch ON): fixed 404 for preview and catalog, nothing written', async () => {
    const before = await businessCounts()
    const others = ['INTEGRATION_YIDA_OWNER_SEND_ENABLED', 'INTEGRATION_YIDA_CONNECTION_TEST_ENABLED', 'INTEGRATION_YIDA_MULTI_TARGET_ENABLED',
      'AUTOMATION_CLASSA_CLAIM_ENABLED', 'AUTOMATION_CLASSB_OUTBOUND_ENABLED', 'AUTOMATION_DURABLE_DELIVERY_ENABLED']
    const saved = Object.fromEntries(others.map((key) => [key, process.env[key]]))
    for (const key of others) process.env[key] = 'true'
    try {
      for (const value of [undefined, 'false', 'TRUE', ' true', '1']) {
        if (value === undefined) delete process.env[FLAG]
        else process.env[FLAG] = value
        const post = await h.http('POST', previewPath, h.admin.token, BODY)
        expect(post.status).toBe(404)
        expect(post.headers['cache-control']).toBe('no-store')
        expect((post.body.error as { code?: string })?.code).toBe('INTEGRATION_PREVIEW_DISABLED')
        const get = await h.http('GET', catalogPath, h.admin.token)
        expect(get.status).toBe(404)
      }
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    expect(await businessCounts()).toEqual(before)
    expect(await summaryRows()).toHaveLength(0)
    expect(h.fetchCalls()).toBe(0)
  })

  it('a live user without automation capability is 403 before the service, switch ON', async () => {
    process.env[FLAG] = 'true'
    const res = await h.http('POST', previewPath, h.reader.token, BODY)
    expect(res.status).toBe(403)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(await summaryRows()).toHaveLength(0)
  })

  it('strict DTO through the real host: an extra field is a fixed 400 with nothing written', async () => {
    process.env[FLAG] = 'true'
    const res = await h.http('POST', previewPath, h.admin.token, { ...BODY, url: 'http://127.0.0.1/' })
    expect(res.status).toBe(400)
    expect((res.body.error as { code?: string })?.code).toBe('INTEGRATION_PREVIEW_INPUT')
    expect(await summaryRows()).toHaveLength(0)
  })

  it('C01: two synthetic pages -> YiDa pure preview; zero network, zero business rows, one values-free summary', async () => {
    process.env[FLAG] = 'true'
    const before = await businessCounts()
    const catalog = await h.http('GET', catalogPath, h.admin.token)
    expect(catalog.status).toBe(200)
    expect((catalog.body.catalog as { fixtureIds: string[] }).fixtureIds).toContain('synthetic-materials.two-page.v1')
    const res = await h.http('POST', previewPath, h.admin.token, BODY)
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).toMatchObject({ ok: true, synthetic: true, canSend: false, canApply: false, tokenIssued: false, externalWriteAttempted: false })
    const summary = res.body.summary as { outcome: string; counts: { pages: number; rows: number } }
    expect(summary.outcome).toBe('OK')
    expect(summary.counts).toMatchObject({ pages: 2, rows: 3 })
    const preview = res.body.preview as { planDigest: string; rowCount: number; rows: Array<{ fields: Record<string, unknown> }> }
    expect(preview.rowCount).toBe(3)
    expect(JSON.stringify(preview.rows)).toMatch(VALUE_MARKERS)

    // The same synthetic rows through the pure compiler directly give the same plan digest.
    const lib = path.resolve(__dirname, '..', '..', '..', '..', 'plugins', 'plugin-integration-core', 'lib', 'yida-draft-compiler.mjs')
    const { compileYidaLocalDraft } = await import(pathToFileURL(lib).href)
    const presetRules = syntheticYidaMappingPreset('yida-material-v3.original.v1')
    const rows = syntheticMaterialFixture('synthetic-materials.two-page.v1').pages.flatMap((page) => page.rows)
    const direct = compileYidaLocalDraft({ config: { ...JSON.parse(JSON.stringify(presetRules.rules)), target: { ...presetRules.target } }, rowsText: JSON.stringify(rows), allocation: { mode: 'original' } })
    expect(preview.planDigest).toBe(direct.planDigest)

    expect(h.fetchCalls()).toBe(0)
    expect(await businessCounts()).toEqual(before)
    const stored = await summaryRows()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ triggered_by: 'integration_preview', status: 'success', trigger_event: null, rule_snapshot: null, initiated_by: h.admin.id })
    expect(JSON.stringify(stored[0])).not.toMatch(VALUE_MARKERS)
  })
})

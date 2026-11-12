import express from 'express'
import request from 'supertest'
import * as XLSX from 'xlsx'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { createRecoveryComputedHelpers, univerMetaRouter } from '../../src/routes/univer-meta'
import { queryRecordsWithCursor } from '../../src/multitable/query-service'

if (process.env.EXPECT_DB === '1' && !process.env.DATABASE_URL) {
  throw new Error('Read/export native acceptance requires DATABASE_URL in the real-DB lane')
}

const prefix = `feedback_${Date.now()}`
const base = `${prefix}_base`
const sheet = `${prefix}_sheet`
const foreign = `${prefix}_foreign`
const privateBase = `${prefix}_private_base`
const secretSheet = `${prefix}_secret_sheet`
const secretRecord = `${prefix}_secret_record`
const actor = `${prefix}_user`
const attachment = `${prefix}_att`
const first = `${prefix}_000001`
const target = `${prefix}_target`
const filtered = `${prefix}_view`
const seedSheet = `${prefix}_seed`
const field = (name: string) => `fld_${prefix}_${name}`
const query = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  req.user = { id: actor, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:base:read'] }
  next()
})
app.use('/api/multitable', univerMetaRouter())

async function exportRows(viewId?: string): Promise<string[][]> {
  const response = await request(app).get(`/api/multitable/sheets/${sheet}/export-xlsx`)
    .query(viewId ? { viewId } : {})
    .buffer(true).parse((stream, done) => {
      const chunks: Buffer[] = []
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      stream.on('end', () => done(null, Buffer.concat(chunks)))
    }).expect(200)
  const workbook = XLSX.read(response.body, { type: 'buffer' })
  return XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: false, defval: '' })
}

describe.skipIf(!process.env.DATABASE_URL)('feedback read/export regressions on PostgreSQL', () => {
  beforeAll(async () => {
    await query('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [base, 'Synthetic feedback'])
    await query('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [privateBase, 'Synthetic private'])
    await query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [secretSheet, privateBase, 'Synthetic secret'])
    for (const sheetId of [sheet, foreign]) {
      await query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [sheetId, base, 'Synthetic'])
    }
    await query("INSERT INTO users (id, name, password_hash) VALUES ($1,'Synthetic Member','x')", [actor])
    const fields: Array<[string, string, Record<string, unknown>]> = [
      ['name', 'string', {}], ['person', 'person', {}], ['attachment', 'attachment', {}],
      ['createdTime', 'createdTime', {}], ['modifiedTime', 'modifiedTime', {}],
      ['createdBy', 'createdBy', {}], ['modifiedBy', 'modifiedBy', {}],
      ['link', 'link', { foreignSheetId: foreign }],
      ['lookup', 'lookup', { linkFieldId: field('link'), foreignSheetId: foreign, targetFieldId: field('foreignName') }],
      ['rollup', 'rollup', { linkFieldId: field('link'), foreignSheetId: foreign, targetFieldId: field('amount'), aggregation: 'sum' }],
      ['lookupCreated', 'lookup', { linkFieldId: field('link'), foreignSheetId: foreign, targetFieldId: field('foreignCreated') }],
      ['countCreated', 'rollup', { linkFieldId: field('link'), foreignSheetId: foreign, targetFieldId: field('foreignCreated'), aggregation: 'count' }],
      ['formulaLookup', 'lookup', { linkFieldId: field('link'), foreignSheetId: foreign, targetFieldId: field('foreignFormula') }],
      ['formulaRollup', 'rollup', { linkFieldId: field('link'), foreignSheetId: foreign, targetFieldId: field('foreignFormula'), aggregation: 'sum' }],
      ['formulaFilter', 'rollup', { linkFieldId: field('link'), foreignSheetId: foreign, targetFieldId: field('amount'), aggregation: 'sum', filters: [{ fieldId: field('foreignFormula'), operator: 'is', value: 987655 }] }],
      ['nestedLookup', 'lookup', { linkFieldId: field('link'), foreignSheetId: foreign, targetFieldId: field('foreignLookup') }],
      ['nestedRollup', 'lookup', { linkFieldId: field('link'), foreignSheetId: foreign, targetFieldId: field('foreignRollup') }],
      ['input', 'number', {}],
      ['derived', 'formula', { expression: `={${field('formulaRollup')}}+{${field('input')}}` }],
      ['filteredDerived', 'formula', { expression: `={${field('formulaFilter')}}+{${field('input')}}` }],
    ]
    for (const [index, [name, type, property]] of fields.entries()) {
      await query('INSERT INTO meta_fields (id,sheet_id,name,type,property,"order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [field(name), sheet, name, type, JSON.stringify(property), index])
    }
    for (const [name, type] of [['foreignName', 'string'], ['amount', 'number'], ['foreignCreated', 'createdTime']]) {
      await query('INSERT INTO meta_fields (id,sheet_id,name,type,property) VALUES ($1,$2,$3,$4,$5::jsonb)', [field(name), foreign, name, type, '{}'])
    }
    await query('INSERT INTO meta_fields (id,sheet_id,name,type,property) VALUES ($1,$2,$3,$4,$5::jsonb)', [field('secret'), secretSheet, 'Secret', 'number', '{}'])
    await query('INSERT INTO meta_records (id,sheet_id,data) VALUES ($1,$2,$3::jsonb)', [secretRecord, secretSheet, JSON.stringify({ [field('secret')]: 987654 })])
    for (const [name, type, property] of [
      ['foreignLink', 'link', { foreignSheetId: secretSheet }],
      ['foreignLookup', 'lookup', { linkFieldId: field('foreignLink'), foreignSheetId: secretSheet, targetFieldId: field('secret') }],
      ['foreignFormula', 'formula', { expression: `={${field('foreignLookup')}}+1` }],
      ['foreignRollup', 'rollup', { linkFieldId: field('foreignLink'), foreignSheetId: secretSheet, targetFieldId: field('secret'), aggregation: 'sum' }],
    ] as const) {
      await query('INSERT INTO meta_fields (id,sheet_id,name,type,property) VALUES ($1,$2,$3,$4,$5::jsonb)', [field(name), foreign, name, type, JSON.stringify(property)])
    }
    await query("INSERT INTO meta_records (id,sheet_id,data,created_at) VALUES ($1,$2,$3::jsonb,'2026-11-03T01:02:00Z')", [target, foreign, JSON.stringify({ [field('foreignName')]: 'Visible Target', [field('amount')]: 42, [field('foreignFormula')]: 987655, [field('foreignLookup')]: [987654], [field('foreignRollup')]: 987654 })])
    await query('INSERT INTO meta_links (field_id,record_id,foreign_record_id) VALUES ($1,$2,$3)', [field('foreignLink'), target, secretRecord])
    await query('INSERT INTO formula_dependencies (sheet_id,field_id,depends_on_field_id,depends_on_sheet_id) VALUES ($1,$2,$3,$1)', [foreign, field('foreignFormula'), field('foreignLookup')])
    await query(`INSERT INTO meta_records (id,sheet_id,data,created_at,updated_at,created_by,modified_by)
      SELECT $1 || lpad(sequence::text,6,'0'), $2, jsonb_build_object($3::text,'row_' || lpad(sequence::text,6,'0')) || $4::jsonb,
      '2026-11-01T01:02:00Z', '2026-11-02T03:04:00Z', $5, $5 FROM generate_series(1,5006) sequence`,
    [`${prefix}_`, sheet, field('name'), JSON.stringify({ [field('person')]: [actor], [field('attachment')]: [attachment] }), actor])
    await query('INSERT INTO meta_links (field_id,record_id,foreign_record_id) VALUES ($1,$2,$3)', [field('link'), first, target])
    await query('UPDATE meta_records SET data=data || $2::jsonb WHERE id=$1', [first, JSON.stringify({ [field('input')]: 1, [field('derived')]: 987656, [field('filteredDerived')]: 43 })])
    for (const [formula, dependency] of [['derived', 'formulaRollup'], ['derived', 'input'], ['filteredDerived', 'formulaFilter'], ['filteredDerived', 'input']]) {
      await query('INSERT INTO formula_dependencies (sheet_id,field_id,depends_on_field_id,depends_on_sheet_id) VALUES ($1,$2,$3,$1)', [sheet, field(formula), field(dependency)])
    }
    await query(`INSERT INTO multitable_attachments (id,sheet_id,record_id,field_id,storage_file_id,filename,mime_type,size,storage_path)
      VALUES ($1,$2,$3,$4,$5,'synthetic-report.txt','text/plain',1,'synthetic/no-binary')`, [attachment, sheet, first, field('attachment'), `${prefix}_storage`])
    await query(`INSERT INTO meta_views (id,sheet_id,name,type,filter_info,sort_info) VALUES ($1,$2,'Filtered','grid',$3::jsonb,'{}')`,
      [filtered, sheet, JSON.stringify({ conjunction: 'and', conditions: [{ fieldId: field('name'), operator: 'is', value: 'row_000001' }] })])
  })

  afterAll(async () => {
    await query('DELETE FROM field_permissions WHERE sheet_id = ANY($1::text[])', [[sheet, foreign, secretSheet]])
    await query('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[sheet, foreign, seedSheet, secretSheet]])
    await query('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[base, privateBase]])
    await query('DELETE FROM users WHERE id = $1', [actor])
  })

  test('old unsorted SQL fails 42P18; real second pages succeed in both directions', async () => {
    await expect(query('SELECT id FROM meta_records WHERE sheet_id = $1 AND id > $3 LIMIT $4', [sheet, '', first, 11])).rejects.toMatchObject({ code: '42P18' })
    for (const direction of ['asc', 'desc'] as const) {
      const pageOne = await queryRecordsWithCursor({ query, sheetId: sheet, limit: 10, sort: { direction } })
      const pageTwo = await queryRecordsWithCursor({ query, sheetId: sheet, limit: 10, sort: { direction }, cursor: pageOne.nextCursor! })
      expect(pageOne.items).toHaveLength(10)
      expect(pageTwo.items).toHaveLength(10)
      expect(new Set([...pageOne.items, ...pageTwo.items].map((record) => record.id)).size).toBe(20)
    }
    const response = await request(app).get('/api/multitable/records').query({ sheetId: sheet, limit: 10 }).expect(200)
    const next = await request(app).get('/api/multitable/records').query({ sheetId: sheet, limit: 10, cursor: response.body.data.nextCursor }).expect(200)
    expect(next.body.data.records).toHaveLength(10)
  })

  test.each([false, true])('exports computed and display cells, filtered=%s', async (useFilter) => {
    const rows = await exportRows(useFilter ? filtered : undefined)
    expect(rows).toHaveLength(useFilter ? 2 : 5007)
    const values = Object.fromEntries(rows[0].map((header, index) => [header, rows[1][index]]))
    expect(values).toMatchObject({ name: 'row_000001', person: 'Synthetic Member', attachment: 'synthetic-report.txt', link: 'Visible Target', lookup: 'Visible Target', rollup: '42' })
    expect(values.lookupCreated).toBe('2026-11-03 09:02')
    expect(values.countCreated).toBe('1')
    if (!useFilter) expect(rows.at(-1)?.[0]).toBe('row_005006')
  })

  test.each([{}, { limit: '2' }, { search: 'row_000001' }, { search: 'row_000001', limit: '2' }, { viewId: filtered }])('hydrates metadata in every grid branch: %j', async (options) => {
    const response = await request(app).get('/api/multitable/view').query({ sheetId: sheet, ...options }).expect(200)
    const data = response.body.data.rows[0].data
    expect(data).toMatchObject({
      [field('createdTime')]: '2026-11-01T01:02:00.000Z', [field('modifiedTime')]: '2026-11-02T03:04:00.000Z',
      [field('createdBy')]: actor, [field('modifiedBy')]: actor,
    })
  })

  test('record detail hydrates system fields before field permission masking', async () => {
    const response = await request(app).get(`/api/multitable/records/${first}`).query({ sheetId: sheet }).expect(200)
    expect(response.body.data.record.data[field('createdTime')]).toBe('2026-11-01T01:02:00.000Z')
    await query("INSERT INTO field_permissions (sheet_id,field_id,subject_type,subject_id,visible,read_only) VALUES ($1,$2,'user',$3,false,false)", [sheet, field('createdTime'), actor])
    try {
      const masked = await request(app).get(`/api/multitable/records/${first}`).query({ sheetId: sheet }).expect(200)
      expect(masked.body.data.record.data).not.toHaveProperty(field('createdTime'))
      expect((await exportRows(filtered))[0]).not.toContain('createdTime')
    } finally {
      await query('DELETE FROM field_permissions WHERE sheet_id = $1', [sheet])
    }
  })

  test.each(['link', 'person', 'attachment', 'lookup', 'rollup'])('does not export a denied %s display column', async (name) => {
    await query("INSERT INTO field_permissions (sheet_id,field_id,subject_type,subject_id,visible,read_only) VALUES ($1,$2,'user',$3,false,false)", [sheet, field(name), actor])
    try {
      for (const viewId of [undefined, filtered]) {
        const rows = await exportRows(viewId)
        expect(rows[0]).not.toContain(name)
        expect(rows[0]).toContain('name')
        expect(rows[1][0]).toBe('row_000001')
      }
    } finally {
      await query('DELETE FROM field_permissions WHERE sheet_id = $1', [sheet])
    }
  })

  test('lookup remains computed when its source link is not selected for export', async () => {
    const response = await request(app).get(`/api/multitable/sheets/${sheet}/export-xlsx`)
      .query({ viewId: filtered, fieldIds: field('lookup'), format: 'csv' }).expect(200)
    expect(response.text.replace(/^\uFEFF/, '')).toBe('lookup\r\nVisible Target')
    expect(response.text).not.toContain(target)
  })

  test('foreign formula taint masks lookup, rollup and filter channels in both export branches', async () => {
    const allowed = await exportRows(filtered)
    expect(allowed[1][allowed[0].indexOf('formulaLookup')]).toBe('987655')
    expect(allowed[1][allowed[0].indexOf('formulaRollup')]).toBe('987655')
    expect(allowed[1][allowed[0].indexOf('formulaFilter')]).toBe('42')
    expect(allowed[1][allowed[0].indexOf('nestedLookup')]).toContain('987654')
    expect(allowed[1][allowed[0].indexOf('nestedRollup')]).toBe('987654')
    const csvFields = ['formulaLookup', 'formulaRollup', 'formulaFilter'].map(field).join(',')
    const allowedCsv = await request(app).get(`/api/multitable/sheets/${sheet}/export-xlsx`).query({ format: 'csv', viewId: filtered, fieldIds: csvFields }).expect(200)
    expect(allowedCsv.text.replace(/^\uFEFF/, '')).toBe('formulaLookup,formulaRollup,formulaFilter\r\n987655,987655,42')
    await query("INSERT INTO field_permissions (sheet_id,field_id,subject_type,subject_id,visible,read_only) VALUES ($1,$2,'user',$3,false,false)", [secretSheet, field('secret'), actor])
    try {
      const direct = await request(app).get(`/api/multitable/records/${target}`).query({ sheetId: foreign }).expect(200)
      expect(direct.body.data.record.data).not.toHaveProperty(field('foreignFormula'))
      for (const viewId of [undefined, filtered]) {
        const rows = await exportRows(viewId)
        expect(rows[1][rows[0].indexOf('formulaLookup')]).toBe('')
        expect(rows[1][rows[0].indexOf('formulaRollup')]).toBe('')
        expect(rows[1][rows[0].indexOf('formulaFilter')]).toBe('')
        expect(rows[1][rows[0].indexOf('nestedLookup')]).toBe('')
        expect(rows[1][rows[0].indexOf('nestedRollup')]).toBe('')
        expect(JSON.stringify(rows)).not.toMatch(/987654|987655/)
        const csv = await request(app).get(`/api/multitable/sheets/${sheet}/export-xlsx`).query({ format: 'csv', ...(viewId ? { viewId } : {}) }).expect(200)
        expect(csv.text).not.toMatch(/987654|987655/)
        const selectedCsv = await request(app).get(`/api/multitable/sheets/${sheet}/export-xlsx`).query({ format: 'csv', viewId: filtered, fieldIds: csvFields }).expect(200)
        expect(selectedCsv.text.replace(/^\uFEFF/, '')).toBe('formulaLookup,formulaRollup,formulaFilter\r\n,,')
      }
    } finally {
      await query('DELETE FROM field_permissions WHERE sheet_id=$1', [secretSheet])
    }
  })

  test('foreign formula taint closes the next formula hop on reads', async () => {
    await query("INSERT INTO field_permissions (sheet_id,field_id,subject_type,subject_id,visible,read_only) VALUES ($1,$2,'user',$3,false,false)", [secretSheet, field('secret'), actor])
    try {
      const view = await request(app).get('/api/multitable/view').query({ sheetId: sheet, viewId: filtered }).expect(200)
      const detail = await request(app).get(`/api/multitable/records/${first}`).query({ sheetId: sheet }).expect(200)
      for (const data of [view.body.data.rows[0].data, detail.body.data.record.data]) {
        expect(data).not.toHaveProperty(field('derived'))
        expect(data).not.toHaveProperty(field('filteredDerived'))
      }
      for (const viewId of [undefined, filtered]) {
        const rows = await exportRows(viewId)
        expect(rows[0]).not.toContain('derived')
        expect(rows[0]).not.toContain('filteredDerived')
      }
    } finally {
      await query('DELETE FROM field_permissions WHERE sheet_id=$1', [secretSheet])
    }
  })

  test('denied grid writes preserve authorized materialized formulas across foreign hops', async () => {
    await query("INSERT INTO field_permissions (sheet_id,field_id,subject_type,subject_id,visible,read_only) VALUES ($1,$2,'user',$3,false,false)", [secretSheet, field('secret'), actor])
    try {
      await request(app).post('/api/multitable/patch').send({ sheetId: sheet, changes: [{ recordId: first, fieldId: field('input'), value: 2 }] }).expect(200)
      const stored = (await query('SELECT data FROM meta_records WHERE id=$1', [first])).rows[0].data
      expect(stored[field('input')]).toBe(2)
      expect(stored[field('derived')]).toBe(987656)
      expect(stored[field('filteredDerived')]).toBe(43)
    } finally {
      await query('DELETE FROM field_permissions WHERE sheet_id=$1', [secretSheet])
      await request(app).post('/api/multitable/patch').send({ sheetId: sheet, changes: [{ recordId: first, fieldId: field('input'), value: 3 }] }).expect(200)
    }
    const allowed = (await query('SELECT data FROM meta_records WHERE id=$1', [first])).rows[0].data
    expect(allowed[field('derived')]).toBe(987658)
    expect(allowed[field('filteredDerived')]).toBe(45)
  })

  test('requestless strict recovery refuses degraded foreign-hop recomputation', async () => {
    const authority = { userId: actor, permissions: ['multitable:read', 'multitable:write', 'multitable:base:read'], isAdminRole: false }
    const helpers = createRecoveryComputedHelpers(authority, true)
    const fields = (await query('SELECT id,name,type,property FROM meta_fields WHERE sheet_id=$1', [sheet])).rows as Parameters<typeof helpers.applyLookupRollup>[2]
    const before = (await query('SELECT data FROM meta_records WHERE id=$1', [first])).rows[0].data
    await query("INSERT INTO field_permissions (sheet_id,field_id,subject_type,subject_id,visible,read_only) VALUES ($1,$2,'user',$3,false,false)", [secretSheet, field('secret'), actor])
    try {
      await expect(helpers.recalculateFormulaFields(query, sheet, fields, [first], [field('input')], new Map([[first, { ...before, [field('formulaRollup')]: null, [field('formulaFilter')]: null }]]))).rejects.toThrow('RECOVERY_DERIVED_AUTHORITY_UNAVAILABLE')
      expect((await query('SELECT data FROM meta_records WHERE id=$1', [first])).rows[0].data).toEqual(before)
    } finally {
      await query('DELETE FROM field_permissions WHERE sheet_id=$1', [secretSheet])
    }
  })

  test('taint traversals allow acyclic sheet returns and fail closed on actual field cycles', async () => {
    const original = (await query('SELECT property FROM meta_fields WHERE id=$1', [field('foreignFormula')])).rows[0].property
    await query("INSERT INTO meta_fields (id,sheet_id,name,type,property) VALUES ($1,$2,'backLink','link',$3::jsonb)", [field('backLink'), foreign, JSON.stringify({ foreignSheetId: sheet })])
    await query("INSERT INTO meta_fields (id,sheet_id,name,type,property) VALUES ($1,$2,'backLookup','lookup',$3::jsonb)", [field('backLookup'), foreign, JSON.stringify({ linkFieldId: field('backLink'), foreignSheetId: sheet, targetFieldId: field('input') })])
    await query('DELETE FROM formula_dependencies WHERE field_id=$1', [field('foreignFormula')])
    await query('UPDATE meta_fields SET property=$2::jsonb WHERE id=$1', [field('foreignFormula'), JSON.stringify({ expression: `={${field('backLookup')}}+1` })])
    try {
      const allowed = await request(app).get(`/api/multitable/records/${first}`).query({ sheetId: sheet }).expect(200)
      expect(allowed.body.data.record.data).toHaveProperty(field('derived'))
      await query("UPDATE meta_fields SET property=jsonb_set(property,'{targetFieldId}',to_jsonb($2::text)) WHERE id=$1", [field('backLookup'), field('derived')])
      const denied = await request(app).get(`/api/multitable/records/${first}`).query({ sheetId: sheet }).expect(200)
      expect(denied.body.data.record.data).not.toHaveProperty(field('derived'))
      expect(denied.body.data.record.data).toHaveProperty(field('input'))
    } finally {
      await query('UPDATE meta_fields SET property=$2::jsonb WHERE id=$1', [field('foreignFormula'), JSON.stringify(original)])
      await query('INSERT INTO formula_dependencies (sheet_id,field_id,depends_on_field_id,depends_on_sheet_id) VALUES ($1,$2,$3,$1)', [foreign, field('foreignFormula'), field('foreignLookup')])
      await query('DELETE FROM meta_fields WHERE id=ANY($1::text[])', [[field('backLink'), field('backLookup')]])
    }
  })

  test('foreign system-field permissions mask hydrated lookup and count values', async () => {
    await query("INSERT INTO field_permissions (sheet_id,field_id,subject_type,subject_id,visible,read_only) VALUES ($1,$2,'user',$3,false,false)", [foreign, field('foreignCreated'), actor])
    try {
      for (const viewId of [undefined, filtered]) {
        const rows = await exportRows(viewId)
        expect(rows[1][rows[0].indexOf('lookupCreated')]).toBe('')
        expect(rows[1][rows[0].indexOf('countCreated')]).toBe('')
        expect(JSON.stringify(rows)).not.toContain('2026-11-03 09:02')
      }
    } finally {
      await query('DELETE FROM field_permissions WHERE sheet_id=$1', [foreign])
    }
  })

  test('denied foreign records contribute neither display labels nor computed counts', async () => {
    await query('UPDATE meta_sheets SET row_level_read_permissions_enabled=TRUE WHERE id=$1', [foreign])
    await query("INSERT INTO record_permissions (sheet_id,record_id,subject_type,subject_id,access_level) VALUES ($1,$2,'user',$3,'none')", [foreign, target, actor])
    try {
      for (const viewId of [undefined, filtered]) {
        const rows = await exportRows(viewId)
        expect(JSON.stringify(rows)).not.toContain('Visible Target')
        expect(JSON.stringify(rows)).not.toContain('987655')
        expect(rows[1][rows[0].indexOf('countCreated')]).toBe('0')
      }
    } finally {
      await query('DELETE FROM record_permissions WHERE sheet_id=$1', [foreign])
      await query('UPDATE meta_sheets SET row_level_read_permissions_enabled=FALSE WHERE id=$1', [foreign])
    }
  })

  test('explicit demo formula has a real field expression and matching materialized values', async () => {
    await request(app).post('/api/multitable/sheets').send({ id: seedSheet, baseId: base, name: 'Explicit demo', seed: true }).expect(200)
    const fields = (await query('SELECT id,name,type,property FROM meta_fields WHERE sheet_id=$1', [seedSheet])).rows
    const quantity = fields.find((item) => item.name === '数量')
    const price = fields.find((item) => item.name === '单价')
    const total = fields.find((item) => item.name === '总价')
    expect(total.property.expression).toBe(`={${quantity.id}}*{${price.id}}`)
    const records = (await query('SELECT data FROM meta_records WHERE sheet_id=$1', [seedSheet])).rows
    expect(records).toHaveLength(5)
    for (const record of records) expect(record.data[total.id]).toBe(record.data[quantity.id] * record.data[price.id])
    const sample = (await query('SELECT id,data FROM meta_records WHERE sheet_id=$1 LIMIT 1', [seedSheet])).rows[0]
    await request(app).post('/api/multitable/patch').send({ sheetId: seedSheet, changes: [{ recordId: sample.id, fieldId: quantity.id, value: 7, expectedVersion: 1 }] }).expect(200)
    const changed = (await query('SELECT data FROM meta_records WHERE id=$1', [sample.id])).rows[0].data
    expect(changed[total.id]).toBe(7 * sample.data[price.id])
  })
})

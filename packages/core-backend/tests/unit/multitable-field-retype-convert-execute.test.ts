/**
 * 字段类型转换第 3 刀 —— 模块级单测：凭证读取与逐 claim 校验、写入值、前镜像捕获兄弟函数、栅栏不变量、
 * Tier-2 查询、三份迁移的文本约束。路由级的门与错误码在
 * multitable-field-retype-convert-{execute,undo}-route.test.ts 与 …-tier2-refusal.test.ts。
 * 设计锁：docs/development/multitable-field-retype-first-batch-adr-20260926.md §3 / §4。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import jwt from 'jsonwebtoken'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  __resetFieldRetypeConversionsTableProbe,
  checkFieldRetypeConvertClaims,
  executeFieldRetypeConvert,
  FIELD_RETYPE_UNDO_CONFIRM,
  fieldRetypeConversionRestoreRefusal,
  fieldRetypeConvertIdentityInvalid,
  isFieldRetypeConversionRevision,
  isFieldRetypeConvertCellTouched,
  resolveFieldRetypeConvertPostValue,
  revertWritesFieldTypeOrProperty,
  undoFieldRetypeConvert,
} from '../../src/multitable/field-retype-convert-execute'
import { FIELD_RETYPE_CONVERT_CONFIRM } from '../../src/multitable/field-retype-convert'
import {
  mintConfigRestorePreviewIdentity,
  mintFieldRetypeConvertPreviewIdentity,
  readFieldRetypeConvertPreviewIdentity,
} from '../../src/multitable/restore-preview-identity'
import {
  captureRetypeConvertPreImageRows,
  RETYPE_CONVERT_TOMBSTONE_REASON,
  TombstoneCaptureCapExceededError,
  toRetypeConvertPreImageEnvelope,
} from '../../src/multitable/tombstone-capture'

const SECRET = 'retype-module-secret-0123456789abcdef'
const SRC = join(__dirname, '../../src')
const readSrc = (rel: string): string => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')

const CLAIMS = { sheetId: 'sheet_1', fieldId: 'fld_1', actorId: 'user_1', sourceType: 'string', targetType: 'select', planHash: 'a'.repeat(64) } as const

beforeEach(() => {
  vi.stubEnv('RESTORE_PREVIEW_SECRET', SECRET)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('confirm literals', () => {
  test('execute and undo use two DIFFERENT typed confirms', () => {
    expect(FIELD_RETYPE_CONVERT_CONFIRM).toBe('convert-field-type')
    expect(FIELD_RETYPE_UNDO_CONFIRM).toBe('undo-field-type-convert')
  })
})

describe('readFieldRetypeConvertPreviewIdentity', () => {
  test('a token minted by the preview reads back claim for claim', () => {
    const token = mintFieldRetypeConvertPreviewIdentity({ ...CLAIMS })
    expect(readFieldRetypeConvertPreviewIdentity(token)).toEqual({ ok: true, claims: { ...CLAIMS } })
  })

  test('not a token / another key / alg none ⇒ invalid', () => {
    const otherKey = jwt.sign({ type: 'field-retype-convert-preview', ...CLAIMS }, 'another-key-another-key-another-key', { algorithm: 'HS256', expiresIn: '10m' })
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ type: 'field-retype-convert-preview', ...CLAIMS })).toString('base64url')}.`
    for (const token of ['', 'x', 'a.b.c', otherKey, none]) expect(readFieldRetypeConvertPreviewIdentity(token)).toEqual({ ok: false, reason: 'invalid' })
  })

  test('HS512 with the right key is refused: only HS256 is accepted', () => {
    const token = jwt.sign({ type: 'field-retype-convert-preview', ...CLAIMS }, SECRET, { algorithm: 'HS512', expiresIn: '10m' })
    expect(readFieldRetypeConvertPreviewIdentity(token)).toEqual({ ok: false, reason: 'invalid' })
  })

  test('expired ⇒ expired', () => {
    const token = jwt.sign({ type: 'field-retype-convert-preview', ...CLAIMS, exp: Math.floor(Date.now() / 1000) - 5 }, SECRET, { algorithm: 'HS256' })
    expect(readFieldRetypeConvertPreviewIdentity(token)).toEqual({ ok: false, reason: 'expired' })
  })

  test('every other identity of this module is wrong_type — a config-restore token cannot drive a conversion', () => {
    const other = mintConfigRestorePreviewIdentity({ sheetId: 'sheet_1', revisionId: 'rev', entityType: 'field', entityId: 'fld_1', baselineHash: 'h', actorId: 'user_1' })
    expect(readFieldRetypeConvertPreviewIdentity(other)).toEqual({ ok: false, reason: 'wrong_type' })
    const untyped = jwt.sign({ ...CLAIMS }, SECRET, { algorithm: 'HS256', expiresIn: '10m' })
    expect(readFieldRetypeConvertPreviewIdentity(untyped)).toEqual({ ok: false, reason: 'wrong_type' })
  })

  test('a claim that is missing, empty or not a string ⇒ invalid', () => {
    for (const key of Object.keys(CLAIMS)) {
      for (const bad of [undefined, '', 7, null, ['x'], { a: 1 }]) {
        const payload: Record<string, unknown> = { type: 'field-retype-convert-preview', ...CLAIMS, [key]: bad }
        if (bad === undefined) delete payload[key]
        const token = jwt.sign(payload, SECRET, { algorithm: 'HS256', expiresIn: '10m' })
        expect([key, JSON.stringify(bad), readFieldRetypeConvertPreviewIdentity(token)]).toEqual([key, JSON.stringify(bad), { ok: false, reason: 'invalid' }])
      }
    }
  })

  test('the reader judges no claim: it hands back a foreign targetType as minted', () => {
    const token = jwt.sign({ type: 'field-retype-convert-preview', ...CLAIMS, targetType: 'number', sourceType: 'longText' }, SECRET, { algorithm: 'HS256', expiresIn: '10m' })
    expect(readFieldRetypeConvertPreviewIdentity(token)).toEqual({ ok: true, claims: { ...CLAIMS, targetType: 'number', sourceType: 'longText' } })
  })
})

describe('checkFieldRetypeConvertClaims', () => {
  const expected = { fieldId: CLAIMS.fieldId, sheetId: CLAIMS.sheetId, actorId: CLAIMS.actorId }

  test('matching claims, both first-batch targets ⇒ null', () => {
    expect(checkFieldRetypeConvertClaims({ ...CLAIMS }, expected)).toBeNull()
    expect(checkFieldRetypeConvertClaims({ ...CLAIMS, targetType: 'multiSelect' }, expected)).toBeNull()
  })

  test('each claim, alone, is enough to refuse', () => {
    expect(checkFieldRetypeConvertClaims({ ...CLAIMS, fieldId: 'fld_2' }, expected)).toBe('mismatch_fieldId')
    expect(checkFieldRetypeConvertClaims({ ...CLAIMS, sheetId: 'sheet_2' }, expected)).toBe('mismatch_sheetId')
    expect(checkFieldRetypeConvertClaims({ ...CLAIMS, actorId: 'user_2' }, expected)).toBe('mismatch_actorId')
    for (const sourceType of ['longText', 'String', ' string', 'number', 'select']) expect(checkFieldRetypeConvertClaims({ ...CLAIMS, sourceType }, expected)).toBe('mismatch_sourceType')
    for (const targetType of ['string', 'number', 'Select', 'multiselect', 'attachment', 'formula', 'longText']) expect(checkFieldRetypeConvertClaims({ ...CLAIMS, targetType }, expected)).toBe('mismatch_targetType')
  })

  test('ids compare exactly: no trimming, no case folding, no prefix match', () => {
    for (const fieldId of ['fld_1 ', ' fld_1', 'FLD_1', 'fld_10', 'fld_']) expect(checkFieldRetypeConvertClaims({ ...CLAIMS, fieldId }, expected)).toBe('mismatch_fieldId')
    expect(checkFieldRetypeConvertClaims({ ...CLAIMS }, { ...expected, actorId: '' })).toBe('mismatch_actorId')
  })

  test('the 401 it leads to names no claim; only expiry is disclosed', () => {
    expect(fieldRetypeConvertIdentityInvalid()).toEqual({ status: 401, code: 'PREVIEW_IDENTITY_INVALID', message: expect.any(String) })
    for (const reason of ['invalid', 'wrong_type', 'mismatch_fieldId', 'mismatch_actorId', 'plan_drift']) expect(fieldRetypeConvertIdentityInvalid(reason).details).toBeUndefined()
    expect(fieldRetypeConvertIdentityInvalid('expired').details).toEqual({ reason: 'expired' })
  })
})

describe('post values (round-trip rule A)', () => {
  test('empty ⇒ the canonical empty of the target; text ⇒ the WHOLE text as one option', () => {
    for (const [hasKey, value] of [[false, null], [true, null], [true, '']] as const) {
      expect(resolveFieldRetypeConvertPostValue('select', hasKey, value)).toBe('')
      expect(resolveFieldRetypeConvertPostValue('multiSelect', hasKey, value)).toEqual([])
    }
    for (const text of ['A', 'A,B', 'A、B；C', 'line1\nline2', 'a b']) {
      expect(resolveFieldRetypeConvertPostValue('select', true, text)).toBe(text)
      expect(resolveFieldRetypeConvertPostValue('multiSelect', true, text)).toEqual([text])
    }
  })

  test('a cell rule A rejects has NO post value', () => {
    for (const value of [' A', 'A ', '   ', 7, true, [], ['A'], {}]) {
      expect(resolveFieldRetypeConvertPostValue('select', true, value)).toBeUndefined()
      expect(resolveFieldRetypeConvertPostValue('multiSelect', true, value)).toBeUndefined()
    }
  })

  test('touched = data->F IS DISTINCT FROM post', () => {
    expect(isFieldRetypeConvertCellTouched(true, 'A', 'A')).toBe(false)
    expect(isFieldRetypeConvertCellTouched(true, '', '')).toBe(false)
    expect(isFieldRetypeConvertCellTouched(true, null, '')).toBe(true)
    expect(isFieldRetypeConvertCellTouched(false, null, '')).toBe(true)
    // a missing key is touched even when the stale `value` argument happens to equal the post value
    expect(isFieldRetypeConvertCellTouched(false, '', '')).toBe(true)
    expect(isFieldRetypeConvertCellTouched(true, 'A', ['A'])).toBe(true)
    expect(isFieldRetypeConvertCellTouched(true, '', [])).toBe(true)
  })
})

describe('captureRetypeConvertPreImageRows — the sibling of captureLossyRetypePreImageRows', () => {
  const ctx = { sheetId: 'sheet_1', fieldId: 'fld_1', configRevisionId: '11111111-1111-4111-8111-111111111111' }
  const recorder = (answer?: (payload: Array<{ record_id: string }>) => unknown[]) => {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const query = async (sql: string, params: unknown[] = []) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params })
      const payload = JSON.parse(String(params[3])) as Array<{ record_id: string }>
      const rows = answer ? answer(payload) : payload.map((p) => ({ record_id: p.record_id }))
      return { rows, rowCount: rows.length }
    }
    return { calls, query }
  }

  test('the existing sibling is byte-for-byte what it was (pinned from main)', () => {
    const src = readSrc('multitable/tombstone-capture.ts')
    const start = src.indexOf('export async function captureLossyRetypePreImageRows(')
    const body = src.slice(start, src.indexOf('\n}\n', start) + 3)
    expect(createHash('sha256').update(body).digest('hex')).toBe('1fc7ff665e33ed59a2c2e1c32334010babbd8eab6d83f3e13b977f240fd96b58')
  })

  test('the envelope keeps the four empty states apart', () => {
    expect(toRetypeConvertPreImageEnvelope({ hasKey: false, value: 'ignored', post: '' })).toEqual({ k: false, v: null, post: '' })
    expect(toRetypeConvertPreImageEnvelope({ hasKey: true, value: null, post: [] })).toEqual({ k: true, v: null, post: [] })
    expect(toRetypeConvertPreImageEnvelope({ hasKey: true, value: '', post: '' })).toEqual({ k: true, v: '', post: '' })
    expect(toRetypeConvertPreImageEnvelope({ hasKey: true, value: 'A', post: ['A'] })).toEqual({ k: true, v: 'A', post: ['A'] })
  })

  test('one statement, reason retype_convert, anchored to the conversion id, operation_id never named', async () => {
    const { calls, query } = recorder()
    const written = await captureRetypeConvertPreImageRows(query, [
      { recordId: 'r1', hasKey: true, value: 'A', post: ['A'] },
      { recordId: 'r2', hasKey: false, value: null, post: [] },
    ], ctx, {})
    expect(written).toBe(2)
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toContain(`'${RETYPE_CONVERT_TOMBSTONE_REASON}'`)
    expect(RETYPE_CONVERT_TOMBSTONE_REASON).toBe('retype_convert')
    expect(calls[0].sql).toContain('INSERT INTO meta_field_value_tombstones (id, sheet_id, field_id, record_id, value, reason, config_revision_id, created_at)')
    expect(calls[0].sql).not.toContain('operation_id')
    expect(calls[0].params.slice(0, 3)).toEqual([ctx.sheetId, ctx.fieldId, ctx.configRevisionId])
    expect(JSON.parse(String(calls[0].params[3]))).toEqual([
      { record_id: 'r1', value: { k: true, v: 'A', post: ['A'] } },
      { record_id: 'r2', value: { k: false, v: null, post: [] } },
    ])
  })

  test('it does not read MULTITABLE_TOMBSTONE_CAPTURE_ENABLED: off, on, absent — the same rows are written', async () => {
    for (const env of [{}, { MULTITABLE_TOMBSTONE_CAPTURE_ENABLED: '' }, { MULTITABLE_TOMBSTONE_CAPTURE_ENABLED: 'false' }, { MULTITABLE_TOMBSTONE_CAPTURE_ENABLED: 'true' }]) {
      const { calls, query } = recorder()
      expect(await captureRetypeConvertPreImageRows(query, [{ recordId: 'r1', hasKey: true, value: 'A', post: 'A' }], ctx, env as NodeJS.ProcessEnv)).toBe(1)
      expect(calls).toHaveLength(1)
    }
    const src = readSrc('multitable/tombstone-capture.ts')
    const body = src.slice(src.indexOf('export async function captureRetypeConvertPreImageRows('))
    expect(body).not.toContain('isTombstoneCaptureEnabled')
    expect(body).not.toContain('MULTITABLE_TOMBSTONE_CAPTURE_ENABLED')
  })

  test('above the cap it throws BEFORE writing anything; at the cap it writes', async () => {
    const rows = [1, 2, 3].map((n) => ({ recordId: `r${n}`, hasKey: true, value: 'A', post: 'A' }))
    const over = recorder()
    await expect(captureRetypeConvertPreImageRows(over.query, rows, ctx, { MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS: '2' })).rejects.toBeInstanceOf(TombstoneCaptureCapExceededError)
    expect(over.calls).toEqual([])
    await expect(captureRetypeConvertPreImageRows(over.query, rows, ctx, { MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS: '2' })).rejects.toMatchObject({ totalRows: 3, cap: 2 })
    const at = recorder()
    expect(await captureRetypeConvertPreImageRows(at.query, rows, ctx, { MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS: '3' })).toBe(3)
    // the default cap is the module's own 50000
    const dflt = recorder()
    expect(await captureRetypeConvertPreImageRows(dflt.query, rows, ctx, {})).toBe(3)
  })

  test('chunks of 1000; a short insert in ANY chunk throws', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({ recordId: `r${i}`, hasKey: true, value: 'A', post: 'A' }))
    const ok = recorder()
    expect(await captureRetypeConvertPreImageRows(ok.query, rows, ctx, {})).toBe(2500)
    expect(ok.calls.map((c) => (JSON.parse(String(c.params[3])) as unknown[]).length)).toEqual([1000, 1000, 500])

    let chunk = 0
    const short = recorder((payload) => {
      chunk += 1
      return (chunk === 2 ? payload.slice(1) : payload).map((p) => ({ record_id: p.record_id }))
    })
    await expect(captureRetypeConvertPreImageRows(short.query, rows, ctx, {})).rejects.toThrow(/999 of 1000/)
  })

  test('no rows ⇒ no statement (an empty-sheet conversion has no pre-image)', async () => {
    const { calls, query } = recorder()
    expect(await captureRetypeConvertPreImageRows(query, [], ctx, {})).toBe(0)
    expect(calls).toEqual([])
  })
})

describe('the transaction never runs without the canonical fence', () => {
  const never = () => {
    const calls: string[] = []
    return { calls, query: async (sql: string) => { calls.push(sql); return { rows: [] } } }
  }

  test('writer fence flag off ⇒ execute and undo THROW before their first statement', async () => {
    for (const v of ['', 'false', '0']) {
      vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', v)
      const a = never()
      await expect(executeFieldRetypeConvert(a.query, {
        sheetId: 's', fieldId: 'f', actorId: 'u', historyActorId: 'u', previewToken: 't', targetType: 'select',
        mapFieldType: (raw) => raw, normalizeProperty: () => ({}),
      })).rejects.toThrow(/without the canonical writer fence/)
      expect(a.calls).toEqual([])
      const b = never()
      await expect(undoFieldRetypeConvert(b.query, { sheetId: 's', fieldId: 'f', convertRevisionId: '11111111-1111-4111-8111-111111111111', historyActorId: 'u' })).rejects.toThrow(/without the canonical writer fence/)
      expect(b.calls).toEqual([])
    }
  })

  test('with the flag on, the FIRST statement of each is the canonical advisory lock on this sheet', async () => {
    vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', 'true')
    const first = async (run: (query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>) => Promise<unknown>) => {
      const calls: Array<{ sql: string; params: unknown[] }> = []
      await run(async (sql, params = []) => {
        calls.push({ sql, params })
        if (calls.length > 1) throw new Error('stop after the first statement')
        return { rows: [] }
      }).catch(() => undefined)
      return calls[0]
    }
    const lock = { sql: 'SELECT pg_advisory_xact_lock(hashtext($1))', params: ['meta:auto-number:sheet:sheet_x'] }
    expect(await first((query) => executeFieldRetypeConvert(query, {
      sheetId: 'sheet_x', fieldId: 'f', actorId: 'u', historyActorId: 'u', previewToken: 't', targetType: 'select',
      mapFieldType: (raw) => raw, normalizeProperty: () => ({}),
    }))).toEqual(lock)
    expect(await first((query) => undoFieldRetypeConvert(query, { sheetId: 'sheet_x', fieldId: 'f', convertRevisionId: '11111111-1111-4111-8111-111111111111', historyActorId: 'u' }))).toEqual(lock)
  })
})

describe('isFieldRetypeConversionRevision', () => {
  const ID = '22222222-2222-4222-8222-222222222222'
  beforeEach(() => __resetFieldRetypeConversionsTableProbe())

  test('table absent ⇒ false, and the table itself is never read', async () => {
    const calls: string[] = []
    const query = async (sql: string) => {
      calls.push(sql)
      if (sql.includes('to_regclass')) return { rows: [{ present: false }] }
      throw Object.assign(new Error('relation "meta_field_retype_conversions" does not exist'), { code: '42P01' })
    }
    expect(await isFieldRetypeConversionRevision(query, ID)).toBe(false)
    expect(await isFieldRetypeConversionRevision(query, ID)).toBe(false)
    // "absent" is not cached: the migration may land while the process runs
    expect(calls).toEqual([expect.stringContaining('to_regclass'), expect.stringContaining('to_regclass')])
  })

  test('table present ⇒ matches the conversion id OR the undo id; presence is cached, the answer is not', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    let hit = true
    const query = async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params })
      if (sql.includes('to_regclass')) return { rows: [{ present: true }] }
      return { rows: hit ? [{ '?column?': 1 }] : [] }
    }
    expect(await isFieldRetypeConversionRevision(query, ID)).toBe(true)
    hit = false
    expect(await isFieldRetypeConversionRevision(query, ID)).toBe(false)
    expect(calls.filter((c) => c.sql.includes('to_regclass'))).toHaveLength(1)
    const lookups = calls.filter((c) => c.sql.includes('FROM meta_field_retype_conversions'))
    expect(lookups).toHaveLength(2)
    expect(lookups[0].sql).toContain('convert_revision_id = $1::uuid OR undo_revision_id = $1::uuid')
    expect(lookups[0].params).toEqual([ID])
  })

  test('revertWritesFieldTypeOrProperty: a field revision whose changed_keys hold type or property — nothing else', () => {
    // no default parameter here: `undefined` must reach the function as `undefined`
    const judge = (entity_type: unknown, changed_keys: unknown) => revertWritesFieldTypeOrProperty({ entity_type, changed_keys })
    for (const keys of [['type', 'property'], ['property', 'type'], ['type'], ['property'], ['name', 'type'], ['order', 'property', 'name']]) expect([keys.join('+'), judge('field', keys)]).toEqual([keys.join('+'), true])
    for (const keys of [['name'], ['order'], ['name', 'order'], [], ['Type'], ['types'], [' type'], ['properties']]) expect([keys.join('+'), judge('field', keys)]).toEqual([keys.join('+'), false])
    for (const entity of ['view', 'sheet_config', 'permission', 'Field', '', undefined, null]) expect([String(entity), judge(entity, ['type', 'property'])]).toEqual([String(entity), false])
    for (const keys of [undefined, null, 'type', { type: true }]) expect(judge('field', keys)).toBe(false)
    expect(revertWritesFieldTypeOrProperty({})).toBe(false)
  })

  test('the refusal is values-free and names the way out', () => {
    expect(fieldRetypeConversionRestoreRefusal()).toEqual({
      status: 422, code: 'RESTORE_NOT_SUPPORTED', message: expect.stringContaining('whole-column undo'), details: { reason: 'field_retype_conversion' },
    })
  })
})

describe('migrations (text constraints; they RUN in the real-DB cases)', () => {
  const migration = (name: string): string => readSrc(`db/migrations/${name}.ts`)
  const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  test('CHECK relaxation: a superset of the old set, added NOT VALID then validated, no row is written', () => {
    const src = code(migration('zzzz20260928150000_relax_field_value_tombstone_reason_for_retype_convert'))
    const up = src.slice(src.indexOf('export async function up'), src.indexOf('export async function down'))
    expect(up).toContain("CHECK (reason IN ('field_delete', 'lossy_retype', 'retype_convert')) NOT VALID")
    expect(up).toContain('VALIDATE CONSTRAINT meta_field_value_tombstones_reason_check')
    expect(up.indexOf('NOT VALID')).toBeLessThan(up.indexOf('VALIDATE CONSTRAINT'))
    expect(up).not.toMatch(/\b(UPDATE|DELETE\s+FROM|INSERT\s+INTO|TRUNCATE)\b/i)
    // the old constraint is found by the COLUMN it constrains, not by a guessed name
    expect(up).toContain('att.attnum = ANY (con.conkey)')
  })

  test('CHECK relaxation: down refuses while a retype_convert pre-image exists', () => {
    const src = code(migration('zzzz20260928150000_relax_field_value_tombstone_reason_for_retype_convert'))
    const down = src.slice(src.indexOf('export async function down'))
    expect(down).toContain("WHERE reason = 'retype_convert'")
    expect(down.indexOf('RAISE EXCEPTION')).toBeGreaterThan(-1)
    expect(down.indexOf('RAISE EXCEPTION')).toBeLessThan(down.indexOf('DROP CONSTRAINT'))
    expect(down).not.toMatch(/\bDELETE\s+FROM\b/i)
  })

  test('job table: the twelve columns of the ADR, NO operation_id, NO foreign key, only new objects', () => {
    const src = code(migration('zzzz20260928150100_create_meta_field_retype_conversions'))
    const up = src.slice(src.indexOf('export async function up'), src.indexOf('export async function down'))
    const table = up.slice(up.indexOf('CREATE TABLE IF NOT EXISTS meta_field_retype_conversions'), up.indexOf('`.execute'))
    const columns = [...table.matchAll(/^\s{6}([a-z_]+) (uuid|text|jsonb|integer|timestamptz)\b/gm)].map((m) => m[1])
    expect(columns).toEqual([
      'convert_revision_id', 'sheet_id', 'field_id', 'source_type', 'source_property', 'target_type', 'target_property',
      'record_count', 'actor_id', 'created_at', 'undone_at', 'undo_revision_id',
    ])
    expect(table).toContain('convert_revision_id uuid PRIMARY KEY')
    expect(up).not.toMatch(/operation_id/)
    expect(up).not.toMatch(/\bREFERENCES\b|\bFOREIGN\s+KEY\b/i)
    expect(up).not.toMatch(/\bALTER\s+TABLE\b|\bUPDATE\b|\bDELETE\s+FROM\b|\bINSERT\s+INTO\b/i)
    const down = src.slice(src.indexOf('export async function down'))
    expect(down.indexOf('RAISE EXCEPTION')).toBeGreaterThan(-1)
    expect(down.indexOf('RAISE EXCEPTION')).toBeLessThan(down.indexOf('DROP TABLE'))
  })

  test('backfill: ONE column, three predicates, the evidence table — never a name or a description', async () => {
    const src = code(migration('zzzz20260928150200_backfill_approval_projection_system_kind'))
    const up = src.slice(src.indexOf('export async function up'), src.indexOf('export async function down'))
    const statement = up.slice(up.indexOf('UPDATE meta_sheets'), up.indexOf('END $$'))
    expect(statement.replace(/\s+/g, ' ').trim()).toBe(
      "UPDATE meta_sheets AS s SET system_kind = 'approval_projection' WHERE s.system_kind IS NULL AND s.base_id = 'base_apr_projection' AND EXISTS (SELECT 1 FROM approval_record_projection p WHERE p.sheet_id = s.id);",
    )
    expect((up.match(/\bUPDATE\b/g) ?? []).length).toBe(1)
    expect(up).not.toMatch(/\bname\b|description|LIKE|updated_at/)
    // the literals are the product's own constants
    const { APPROVAL_PROJECTION_BASE_ID } = await import('../../src/multitable/approval-projection-constants')
    const { SYSTEM_SHEET_KINDS } = await import('../../src/multitable/system-sheet-predicate')
    expect(APPROVAL_PROJECTION_BASE_ID).toBe('base_apr_projection')
    expect(SYSTEM_SHEET_KINDS).toContain('approval_projection')
    // down is deliberately empty
    const down = src.slice(src.indexOf('export async function down'))
    expect(down).not.toMatch(/\bUPDATE\b|\bDELETE\b/i)
  })

  test('the three migrations carry three distinct 14-digit prefixes, in dependency order', () => {
    const names = [
      'zzzz20260928150000_relax_field_value_tombstone_reason_for_retype_convert',
      'zzzz20260928150100_create_meta_field_retype_conversions',
      'zzzz20260928150200_backfill_approval_projection_system_kind',
    ]
    for (const name of names) expect(() => migration(name)).not.toThrow()
    expect(new Set(names.map((n) => n.slice(0, 18))).size).toBe(3)
    expect([...names].sort()).toEqual(names)
  })
})

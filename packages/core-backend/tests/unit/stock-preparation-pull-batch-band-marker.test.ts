/**
 * 批次标识 BI-5b — the HOST half of the band marker contract (design batch-id §4.1; ADR adr-stock-prep-manual-rows-20261030
 * §5.5; R-65 C1 / C10): src/multitable/stock-preparation-pull-batch-band.ts and its three person-facing wirings.
 *
 *   BM-01 the predicate truth table: a band column is type `string` AND the `plm_system` lock AND a well-formed marker;
 *         exactly two with one label ⇒ the stamp, every other shape ⇒ null; a marker WITHOUT the lock is never counted.
 *   BM-02 strip (POST /fields): a person body can never SET the marker.
 *   BM-03 carry (PATCH /fields, both reads): the STORED marker wins over a body that sets, clears, changes or omits it.
 *   BM-04 the config revert keeps the STORED marker (helper, preview target, write); untouched when no side has any key.
 *   BM-05 the plugin's write path keeps the marker on a `string` column (the field-codecs chokepoint and the provisioning
 *         property write), so the contract the plugin relies on survives the host sanitizer.
 *   BM-06 wiring (source scan): the strip, both PATCH carries, the revert carry and the manual-row stamp placement.
 *
 * Every value is synthetic.
 */
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  PULL_BATCH_BAND_MARKER,
  PULL_BATCH_BAND_PROPERTY_KEY,
  PULL_BATCH_MANUAL_LABELS,
  carryPullBatchBandMarker,
  hasPullBatchBandMarkerKey,
  isPullBatchBandField,
  pullBatchBandMarkerOf,
  pullBatchBandStampOf,
  stripPullBatchBandMarker,
} from '../../src/multitable/stock-preparation-pull-batch-band'
import { applyConfigRevert, computeRevertPreview, fieldRevertPropertyKeepingLock } from '../../src/multitable/config-restore'
import { sanitizeFieldProperty } from '../../src/multitable/field-codecs'
import { patchObjectFieldProperty } from '../../src/multitable/provisioning'

const KEY = PULL_BATCH_BAND_PROPERTY_KEY
const ZH = '人工补充'
const EN = 'Manual row'
const SRC = path.resolve(__dirname, '../../src')
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')

const marker = (manualLabel: unknown = ZH, band: unknown = 'v1') => ({ band, manualLabel })
const bandProperty = (manualLabel: unknown = ZH) => ({ humanWriteLock: 'plm_system', [KEY]: marker(manualLabel) })
const bandRow = (id: string, manualLabel: unknown = ZH, extra: Record<string, unknown> = {}) =>
  ({ id, type: 'string', property: { ...bandProperty(manualLabel), ...extra } })
const plainRow = (id: string) => ({ id, type: 'string', property: { humanWriteLock: 'plm_system' } })

describe('BM-01 the predicate (marker AND lock AND string) and the stamp truth table', () => {
  it('the constants are the contract literals', () => {
    expect(KEY).toBe('stockPreparationPullBatch')
    expect(PULL_BATCH_BAND_MARKER).toBe('v1')
    expect([...PULL_BATCH_MANUAL_LABELS]).toEqual([ZH, EN])
    expect(Object.isFrozen(PULL_BATCH_MANUAL_LABELS)).toBe(true)
  })

  it('the marker shape: band v1 + a known label only (raw object and JSON-string property)', () => {
    expect(pullBatchBandMarkerOf({ [KEY]: marker(ZH) })).toEqual({ band: 'v1', manualLabel: ZH })
    expect(pullBatchBandMarkerOf(JSON.stringify({ [KEY]: marker(EN) }))).toEqual({ band: 'v1', manualLabel: EN })
    for (const bad of [
      undefined, null, '', '{', [], {}, { [KEY]: null }, { [KEY]: 'v1' }, { [KEY]: [] }, { [KEY]: marker(ZH, 'v2') },
      { [KEY]: marker(ZH, 1) }, { [KEY]: marker('人工补充 ') }, { [KEY]: marker('manual row') }, { [KEY]: marker('') },
      { [KEY]: marker(null) }, { [KEY]: { band: 'v1' } },
    ]) {
      expect(pullBatchBandMarkerOf(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('a band column needs ALL three: type string, the plm_system lock, the marker', () => {
    expect(isPullBatchBandField(bandRow('f1'))).toBe(true)
    expect(isPullBatchBandField({ id: 'f1', type: 'string', property: JSON.stringify(bandProperty(EN)) })).toBe(true)
    // The forge case: the marker without the lock (a column a person made, a sheet copy) is not a band column.
    expect(isPullBatchBandField({ id: 'f1', type: 'string', property: { [KEY]: marker(ZH) } })).toBe(false)
    expect(isPullBatchBandField({ id: 'f1', type: 'string', property: { humanWriteLock: 'PLM_SYSTEM', [KEY]: marker(ZH) } })).toBe(false)
    expect(isPullBatchBandField({ id: 'f1', type: 'string', property: { humanWriteLock: true, [KEY]: marker(ZH) } })).toBe(false)
    expect(isPullBatchBandField({ id: 'f1', type: 'longText', property: bandProperty() })).toBe(false)
    expect(isPullBatchBandField({ id: 'f1', type: 'select', property: bandProperty() })).toBe(false)
    expect(isPullBatchBandField(plainRow('f1'))).toBe(false)
    expect(isPullBatchBandField(null)).toBe(false)
  })

  it('exactly two band columns with one label ⇒ { fieldIds (row order), label }', () => {
    const stamp = pullBatchBandStampOf([plainRow('a'), bandRow('first'), plainRow('b'), bandRow('pull')])
    expect(stamp).toEqual({ fieldIds: ['first', 'pull'], label: ZH })
    expect(Object.isFrozen(stamp)).toBe(true)
    expect(pullBatchBandStampOf([bandRow('x', EN), bandRow('y', EN)])).toEqual({ fieldIds: ['x', 'y'], label: EN })
    expect(pullBatchBandStampOf([
      { id: 'x', type: 'string', property: JSON.stringify(bandProperty()) },
      { id: 'y', type: 'string', property: JSON.stringify(bandProperty()) },
    ])).toEqual({ fieldIds: ['x', 'y'], label: ZH })
  })

  it.each([
    ['no column at all', []],
    ['no band column', [plainRow('a'), plainRow('b')]],
    ['one band column', [bandRow('first'), plainRow('b')]],
    ['three band columns', [bandRow('a'), bandRow('b'), bandRow('c')]],
    ['two different labels', [bandRow('a', ZH), bandRow('b', EN)]],
    ['a junk label beside a valid one', [bandRow('a', ZH), bandRow('b', 'Manual')]],
    ['two junk labels', [bandRow('a', 'X'), bandRow('b', 'X')]],
    ['the same id twice', [bandRow('a'), bandRow('a')]],
    ['two markers WITHOUT the lock (forged)', [{ id: 'a', type: 'string', property: { [KEY]: marker() } }, { id: 'b', type: 'string', property: { [KEY]: marker() } }]],
    ['one band column + one forged marker', [bandRow('a'), { id: 'b', type: 'string', property: { [KEY]: marker() } }]],
    ['two locked markers on a non-string type', [{ id: 'a', type: 'number', property: bandProperty() }, { id: 'b', type: 'number', property: bandProperty() }]],
  ])('%s ⇒ null (fail-soft: the row is created without band cells)', (_label, rows) => {
    expect(pullBatchBandStampOf(rows as Array<{ id: string; type: string; property: unknown }>)).toBeNull()
  })

  it('a forged marker cannot break a real band (it is not counted)', () => {
    const forged = { id: 'forged', type: 'string', property: { [KEY]: marker(EN) } }
    expect(pullBatchBandStampOf([bandRow('first'), forged, bandRow('pull')])).toEqual({ fieldIds: ['first', 'pull'], label: ZH })
  })

  it('non-array input ⇒ null', () => {
    expect(pullBatchBandStampOf(null)).toBeNull()
    expect(pullBatchBandStampOf(undefined)).toBeNull()
  })
})

describe('BM-02 strip (POST /fields): a person body can never SET the marker', () => {
  it('drops the key on a copy; a property without it is returned as is', () => {
    const body = { a: 1, humanWriteLock: 'plm_system', [KEY]: marker() }
    expect(stripPullBatchBandMarker(body)).toEqual({ a: 1, humanWriteLock: 'plm_system' })
    expect(body[KEY]).toEqual(marker())
    const plain = { a: 1 }
    expect(stripPullBatchBandMarker(plain)).toBe(plain)
    expect(stripPullBatchBandMarker({ [KEY]: 'junk' })).toEqual({})
  })
})

describe('BM-03 carry (PATCH /fields): the STORED marker wins whatever the body says', () => {
  it('omitted, cleared, changed or forged in the body', () => {
    const stored = bandProperty(ZH)
    expect(carryPullBatchBandMarker(stored, { a: 1 })).toEqual({ a: 1, [KEY]: marker(ZH) })
    expect(carryPullBatchBandMarker(stored, { a: 1, [KEY]: null })).toEqual({ a: 1, [KEY]: marker(ZH) })
    expect(carryPullBatchBandMarker(stored, { [KEY]: marker(EN) })).toEqual({ [KEY]: marker(ZH) })
    expect(carryPullBatchBandMarker(JSON.stringify(stored), {})).toEqual({ [KEY]: marker(ZH) })
    // No stored marker ⇒ a body marker never lands (the forge case on PATCH).
    expect(carryPullBatchBandMarker({ humanWriteLock: 'plm_system' }, { a: 1, [KEY]: marker() })).toEqual({ a: 1 })
    expect(carryPullBatchBandMarker(null, { [KEY]: marker() })).toEqual({})
  })
  it('carries the stored value verbatim, on a copy (never a shared reference)', () => {
    const stored = { [KEY]: { band: 'v2', manualLabel: 'X', extra: [1] } }
    const out = carryPullBatchBandMarker(stored, {})
    expect(out).toEqual(stored)
    expect(out[KEY]).not.toBe(stored[KEY])
  })
  it('hasPullBatchBandMarkerKey: present key with any value; undefined counts as absent', () => {
    expect(hasPullBatchBandMarkerKey({ [KEY]: 'junk' })).toBe(true)
    expect(hasPullBatchBandMarkerKey({ [KEY]: undefined })).toBe(false)
    expect(hasPullBatchBandMarkerKey({})).toBe(false)
    expect(hasPullBatchBandMarkerKey('not json')).toBe(false)
  })
})

describe('BM-04 the config revert keeps the STORED marker (helper, preview, write)', () => {
  const rev = (before: Record<string, unknown>, after: Record<string, unknown>) => ({
    id: 'rev_bim', sheet_id: 'sheet_x', entity_type: 'field' as const, entity_id: 'fld_band', action: 'update' as const,
    before, after, changed_keys: ['property'],
  })
  it('helper: a revision recorded before the band cannot drop it; a revision cannot forge one', () => {
    expect(fieldRevertPropertyKeepingLock(bandProperty(), { a: 1 })).toEqual({ a: 1, humanWriteLock: 'plm_system', [KEY]: marker() })
    expect(fieldRevertPropertyKeepingLock({}, { a: 1, [KEY]: marker() })).toEqual({ a: 1 })
    // Neither side carries the lock, the switch or the marker: untouched (same reference) — the old behaviour.
    const plain = { a: 1 }
    expect(fieldRevertPropertyKeepingLock({ b: 2 }, plain)).toBe(plain)
  })
  it('computeRevertPreview discloses the carried marker in target.property', () => {
    const preview = computeRevertPreview(rev({ property: { a: 1 } }, { property: bandProperty() }), { property: bandProperty() })
    expect((preview.target.property as Record<string, unknown>)[KEY]).toEqual(marker())
  })
  it('applyConfigRevert writes the carried marker (reads the stored property first)', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const query = async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      if (sql.startsWith('SELECT property FROM meta_fields')) return { rows: [{ property: bandProperty(EN) }] }
      return { rows: [] }
    }
    await applyConfigRevert(query, rev({ property: { a: 1 } }, { property: bandProperty(EN) }))
    const update = calls.find((c) => c.sql.startsWith('UPDATE meta_fields'))!
    const written = update.params.find((p) => typeof p === 'string' && p.trim().startsWith('{'))
    expect(JSON.parse(String(written))).toEqual({ a: 1, humanWriteLock: 'plm_system', [KEY]: marker(EN) })
  })
})

describe('BM-05 the plugin write path keeps the marker on a string column', () => {
  it('the field-codecs chokepoint (provisioning write + read serializer) keeps it', () => {
    expect(sanitizeFieldProperty('string', bandProperty())).toEqual(bandProperty())
  })
  it('provisioning.patchObjectFieldProperty writes it next to the lock', async () => {
    const written: unknown[] = []
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      const q = sql.replace(/\s+/g, ' ').trim()
      if (q.startsWith('SELECT id, sheet_id, name, type, property, "order" FROM meta_fields')) {
        return { rows: [{ id: params[1], sheet_id: params[0], name: 'Pull Batch', type: 'string', property: { humanWriteLock: 'plm_system' }, order: 1 }] }
      }
      if (q.startsWith('UPDATE meta_fields SET property = $3::jsonb')) {
        written.push(JSON.parse(String(params[2])))
        return { rows: [{ id: params[1], sheet_id: params[0], name: 'Pull Batch', type: 'string', property: JSON.parse(String(params[2])), order: 1 }] }
      }
      return { rows: [] }
    })
    await patchObjectFieldProperty({ query, projectId: 'tenant_bim:integration-core', objectId: 'plm_stock_preparation_sandbox_p_000000000000000000000001', fieldId: 'pullBatch', propertyPatch: { [KEY]: marker() } })
    expect(written).toHaveLength(1)
    expect(written[0]).toEqual(bandProperty())
  })
})

describe('BM-06 wiring (source scan)', () => {
  const meta = read('routes/univer-meta.ts')
  it('POST /fields (normalizeFieldWriteInput) strips the marker outermost', () => {
    expect(meta).toContain("property: stripPullBatchBandMarker(stripManualRowPolicyKey(stripHumanWriteLockKey(sanitizeFieldProperty(requestedType as UniverMetaField['type'], rawProperty)))),")
  })
  it('PATCH /fields carries the STORED marker on the unlocked read AND on the locked re-read (#6792)', () => {
    expect(meta).toContain('const nextProperty = carryPullBatchBandMarker(row.property, carryManualRowPolicy(row.property, carryHumanWriteLock(row.property, normalizedNextProperty)))')
    expect(meta).toContain('const writeProperty = carryPullBatchBandMarker(locked.property, carryManualRowPolicy(locked.property, carryHumanWriteLock(locked.property, nextProperty)))')
  })
  it('the config revert helper carries it', () => {
    const restore = read('multitable/config-restore.ts')
    const fn = restore.slice(restore.indexOf('export function fieldRevertPropertyKeepingLock('), restore.indexOf('export interface ConfigRevisionRow'))
    expect(fn).toContain('&& !hasPullBatchBandMarkerKey(storedProperty) && !hasPullBatchBandMarkerKey(revertProperty)')
    expect(fn).toContain('return carryPullBatchBandMarker(storedProperty, carryManualRowPolicy(storedProperty, carryHumanWriteLock(storedProperty, base)))')
  })
  it('the stamp runs only inside the manual-row branch, after the data loop, from the in-transaction field rows', () => {
    const rs = read('multitable/record-service.ts')
    const branch = rs.indexOf('      if (manualSheet) {\n        patch[manualSheet.derived.projectNo] = manualSheet.projectNo')
    const stamp = rs.indexOf('const pullBatchBand = pullBatchBandStampOf(fieldRes.rows')
    const loop = rs.indexOf('for (const [fieldId, value] of Object.entries(data)) {')
    const validation = rs.indexOf('const validationFields = buildDirectValidationFields(fieldRes.rows)')
    expect(branch).toBeGreaterThan(-1)
    expect(stamp).toBeGreaterThan(branch)
    expect(stamp).toBeGreaterThan(loop)
    expect(stamp).toBeLessThan(validation)
    expect(rs.split('pullBatchBandStampOf(').length - 1).toBe(1)
    // The pull-batch switch is not consulted (C10: the band's presence is the gate).
    expect(rs).not.toContain('STOCK_PREP_PULL_BATCH_ENABLED')
  })
})

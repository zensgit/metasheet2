/**
 * 批次标识 — the HOST ↔ PLUGIN BAND CONTRACT (design batch-id §4.1; ADR adr-stock-prep-manual-rows-20261030 §5.5; register
 * row R-65, rulings C1 / C10). Two halves that must not drift apart:
 *   - PLUGIN: plugins/plugin-integration-core/lib/stock-preparation-templates.cjs (the band descriptors and their property,
 *     built from the pure core's PULL_BATCH_MANUAL_LABELS / PULL_BATCH_BAND_FIELD_IDS);
 *   - HOST:   src/multitable/stock-preparation-pull-batch-band.ts (the predicates the manual-row stamp finds the band by).
 * #6807 (the host half) deferred this cross-side test to whichever PR landed second; the ledger PR is that PR.
 *
 *   BC-01 the constants are byte-equal: the property key, the marker, both manual labels, the column type and the lock kind.
 *   BC-02 what the plugin creates is what the host stamps: the descriptors for BOTH placements and BOTH locales, as is and
 *         after the host field-codecs sanitizer, are band columns to the host and give the stamp with the plugin's ids and
 *         the plugin's label for that locale.
 *   BC-03 the two predicates agree on the forge cases: a marker without the lock, a wrong marker, a wrong type.
 *
 * Every value is synthetic.
 */
import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

import * as host from '../../src/multitable/stock-preparation-pull-batch-band'
import { sanitizeFieldProperty } from '../../src/multitable/field-codecs'

const requireCjs = createRequire(import.meta.url)
const PLUGIN = '../../../../plugins/plugin-integration-core'
/* eslint-disable @typescript-eslint/no-explicit-any */
const templates = requireCjs(`${PLUGIN}/lib/stock-preparation-templates.cjs`) as any
const pure = requireCjs(`${PLUGIN}/lib/stock-preparation-pull-batch.cjs`) as any
/* eslint-enable @typescript-eslint/no-explicit-any */

type Descriptor = { id: string; name: string; type: string; order: number; property: Record<string, unknown> }

const LOCALES = ['zh-CN', 'en'] as const
const PLACEMENTS = ['left', 'right'] as const

function descriptorsOf(locale: string, placement: string): Descriptor[] {
  return templates.pullBatchBandFieldDescriptors({ locale, placement, maxExistingOrder: 40 }) as Descriptor[]
}

describe('pull-batch band contract (host ↔ plugin)', () => {
  it('BC-01 the property key, the marker, both manual labels, the column type and the lock kind are byte-equal', () => {
    const property = templates.pullBatchBandProperty('zh-CN') as Record<string, any>
    const keys = Object.keys(property).filter((key) => key !== 'humanWriteLock')
    expect(keys).toEqual([host.PULL_BATCH_BAND_PROPERTY_KEY])
    expect(host.PULL_BATCH_BAND_PROPERTY_KEY).toBe('stockPreparationPullBatch')

    expect(templates.STOCK_PREPARATION_PULL_BATCH_BAND_MARKER).toBe(host.PULL_BATCH_BAND_MARKER)
    expect(property[host.PULL_BATCH_BAND_PROPERTY_KEY].band).toBe(host.PULL_BATCH_BAND_MARKER)

    // The plugin's labels (by locale) are exactly the host's closed label list, no more and no fewer.
    const pluginLabels = Object.values(pure.PULL_BATCH_MANUAL_LABELS as Record<string, string>)
    expect([...pluginLabels].sort()).toEqual([...host.PULL_BATCH_MANUAL_LABELS].sort())
    expect(pure.PULL_BATCH_MANUAL_LABELS['zh-CN']).toBe('人工补充')
    expect(pure.PULL_BATCH_MANUAL_LABELS.en).toBe('Manual row')

    for (const entry of templates.STOCK_PREPARATION_PULL_BATCH_FIELDS as Array<{ type: string }>) {
      expect(entry.type).toBe(host.PULL_BATCH_BAND_FIELD_TYPE)
    }
    expect(host.PULL_BATCH_BAND_FIELD_TYPE).toBe('string')
    expect(property.humanWriteLock).toBe('plm_system')
  })

  for (const locale of LOCALES) {
    for (const placement of PLACEMENTS) {
      it(`BC-02 (${locale}, ${placement}) the plugin's band descriptors are the host's band, as created and after the sanitizer`, () => {
        const descriptors = descriptorsOf(locale, placement)
        const expectedLabel = pure.PULL_BATCH_MANUAL_LABELS[locale] as string
        const expectedIds = [pure.PULL_BATCH_BAND_FIELD_IDS.firstPullBatch, pure.PULL_BATCH_BAND_FIELD_IDS.pullBatch]
        expect(descriptors.map((entry) => entry.id)).toEqual(expectedIds)
        expect(templates.STOCK_PREPARATION_PULL_BATCH_FIELD_IDS).toEqual(expectedIds)

        for (const rows of [
          descriptors,
          descriptors.map((entry) => ({ ...entry, property: sanitizeFieldProperty(entry.type, entry.property) })),
          descriptors.map((entry) => ({ ...entry, property: JSON.stringify(entry.property) })),
        ]) {
          for (const row of rows) {
            expect(host.isPullBatchBandField(row)).toBe(true)
            expect(templates.isPullBatchBandProperty(typeof row.property === 'string' ? JSON.parse(row.property) : row.property)).toBe(true)
          }
          // Among other (ordinary) columns, in either order, the stamp names exactly the plugin's two ids and its label.
          const other = { id: 'fld_other', type: 'string', property: {} }
          const stamp = host.pullBatchBandStampOf([other, ...rows])
          expect(stamp).not.toBeNull()
          expect([...(stamp as host.PullBatchBandStamp).fieldIds]).toEqual(expectedIds)
          expect((stamp as host.PullBatchBandStamp).label).toBe(expectedLabel)
        }
      })
    }
  }

  it('BC-03 the forge cases: both sides refuse a marker without the lock, a wrong marker; the host refuses a wrong type', () => {
    const [first] = descriptorsOf('zh-CN', 'left')
    const marker = (first.property as Record<string, unknown>)[host.PULL_BATCH_BAND_PROPERTY_KEY]
    const noLock = { [host.PULL_BATCH_BAND_PROPERTY_KEY]: marker }
    const otherLock = { ...first.property, humanWriteLock: 'something_else' }
    const wrongMarker = { ...first.property, [host.PULL_BATCH_BAND_PROPERTY_KEY]: { band: 'v2', manualLabel: '人工补充' } }
    for (const property of [noLock, otherLock, wrongMarker]) {
      expect(host.isPullBatchBandField({ id: first.id, type: 'string', property })).toBe(false)
      expect(templates.isPullBatchBandProperty(property)).toBe(false)
    }
    expect(host.isPullBatchBandField({ id: first.id, type: 'number', property: first.property })).toBe(false)
  })
})

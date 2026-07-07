import { describe, expect, it } from 'vitest'
import {
  INTEGRATION_FIELD_HINTS,
  integrationFieldHint,
  type IntegrationFieldHintKey,
} from '../src/services/integration/fieldHints'

// IU-6b (design-lock docs/development/integration-ux-workbench-redesign-design-lock-20260706.md,
// #3739): field-level hint copy module. Mirrors the discipline already enforced on
// errorCodeLabels.ts / integrationErrorCodeLabels.spec.ts — exact-key, non-empty zh+en, values-free.

const ALL_KEYS = Object.keys(INTEGRATION_FIELD_HINTS) as IntegrationFieldHintKey[]

// values-free scan: no digit-run longer than 4 (a proxy for "looks like a real business code/number")
// and no raw URL scheme anywhere in the copy.
const DIGIT_RUN_TOO_LONG = /\d{5,}/
const HAS_URL_SCHEME = /https?:\/\//i

describe('fieldHints (IU-6b)', () => {
  it('has at least the ~15 highest-confusion fields covered', () => {
    expect(ALL_KEYS.length).toBeGreaterThanOrEqual(15)
  })

  it.each(ALL_KEYS)('%s has a non-empty zh AND en entry', (key) => {
    const entry = INTEGRATION_FIELD_HINTS[key]
    expect(entry).toBeTruthy()
    expect(entry.zh.trim().length).toBeGreaterThan(0)
    expect(entry.en.trim().length).toBeGreaterThan(0)
  })

  it.each(ALL_KEYS)('%s is values-free (no digit-run > 4, no http(s):// scheme)', (key) => {
    const entry = INTEGRATION_FIELD_HINTS[key]
    expect(entry.zh).not.toMatch(DIGIT_RUN_TOO_LONG)
    expect(entry.en).not.toMatch(DIGIT_RUN_TOO_LONG)
    expect(entry.zh).not.toMatch(HAS_URL_SCHEME)
    expect(entry.en).not.toMatch(HAS_URL_SCHEME)
  })

  it('integrationFieldHint returns the zh text for zh-CN and the en text for en, per exact key', () => {
    expect(integrationFieldHint('readSource.keyField', 'zh-CN')).toBe(INTEGRATION_FIELD_HINTS['readSource.keyField'].zh)
    expect(integrationFieldHint('readSource.keyField', 'en')).toBe(INTEGRATION_FIELD_HINTS['readSource.keyField'].en)
    expect(integrationFieldHint('composition.sourceTarget', 'zh-CN')).toBe(
      INTEGRATION_FIELD_HINTS['composition.sourceTarget'].zh,
    )
    expect(integrationFieldHint('composition.sourceTarget', 'en')).toBe(
      INTEGRATION_FIELD_HINTS['composition.sourceTarget'].en,
    )
  })

  it('covers every read-source config panel field this slice wires a tooltip to', () => {
    const expectedReadSourceKeys: IntegrationFieldHintKey[] = [
      'readSource.requiredKind',
      'readSource.mode',
      'readSource.readPath',
      'readSource.keyField',
      'readSource.keyEncoding',
      'readSource.resolverRule',
      'readSource.resolverSortField',
      'readSource.resolverSortDirection',
      'readSource.resolverDiscriminatorField',
      'readSource.resolverDiscriminatorValue',
      'readSource.containerPaths',
      'readSource.headerContainerPaths',
      'readSource.lineContainerPaths',
      'readSource.fieldMap',
      'readSource.boundedSmoke',
    ]
    for (const key of expectedReadSourceKeys) {
      expect(ALL_KEYS).toContain(key)
    }
  })

  it('covers every composition-authoring step-wiring field this slice wires a tooltip to', () => {
    const expectedCompositionKeys: IntegrationFieldHintKey[] = [
      'composition.step1ConfigId',
      'composition.step2ConfigId',
      'composition.name',
      'composition.sourceTarget',
    ]
    for (const key of expectedCompositionKeys) {
      expect(ALL_KEYS).toContain(key)
    }
  })
})

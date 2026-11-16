/**
 * C1/S2 first slice — C02: the fixed catalog, the strict request, the dependency-free synthetic provider,
 * and the ordinary rule entries refusing the preview-only step types. Evidence D §7 C02 (+ the static half
 * of "the only provider has no network/DB/file/env/credential dependency").
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  createSyntheticMaterialProvider,
  describeSyntheticPreviewCatalog,
  parseSyntheticPreviewRequest,
  SYNTHETIC_MATERIAL_COLUMNS,
  SYNTHETIC_MATERIAL_FIXTURE_IDS,
  SYNTHETIC_MATERIAL_OPERATION,
  SYNTHETIC_PREVIEW_PLAN,
  SYNTHETIC_PREVIEW_STEP_TYPES,
  SYNTHETIC_YIDA_MAPPING_PRESET_IDS,
  syntheticMaterialFixture,
  syntheticYidaMappingPreset,
} from '../../src/integration/automation-operation-catalog'
import { ALL_ACTION_TYPES } from '../../src/multitable/automation-actions'
import { AutomationRuleValidationError, AutomationService } from '../../src/multitable/automation-service'
import { EventBus } from '../../src/integration/events/event-bus'

const VALID = { planId: 'plm-material-to-yida-preview.v1', fixtureId: 'synthetic-materials.two-page.v1', mappingPresetId: 'yida-material-v3.original.v1' }
const ROOT = path.resolve(__dirname, '..', '..', '..', '..')

describe('C02 — strict request', () => {
  it('accepts exactly the three fixed catalog ids', () => {
    expect(parseSyntheticPreviewRequest({ ...VALID })).toEqual(VALID)
    expect(Object.isFrozen(parseSyntheticPreviewRequest({ ...VALID }))).toBe(true)
    for (const fixtureId of SYNTHETIC_MATERIAL_FIXTURE_IDS) {
      for (const mappingPresetId of SYNTHETIC_YIDA_MAPPING_PRESET_IDS) {
        expect(parseSyntheticPreviewRequest({ planId: VALID.planId, fixtureId, mappingPresetId })).not.toBeNull()
      }
    }
  })

  it.each([
    ['rows', [{ projectNo: 'x' }]], ['rowsText', '[]'], ['url', 'http://127.0.0.1/'], ['headers', { authorization: 'x' }],
    ['credentials', { appKey: 'x' }], ['connectionId', 'c1'], ['operation', 'http.get'], ['sourceSheetId', 's1'],
    ['synthetic', true], ['tenantId', 't'], ['actorId', 'a'], ['config', {}], ['allocation', { mode: 'original' }],
  ])('refuses an extra %s field', (key, value) => {
    expect(parseSyntheticPreviewRequest({ ...VALID, [key]: value })).toBeNull()
  })

  it.each([
    ['floating plan version', { ...VALID, planId: 'plm-material-to-yida-preview.latest' }],
    ['other plan', { ...VALID, planId: 'plm-material-to-yida-preview.v2' }],
    ['unregistered fixture', { ...VALID, fixtureId: 'synthetic-materials.two-page.v2' }],
    ['floating fixture', { ...VALID, fixtureId: 'synthetic-materials.latest' }],
    ['unregistered preset', { ...VALID, mappingPresetId: 'yida-material-v2.original.v1' }],
    ['missing field', { planId: VALID.planId, fixtureId: VALID.fixtureId }],
    ['non-string id', { ...VALID, fixtureId: ['synthetic-materials.two-page.v1'] }],
  ])('refuses %s', (_label, body) => {
    expect(parseSyntheticPreviewRequest(body)).toBeNull()
  })

  it('refuses arrays, null, primitives, accessors, symbol keys and foreign prototypes', () => {
    expect(parseSyntheticPreviewRequest(null)).toBeNull()
    expect(parseSyntheticPreviewRequest('x')).toBeNull()
    expect(parseSyntheticPreviewRequest([VALID])).toBeNull()
    const accessor = { planId: VALID.planId, fixtureId: VALID.fixtureId } as Record<string, unknown>
    Object.defineProperty(accessor, 'mappingPresetId', { enumerable: true, get: () => VALID.mappingPresetId })
    expect(parseSyntheticPreviewRequest(accessor)).toBeNull()
    expect(parseSyntheticPreviewRequest({ ...VALID, [Symbol('x')]: 1 })).toBeNull()
    expect(parseSyntheticPreviewRequest(Object.assign(Object.create({ inherited: true }), VALID))).toBeNull()
    expect(parseSyntheticPreviewRequest(JSON.parse('{"planId":"plm-material-to-yida-preview.v1","fixtureId":"synthetic-materials.two-page.v1","mappingPresetId":"yida-material-v3.original.v1","__proto__":{"x":1}}'))).toBeNull()
  })
})

describe('C02 — catalog and provider', () => {
  it('registers exactly one operation, one consumer and the fixed two-step plan', () => {
    expect(SYNTHETIC_MATERIAL_OPERATION).toMatchObject({ id: 'plm.material.list.synthetic.v1', version: 1, consumers: ['yida.preview.synthetic.v1'] })
    expect(SYNTHETIC_PREVIEW_PLAN.steps.map((step) => [step.id, step.type])).toEqual([
      ['read-materials', 'integration_preview_read'], ['yida-preview', 'integration_preview_yida'],
    ])
    expect(Object.isFrozen(SYNTHETIC_PREVIEW_PLAN.steps[1].input.columns)).toBe(true)
    expect(describeSyntheticPreviewCatalog().fixtureIds).toEqual(['synthetic-materials.two-page.v1', 'synthetic-materials.single-page.v1'])
  })

  it('every fixture row carries exactly the declared output columns, and fixtures are deep-frozen', () => {
    for (const id of SYNTHETIC_MATERIAL_FIXTURE_IDS) {
      const fixture = syntheticMaterialFixture(id)
      expect(Object.isFrozen(fixture.pages)).toBe(true)
      for (const page of fixture.pages) {
        expect(Object.isFrozen(page)).toBe(true)
        for (const row of page.rows) expect(Object.keys(row).sort()).toEqual([...SYNTHETIC_MATERIAL_COLUMNS].sort())
      }
    }
  })

  it('the provider pages by cursor and refuses an unknown fixture or cursor', async () => {
    const provider = createSyntheticMaterialProvider()
    const first = await provider.readPage({ fixtureId: 'synthetic-materials.two-page.v1', cursor: null })
    expect(first.nextCursor).toBe('synthetic-cursor-2')
    expect((await provider.readPage({ fixtureId: 'synthetic-materials.two-page.v1', cursor: 'synthetic-cursor-2' })).nextCursor).toBeNull()
    await expect(provider.readPage({ fixtureId: 'synthetic-materials.two-page.v1', cursor: 'forged' })).rejects.toThrow('SYNTHETIC_PROVIDER_CURSOR')
    await expect(provider.readPage({ fixtureId: 'forged' as never, cursor: null })).rejects.toThrow('SYNTHETIC_PROVIDER_INPUT')
  })

  it('the catalog/provider module imports nothing and reads no env, network, file, database or credential surface', () => {
    const source = readFileSync(path.join(ROOT, 'packages/core-backend/src/integration/automation-operation-catalog.ts'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/\bimport\b|\brequire\s*\(/)
    expect(code).not.toMatch(/process\.|globalThis|\bfetch\b|XMLHttpRequest|WebSocket|\bnet\b\.|Buffer|\beval\b|new Function/)
  })

  it('Y01: the mapping presets carry exactly the checked-in v3 material template rules', async () => {
    const { parseYidaRuleTemplate } = await import(pathToFileURL(path.join(ROOT, 'plugins/plugin-integration-core/lib/yida-rule-template.mjs')).href)
    const text = readFileSync(path.join(ROOT, 'plugins/plugin-integration-core/fixtures/yida-rule-templates/material-v3.json'), 'utf8').replace(/\r\n/g, '\n')
    const imported = parseYidaRuleTemplate(text)
    for (const id of SYNTHETIC_YIDA_MAPPING_PRESET_IDS) {
      expect(JSON.parse(JSON.stringify(syntheticYidaMappingPreset(id).rules))).toEqual(imported.rules)
    }
    const allocated = syntheticYidaMappingPreset('yida-material-v3.allocated.v1').allocation
    expect(allocated).toMatchObject(imported.allocation)
  })
})

describe('C02 — ordinary rule entries refuse the preview-only step types', () => {
  it('the preview step types are not ordinary action types', () => {
    for (const type of SYNTHETIC_PREVIEW_STEP_TYPES) expect(ALL_ACTION_TYPES as readonly string[]).not.toContain(type)
  })

  it.each(SYNTHETIC_PREVIEW_STEP_TYPES)('createRule / updateRule refuse %s (top-level and in actions[]) before any write', async (type) => {
    const query = vi.fn(async () => ({ rows: [] as unknown[], rowCount: 0 }))
    const service = new AutomationService(new EventBus(), {} as never, query)
    await expect(service.createRule('sheet_x', { name: 'n', triggerType: 'record.created', triggerConfig: {}, actionType: type, actionConfig: {} } as never))
      .rejects.toBeInstanceOf(AutomationRuleValidationError)
    await expect(service.createRule('sheet_x', {
      name: 'n', triggerType: 'record.created', triggerConfig: {}, actionType: 'send_webhook', actionConfig: { url: 'https://example.invalid' },
      actions: [{ type, config: {} }],
    } as never)).rejects.toBeInstanceOf(AutomationRuleValidationError)
    await expect(service.updateRule('rule_x', 'sheet_x', { actionType: type } as never)).rejects.toBeInstanceOf(AutomationRuleValidationError)
    expect(query).not.toHaveBeenCalled()
    await service.shutdown()
  })
})

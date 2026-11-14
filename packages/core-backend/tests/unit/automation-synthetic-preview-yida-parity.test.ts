/**
 * C1/S2 first slice — Y01: one synthetic input, three places that compute the YiDa plan:
 *   template import (parseYidaRuleTemplate on the checked-in material-v3 template),
 *   browser pure preview (the StockPreparationYidaPreviewPanel sequence: validate -> parse rows -> static plan
 *     or allocation preview), and
 *   host pure recompute (the synthetic preview consumer -> compileYidaLocalDraft),
 * give the same normalized plan; reordering non-key derived fields keeps the duplicate identity (key
 * definition and business-key digests); and the host view carries no send/approve authority.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { syntheticMaterialFixture, syntheticYidaMappingPreset, SYNTHETIC_YIDA_MAPPING_PRESET_IDS } from '../../src/integration/automation-operation-catalog'
import { createYidaSyntheticPreviewConsumer, loadYidaLocalDraftCompiler, type YidaLocalDraftCompile } from '../../src/integration/yida-automation-preview'

const ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const lib = (name: string) => import(pathToFileURL(path.join(ROOT, 'plugins/plugin-integration-core/lib', name)).href)
type Fn = (...args: unknown[]) => unknown
let compileYidaLocalDraft: YidaLocalDraftCompile
let planner: { buildYidaStaticPlan: Fn; parseYidaStaticRows: Fn; validateYidaStaticConfig: Fn }
let allocationLib: { buildYidaProjectAllocationPreview: Fn }
let template: { parseYidaRuleTemplate: Fn }

beforeAll(async () => {
  compileYidaLocalDraft = (await lib('yida-draft-compiler.mjs')).compileYidaLocalDraft
  planner = await lib('yida-static-plan.mjs') as never
  allocationLib = await lib('stock-preparation-yida-allocation.mjs') as never
  template = await lib('yida-rule-template.mjs') as never
})

const rows = () => syntheticMaterialFixture('synthetic-materials.two-page.v1').pages.flatMap((page) => page.rows).map((row) => ({ ...row }))

function browserPlan(rules: Record<string, unknown>, target: unknown, rowsText: string, allocation: Record<string, unknown>) {
  const config = { ...rules, target }
  if (allocation.mode !== 'original') {
    return (allocationLib.buildYidaProjectAllocationPreview({ config, rowsText, allocation }) as { plan: unknown }).plan
  }
  const checked = planner.validateYidaStaticConfig(config) as { valid: boolean; normalized: unknown }
  expect(checked.valid).toBe(true)
  return planner.buildYidaStaticPlan({ config: checked.normalized, rows: planner.parseYidaStaticRows(rowsText, checked.normalized) })
}

describe('Y01 — template import, browser preview and host recompute agree', () => {
  it.each(SYNTHETIC_YIDA_MAPPING_PRESET_IDS)('%s: identical plan rows and payloads from all three', (presetId) => {
    const preset = syntheticYidaMappingPreset(presetId)
    const text = readFileSync(path.join(ROOT, 'plugins/plugin-integration-core/fixtures/yida-rule-templates/material-v3.json'), 'utf8').replace(/\r\n/g, '\n')
    const imported = template.parseYidaRuleTemplate(text) as { rules: Record<string, unknown>; allocation: Record<string, unknown> }
    const allocation = preset.allocation.mode === 'original'
      ? { mode: 'original' }
      : { ...imported.allocation, projects: [...preset.allocation.projects] }
    const rowsText = JSON.stringify(rows())
    const browser = browserPlan(imported.rules, { ...preset.target }, rowsText, allocation)
    const host = compileYidaLocalDraft({ config: { ...imported.rules, target: { ...preset.target } }, rowsText, allocation }) as { plan: unknown; planDigest: string }
    expect(host.plan).toEqual(browser)
    const view = createYidaSyntheticPreviewConsumer(compileYidaLocalDraft).consume(rows(), preset)
    expect(view.planDigest).toBe(host.planDigest)
    const browserRows = (browser as { rows: Array<{ payload: Record<string, unknown> }> }).rows
    expect(view.rows).toHaveLength(browserRows.length)
    view.rows.forEach((row, index) => {
      expect(Object.keys(row.fields).length).toBeGreaterThan(0)
      for (const [field, value] of Object.entries(row.fields)) expect(browserRows[index].payload[field]).toEqual(value)
    })
  })

  it('reordering non-key derived fields keeps the key definition and the business-key digests', () => {
    const preset = syntheticYidaMappingPreset('yida-material-v3.original.v1')
    const rules = JSON.parse(JSON.stringify(preset.rules)) as { fieldMap: Array<{ transform: string; target: string }>; businessKey: string[] }
    const keyTargets = new Set(rules.businessKey)
    const reordered = {
      ...rules,
      fieldMap: [
        ...rules.fieldMap.filter((entry) => !keyTargets.has(entry.target)).reverse(),
        ...rules.fieldMap.filter((entry) => keyTargets.has(entry.target)),
      ],
    }
    const input = (config: unknown) => ({ config: { ...(config as object), target: { ...preset.target } }, rowsText: JSON.stringify(rows()), allocation: { mode: 'original' } })
    const original = compileYidaLocalDraft(input(rules)) as { keyDefinitionDigest: string; rowSpecs: Array<{ businessKeyDigest: string }> }
    const swapped = compileYidaLocalDraft(input(reordered)) as { keyDefinitionDigest: string; rowSpecs: Array<{ businessKeyDigest: string }> }
    expect(swapped.keyDefinitionDigest).toBe(original.keyDefinitionDigest)
    expect(swapped.rowSpecs.map((spec) => spec.businessKeyDigest)).toEqual(original.rowSpecs.map((spec) => spec.businessKeyDigest))
  })

  it('the host consumer refuses a compiler that does not report a non-applyable, token-free, write-free plan', () => {
    const preset = syntheticYidaMappingPreset('yida-material-v3.original.v1')
    const real = compileYidaLocalDraft
    for (const flag of ['canApply', 'tokenIssued', 'lookupExecuted', 'externalWriteAttempted']) {
      const forged: YidaLocalDraftCompile = (input) => {
        const result = JSON.parse(JSON.stringify(real(input))) as { plan: Record<string, unknown> }
        result.plan[flag] = true
        return result
      }
      expect(() => createYidaSyntheticPreviewConsumer(forged).consume(rows(), preset)).toThrow('YIDA_SYNTHETIC_PREVIEW_REJECTED')
    }
  })

  it('the production loader yields exactly the v2+v3 local compiler (the persisted v2-only export would refuse the v3 preset)', async () => {
    // The suite runs with cwd = packages/core-backend; the loader resolves the plugin root like the plugin loader.
    const loaded = await loadYidaLocalDraftCompiler()
    const view = createYidaSyntheticPreviewConsumer(loaded).consume(rows(), syntheticYidaMappingPreset('yida-material-v3.original.v1'))
    expect(view.rowCount).toBe(3)
  })

  it('the consumer module reaches only compileYidaLocalDraft: no draft store, approve, submit or send port', () => {
    const source = readFileSync(path.join(ROOT, 'packages/core-backend/src/integration/yida-automation-preview.ts'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).toMatch(/loaded\.compileYidaLocalDraft/)
    expect(code).not.toMatch(/compileYidaDraft\b|prepareDraft|approve|submit|\bsend\b|grant|admission|DraftPlanStore|yida-draft-plan|owner-send|fetch\(/i)
  })
})

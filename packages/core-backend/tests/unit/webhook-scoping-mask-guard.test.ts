/**
 * U7 — subscription webhook bodies are masked through the read path's named filter.
 *
 * The stored-data taint guard (multitable-stored-data-taint-chokepoint.guard.test.ts) recognises a mask
 * only by the spelling `filterRecordDataByFieldIds(`. So the delivery rules module must call it by that name
 * over the read-path field set, must not define its own function of that name (a local copy would carry the
 * spelling without the rule), and must be inside that guard's whole-`src` scan. G7 plants both violations.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = join(__dirname, '../../src')
const RULES = 'multitable/webhook-delivery-authority.ts'
const SERVICE = 'multitable/webhook-service.ts'

function runtimeFiles(): string[] {
  const out: string[] = []
  const walk = (absDir: string): void => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const abs = join(absDir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'migrations') continue
        walk(abs)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue
      if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts')) continue
      out.push(relative(SRC, abs).split(sep).join('/'))
    }
  }
  walk(SRC)
  return out
}

export function scanWebhookMask(rulesSource: string): string[] {
  const violations: string[] = []
  const calls = rulesSource.match(/\bfilterRecordDataByFieldIds\(valueMap, readableFieldIds\)/g) ?? []
  if (calls.length !== 1) violations.push('mask-call')
  if (!/\bloadReadableRecordFieldIdsForAccess\(/.test(rulesSource)) violations.push('mask-field-set')
  if (
    /function\s+filterRecordDataByFieldIds\b/.test(rulesSource)
    || /(const|let|var)\s+filterRecordDataByFieldIds\s*=/.test(rulesSource)
    || /\bfilterRecordDataByFieldIds\s*\([^)]*\)\s*(:[^{]*)?\{/.test(rulesSource)
  ) {
    violations.push('local-definition')
  }
  return violations
}

const RULES_SOURCE = readFileSync(join(SRC, RULES), 'utf8')

describe('U7 webhook body mask', () => {
  test('the rules module calls the read-path filter by name over the read-path field set', () => {
    expect(scanWebhookMask(RULES_SOURCE)).toEqual([])
  })

  test('the rules module and the webhook service are inside the stored-data guard scan set', () => {
    const files = runtimeFiles()
    expect(files).toContain(RULES)
    expect(files).toContain(SERVICE)
  })

  test('G7: removing the call, or planting a local definition, is reported', () => {
    const removed = RULES_SOURCE.replace('filterRecordDataByFieldIds(valueMap, readableFieldIds)', '{ ...valueMap }')
    expect(removed).not.toBe(RULES_SOURCE)
    expect(scanWebhookMask(removed)).toContain('mask-call')
    const planted = `${RULES_SOURCE}\nfunction filterRecordDataByFieldIds(data: unknown, allowed: Set<string>) { return {} }\n`
    expect(scanWebhookMask(planted)).toContain('local-definition')
    const plantedArrow = `${RULES_SOURCE}\nconst filterRecordDataByFieldIds = (d: unknown) => d\n`
    expect(scanWebhookMask(plantedArrow)).toContain('local-definition')
  })
})

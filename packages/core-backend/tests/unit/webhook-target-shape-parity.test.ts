import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { checkWebhookTargetUrlShape } from '../../src/multitable/webhook-ssrf-guard'
import { classifyWebhookRefusal } from '../../src/multitable/webhook-refusal-class'

/**
 * Server side of the two-sided pin for the webhook target hint. The SAME file is replayed by
 * `apps/web/tests/webhook-target-hint.spec.ts` against `apps/web/src/multitable/utils/webhookTargetHint.ts`
 * (the live warning under both webhook URL inputs). The web hint warns and never blocks, but a hint that
 * disagrees with this check either nags on a target the server accepts or stays silent on one it refuses;
 * changing either implementation without this table turns that side red.
 */
const TRUTH_TABLE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/webhook-target-shape-truth-table.json',
)

type HintClass = 'ok' | 'empty' | 'malformed' | 'not_https' | 'internal_name' | 'internal_ip'

interface TruthTable {
  cases: Array<{ name: string; url: string | null; expected: HintClass; refusalClass?: string }>
}

const table = JSON.parse(fs.readFileSync(TRUTH_TABLE_PATH, 'utf8')) as TruthTable

/** The guard's reason for each class (see the fixture's $comment). */
function reasonMatches(expected: Exclude<HintClass, 'ok'>, reason: string): boolean {
  switch (expected) {
    case 'empty': return reason === 'URL is required'
    case 'malformed': return reason === 'URL is malformed'
    case 'not_https': return reason.startsWith('scheme not allowed')
    case 'internal_name': return reason === 'target host is internal'
    case 'internal_ip': return reason === 'target IP is internal'
  }
}

describe('webhook target shape (shared truth table with the web hint)', () => {
  it('reads a non-trivial table covering every class (a silently emptied fixture must not pass as green)', () => {
    expect(table.cases.length).toBeGreaterThanOrEqual(40)
    const classes = new Set(table.cases.map((row) => row.expected))
    expect([...classes].sort()).toEqual(['empty', 'internal_ip', 'internal_name', 'malformed', 'not_https', 'ok'])
    const names = table.cases.map((row) => row.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it.each(table.cases.map((row) => [row.name, row] as const))(
    'checkWebhookTargetUrlShape: %s',
    (_name, row) => {
      const shape = checkWebhookTargetUrlShape(row.url)
      if (row.expected === 'ok') {
        expect(shape).toMatchObject({ ok: true })
        expect(row.refusalClass).toBeUndefined()
        return
      }
      expect(shape.ok).toBe(false)
      const reason = (shape as { reason: string }).reason
      expect(reasonMatches(row.expected, reason), `reason was: ${reason}`).toBe(true)
      // The class a save-time refusal carries (rules: `(<class>)`; subscriptions: `WEBHOOK_TARGET_REJECTED:<class>`).
      expect(row.refusalClass).toBeTypeOf('string')
      expect(classifyWebhookRefusal(row.url, reason).refusalClass).toBe(row.refusalClass)
    },
  )
})

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  classifyWebhookTarget,
  isKnownWebhookRefusalClass,
  webhookRefusalClassMessage,
  webhookTargetHelpText,
  webhookTargetHint,
  webhookTargetLabel,
  webhookTargetSaveErrorMessage,
  type WebhookTargetHintClass,
} from '../src/multitable/utils/webhookTargetHint'

/**
 * Browser side of the two-sided pin for the webhook target hint.
 *
 * THE SAME FILE on disk drives `packages/core-backend/tests/unit/webhook-target-shape-parity.test.ts`
 * against the server's `checkWebhookTargetUrlShape`. The hint must never flag a target the server accepts
 * (it would nag users off valid targets) and should flag every target the server refuses from the URL alone.
 */
const TRUTH_TABLE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../packages/core-backend/tests/fixtures/webhook-target-shape-truth-table.json',
)

interface TruthTable {
  cases: Array<{ name: string; url: string | null; expected: WebhookTargetHintClass; refusalClass?: string }>
}

const table = JSON.parse(readFileSync(TRUTH_TABLE_PATH, 'utf8')) as TruthTable

describe('webhook target hint parity with the server shape check', () => {
  it('reads a non-trivial table covering every class (a silently emptied fixture must not pass as green)', () => {
    expect(table.cases.length).toBeGreaterThanOrEqual(40)
    const classes = new Set(table.cases.map((row) => row.expected))
    expect([...classes].sort()).toEqual(['empty', 'internal_ip', 'internal_name', 'malformed', 'not_https', 'ok'])
  })

  it.each(table.cases.map((row) => [row.name, row] as const))(
    'classifyWebhookTarget: %s',
    (_name, row) => {
      expect(classifyWebhookTarget(row.url)).toBe(row.expected)
    },
  )

  it.each(table.cases.filter((row) => row.refusalClass).map((row) => [row.name, row] as const))(
    'every class the server attaches at save has its own copy: %s',
    (_name, row) => {
      expect(isKnownWebhookRefusalClass(row.refusalClass as string)).toBe(true)
    },
  )
})

describe('webhookTargetHint', () => {
  it('is silent for an accepted target and for an empty field', () => {
    expect(webhookTargetHint('https://example.com/hook', true)).toBeNull()
    expect(webhookTargetHint('', true)).toBeNull()
    expect(webhookTargetHint('   ', false)).toBeNull()
    expect(webhookTargetHint(undefined, false)).toBeNull()
  })

  it('names the reason in zh and en and never echoes the URL', () => {
    const cases: Array<[string, string, string]> = [
      ['http://example.com/hook', '只能使用 https://', 'Only https://'],
      ['https://10.0.0.5/secret-path', '内网或本机地址', 'intranet or local address'],
      ['https://svc.internal/secret-path', '内网域名', 'intranet name'],
      ['not a url', '不是有效的网址', 'not a valid URL'],
    ]
    for (const [url, zh, en] of cases) {
      const zhText = webhookTargetHint(url, true) ?? ''
      const enText = webhookTargetHint(url, false) ?? ''
      expect(zhText).toContain(zh)
      expect(enText).toContain(en)
      expect(zhText).not.toContain('secret-path')
      expect(enText).not.toContain('secret-path')
    }
  })

  it('help line says public https only, and that a name resolving to an intranet address is refused at send time', () => {
    expect(webhookTargetHelpText(true)).toContain('只能填公网可访问的 https 地址')
    expect(webhookTargetHelpText(true)).toContain('发送时被拒绝')
    expect(webhookTargetHelpText(false)).toContain('publicly reachable https address')
    expect(webhookTargetHelpText(false)).toContain('refused when sending')
  })
})

describe('webhookTargetSaveErrorMessage', () => {
  const prefixZh = webhookTargetLabel('refused.prefix', true)

  it('maps the rule-save refusal (code + class in the message) to the same copy as the live hint', () => {
    const err = Object.assign(new Error('send_webhook target refused (private) at actions[0].config.url'), {
      code: 'WEBHOOK_TARGET_REJECTED',
    })
    expect(webhookTargetSaveErrorMessage(err, true)).toBe(prefixZh + webhookTargetHint('https://10.0.0.5/', true))
  })

  it('maps the subscription-save refusals', () => {
    const rejected = Object.assign(new Error('WEBHOOK_TARGET_REJECTED:internal-name'), { code: 'WEBHOOK_TARGET_REJECTED' })
    expect(webhookTargetSaveErrorMessage(rejected, true)).toBe(prefixZh + webhookTargetHint('https://svc.internal/', true))
    const notHttps = Object.assign(new Error('Webhook URL must use HTTPS'), { code: 'CREATE_WEBHOOK_FAILED' })
    expect(webhookTargetSaveErrorMessage(notHttps, true)).toBe(prefixZh + webhookTargetHint('http://example.com/', true))
    const malformed = Object.assign(new Error('Webhook URL is not a valid URL'), { code: 'UPDATE_WEBHOOK_FAILED' })
    expect(webhookTargetSaveErrorMessage(malformed, false)).toBe(
      webhookTargetLabel('refused.prefix', false) + webhookTargetHint('not a url', false),
    )
  })

  it('an unknown or missing class falls back to the generic sentence, never the raw code', () => {
    for (const err of [
      Object.assign(new Error('WEBHOOK_TARGET_REJECTED:some-future-class'), { code: 'WEBHOOK_TARGET_REJECTED' }),
      Object.assign(new Error('send_webhook target refused (internal-other) at actions[0].config.url'), { code: 'WEBHOOK_TARGET_REJECTED' }),
      Object.assign(new Error(''), { code: 'WEBHOOK_TARGET_REJECTED' }),
    ]) {
      const text = webhookTargetSaveErrorMessage(err, true) ?? ''
      expect(text).toBe(prefixZh + webhookRefusalClassMessage(null, true))
      expect(text).not.toContain('WEBHOOK_TARGET_REJECTED')
      expect(text).not.toContain('some-future-class')
    }
  })

  it('leaves every other error to the caller', () => {
    expect(webhookTargetSaveErrorMessage(new Error('Webhook name is required'), true)).toBeNull()
    expect(webhookTargetSaveErrorMessage(Object.assign(new Error('nope'), { code: 'FORBIDDEN' }), true)).toBeNull()
    expect(webhookTargetSaveErrorMessage('WEBHOOK_TARGET_REJECTED:private', true)).toBeNull()
    expect(webhookTargetSaveErrorMessage(null, true)).toBeNull()
  })
})

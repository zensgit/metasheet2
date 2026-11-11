/**
 * Redaction of text that may reach a log, an error message or a report.
 */
import { describe, expect, it } from 'vitest'
import { FEISHU_REDACTED, feishuLogLabel, redactFeishuMeta, redactFeishuText } from '../../src/integrations/feishu/redaction'
import { FeishuBusinessError, FeishuRequestError, FeishuTimeoutError } from '../../src/integrations/feishu/errors'

const JWT = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmeCJ9.c2lnbmF0dXJlLWZ4LTAwMDE'

describe('FX-T08 redaction', () => {
  const SECRETS: Array<[string, string, string]> = [
    ['a bearer credential', 'Authorization: Bearer t-fx-token-0001-abcdefghij failed', 't-fx-token-0001-abcdefghij'],
    ['a bearer credential in another case', 'bearer ABCDEF-credential', 'ABCDEF-credential'],
    ['a basic credential', 'Authorization: Basic Zm9vOmJhcmJhcmJhcg==', 'Zm9vOmJhcmJhcmJhcg=='],
    ['a tenant token by prefix', 'minted t-fx-token-0001-abcdefghij for the app', 't-fx-token-0001-abcdefghij'],
    ['a user token by prefix', 'user u-fx-token-0001-abcdefghij', 'u-fx-token-0001-abcdefghij'],
    ['a JWT', `token ${JWT} issued`, JWT],
    ['a client secret in a form', 'grant_type=client_credentials&client_secret=fx-secret-0001&x=1', 'fx-secret-0001'],
    ['a client secret in JSON', '{"client_secret":"fx-secret-0001","client_id":"x"}', 'fx-secret-0001'],
    ['an app secret with a colon', 'appSecret: fx-secret-0001', 'fx-secret-0001'],
    ['an access token field', 'access_token=fx-opaque-0001', 'fx-opaque-0001'],
    ['a code verifier', 'code_verifier=fx-verifier-0001', 'fx-verifier-0001'],
    ['a URL with a query', 'GET https://open.example.invalid/open-apis/x?access_token=abc failed', 'open.example.invalid'],
    ['a URL with user information', 'https://user:password@host.example.invalid/path', 'password'],
    ['an open id', 'user ou_fx_0001 not found', 'ou_fx_0001'],
    ['a union id', 'user on_fx_0001', 'on_fx_0001'],
    ['a department id', 'department od-fx-0001 missing', 'od-fx-0001'],
    ['an application id', 'app cli_fx_0001 rejected', 'cli_fx_0001'],
    ['a long opaque run', `value ${'A1b2'.repeat(12)} end`, 'A1b2'.repeat(12)],
  ]
  for (const [name, text, secret] of SECRETS) {
    it(`replaces ${name}`, () => {
      const redacted = redactFeishuText(text)
      expect(redacted).not.toContain(secret)
      expect(redacted).toContain(FEISHU_REDACTED)
    })
  }

  it('leaves ordinary text alone', () => {
    const text = 'Directory pull finished: 12 departments, 340 members, 0 retries; basic information read'
    expect(redactFeishuText(text)).toBe(text)
  })

  it('keeps the shape of the sentence around a replacement', () => {
    expect(redactFeishuText('Authorization: Bearer t-fx-token-0001-abcdefghij failed')).toBe('Authorization: Bearer [redacted] failed')
  })

  it('walks metadata: strings are redacted, secret-named keys are replaced, depth is bounded', () => {
    const meta = redactFeishuMeta({
      note: 'user ou_fx_0001',
      appSecret: 'fx-secret-0001',
      nested: { access_token: 'fx-opaque-0001', list: ['Bearer abc-def-ghi', 3, null] },
      deep: { a: { b: { c: { d: 'x' } } } },
    }) as Record<string, unknown>
    const text = JSON.stringify(meta)
    for (const leaked of ['ou_fx_0001', 'fx-secret-0001', 'fx-opaque-0001', 'abc-def-ghi']) expect(text).not.toContain(leaked)
    expect((meta.nested as { list: unknown[] }).list[1]).toBe(3)
    expect(JSON.stringify(meta.deep)).toContain(FEISHU_REDACTED)
  })

  it('a log label is the class name with a numeric code, never the text', () => {
    expect(feishuLogLabel(new FeishuBusinessError(230013, 400, { msg: 'provider text' }))).toBe('FeishuBusinessError code 230013')
    expect(feishuLogLabel(new FeishuRequestError(502, null))).toBe('FeishuRequestError HTTP 502')
    expect(feishuLogLabel(new FeishuTimeoutError(10))).toBe('FeishuTimeoutError')
    expect(feishuLogLabel(new Error('driver text with host'))).toBe('Error')
    expect(feishuLogLabel('text')).toBe('non-error')
  })
})

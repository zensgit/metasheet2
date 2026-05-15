import { describe, expect, it } from 'vitest'

import {
  REDACTION_VERSION,
  redactString,
  redactValue,
  summarizeStepError,
  summarizeStepOutput,
} from '../src/multitable/utils/automation-log-redact'

describe('automation-log-redact — REDACTION_VERSION', () => {
  it('exposes a numeric version', () => {
    expect(typeof REDACTION_VERSION).toBe('number')
  })
})

describe('redactString', () => {
  it('masks Bearer tokens', () => {
    const out = redactString('Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890')
    expect(out).toBe('Authorization: Bearer <redacted>')
  })

  it('masks JWT eyJ tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4f'
    expect(redactString(jwt)).toContain('<jwt:redacted>')
    expect(redactString(jwt)).not.toContain('eyJhbGciOi')
  })

  it('masks DingTalk SEC robot secret', () => {
    const out = redactString('robot=SECabcdef1234567890')
    expect(out).toContain('SEC<redacted>')
    expect(out).not.toContain('SECabcdef1234567890')
  })

  it('masks sk- style API keys', () => {
    const out = redactString('OPENAI=sk-abcdefghijklmnop1234567890qrstuv')
    expect(out).toContain('sk-<redacted>')
    expect(out).not.toContain('sk-abcdefghijklmnop1234567890qrstuv')
  })

  it('masks access_token / publicToken / sign / timestamp in URL query strings', () => {
    const url = 'https://oapi.dingtalk.com/robot/send?access_token=raw-leak&sign=signleak&timestamp=tsleak'
    const out = redactString(url)
    expect(out).toMatch(/access_token=<redacted>/)
    expect(out).toMatch(/sign=<redacted>/)
    expect(out).toMatch(/timestamp=<redacted>/)
    expect(out).not.toContain('raw-leak')
    expect(out).not.toContain('signleak')
  })

  it('masks env-style API_KEY / CLIENT_SECRET / TOKEN / PASSWORD assignments', () => {
    const out = redactString(
      'OPENAI_API_KEY=plain-value-not-sk\nDINGTALK_CLIENT_SECRET=clientsecretval\nAUTH_TOKEN=tokval\nDB_PASSWORD=pw99',
    )
    expect(out).toMatch(/OPENAI_API_KEY=<redacted>/)
    expect(out).toMatch(/DINGTALK_CLIENT_SECRET=<redacted>/)
    expect(out).toMatch(/AUTH_TOKEN=<redacted>/)
    expect(out).toMatch(/DB_PASSWORD=<redacted>/)
    expect(out).not.toMatch(/plain-value-not-sk|clientsecretval|tokval|pw99/)
  })

  it('masks SMTP credentials including MULTITABLE_EMAIL_SMTP_* project prefix', () => {
    const out = redactString(
      [
        'SMTP_PASSWORD=mySmtpPw99',
        'SMTP_USER=admin@example.com',
        'MULTITABLE_EMAIL_SMTP_HOST=smtp.example.com',
        'MULTITABLE_EMAIL_SMTP_USER=privateops-user',
        'MULTITABLE_EMAIL_SMTP_PASSWORD=privateOpsPw',
        'MULTITABLE_EMAIL_SMTP_FROM=ops@example.com',
      ].join('\n'),
    )
    expect(out).toMatch(/SMTP_PASSWORD=<redacted>/)
    expect(out).toMatch(/MULTITABLE_EMAIL_SMTP_HOST=<redacted>/)
    expect(out).toMatch(/MULTITABLE_EMAIL_SMTP_USER=<redacted>/)
    expect(out).toMatch(/MULTITABLE_EMAIL_SMTP_PASSWORD=<redacted>/)
    expect(out).toMatch(/MULTITABLE_EMAIL_SMTP_FROM=<redacted>/)
    expect(out).not.toMatch(
      /mySmtpPw99|admin@example\.com|smtp\.example\.com|privateops-user|privateOpsPw|ops@example\.com/,
    )
  })

  it('masks MULTITABLE_EMAIL_SMOKE_TO recipient and subject envelope env names', () => {
    const out = redactString(
      'MULTITABLE_EMAIL_SMOKE_TO=qa@example.com\nMULTITABLE_EMAIL_SMOKE_SUBJECT=Hello',
    )
    expect(out).toMatch(/MULTITABLE_EMAIL_SMOKE_TO=<redacted>/)
    expect(out).toMatch(/MULTITABLE_EMAIL_SMOKE_SUBJECT=<redacted>/)
    expect(out).not.toMatch(/qa@example\.com|Hello/)
  })

  it('masks postgres / mysql URI credentials', () => {
    const a = redactString('postgres://leakyuser:l3akyp4ss@db.example.com:5432/app')
    expect(a).toContain('postgres://<redacted>@')
    expect(a).not.toContain('leakyuser:l3akyp4ss')
    const b = redactString('mysql://root:rootpw@10.0.0.5:3306/data')
    expect(b).toContain('mysql://<redacted>@')
    expect(b).not.toContain('root:rootpw')
  })

  it('masks bare email addresses in free text', () => {
    const out = redactString('Notification delivery failed to qa-private@example.com after 3 retries')
    expect(out).toContain('<email:redacted>')
    expect(out).not.toContain('qa-private@example.com')
  })

  it('masks multiple bare emails in a single string', () => {
    const out = redactString('To: alice@acme.co, cc: bob+filter@sub.example.io')
    expect(out).toContain('<email:redacted>')
    // both emails redacted
    expect(out).not.toContain('alice@acme.co')
    expect(out).not.toContain('bob+filter@sub.example.io')
    const matches = out.match(/<email:redacted>/g)
    expect(matches).toHaveLength(2)
  })

  it('does not falsely match strings that look email-shaped but lack a TLD', () => {
    // Hostname-only is fine to render; only addresses with a TLD-like
    // suffix are redacted.
    const out = redactString('user@localhost')
    expect(out).toBe('user@localhost')
  })

  it('does not falsely match version-like strings', () => {
    const out = redactString('upgrading from 1.2.3 to 1.2.4')
    expect(out).toBe('upgrading from 1.2.3 to 1.2.4')
  })

  it('still routes through SMTP_USER assignment before falling back to bare email', () => {
    // SMTP_USER=admin@example.com must produce SMTP_USER=<redacted>,
    // NOT SMTP_USER=<email:redacted>. Tests SMTP rule wins because it
    // appears earlier in the patterns list.
    const out = redactString('SMTP_USER=admin@example.com\nMULTITABLE_EMAIL_SMTP_USER=ops@example.com')
    expect(out).toMatch(/SMTP_USER=<redacted>/)
    expect(out).toMatch(/MULTITABLE_EMAIL_SMTP_USER=<redacted>/)
    // both emails are gone, neither as <email:redacted> nor raw
    expect(out).not.toContain('admin@example.com')
    expect(out).not.toContain('ops@example.com')
  })
})

describe('redactValue (structured object masking)', () => {
  it('masks SMTP / recipient / webhook keys by name', () => {
    const out = redactValue({
      authToken: 'realtoken1234567890',
      recipient: 'qa@example.com',
      recipients: ['a@b.com', 'c@d.com'],
      smtpHost: 'smtp.example.com',
      smtpPassword: 'realPw99',
      webhookUrl: 'https://hook.example.com',
      keep: 'this stays',
    })
    expect(out).toEqual({
      authToken: '<redacted>',
      recipient: '<redacted>',
      recipients: ['<redacted>', '<redacted>'],
      smtpHost: '<redacted>',
      smtpPassword: '<redacted>',
      webhookUrl: '<redacted>',
      keep: 'this stays',
    })
  })

  it('masks DingTalk receiverUserIds list', () => {
    const out = redactValue({
      receiverUserIds: ['user-001', 'user-002', 'user-003'],
      receiver_user_ids: ['snake-001'],
      payload: { content: 'hello' },
    })
    const o = out as { receiverUserIds: unknown; receiver_user_ids: unknown }
    expect(o.receiverUserIds).toEqual(['<redacted>', '<redacted>', '<redacted>'])
    expect(o.receiver_user_ids).toEqual(['<redacted>'])
  })

  it('masks subject field (may contain customer names / order ids)', () => {
    const out = redactValue({ subject: 'Order 12345 for Acme Corp' })
    expect((out as { subject: unknown }).subject).toBe('<redacted>')
  })

  it('recurses into nested objects', () => {
    const out = redactValue({ payload: { recipient: 'a@b.com', amount: 99 }, ok: true })
    const o = out as { payload: { recipient: unknown; amount: unknown }; ok: unknown }
    expect(o.payload.recipient).toBe('<redacted>')
    expect(o.payload.amount).toBe(99)
    expect(o.ok).toBe(true)
  })

  it('applies string-pattern redaction to free-text fields outside the structured set', () => {
    const out = redactValue({ detail: 'leaked Bearer abcdefghijklmnopqrstuvwx12345' })
    expect((out as { detail: string }).detail).toContain('Bearer <redacted>')
    expect((out as { detail: string }).detail).not.toContain('abcdefghijklmnopqrstuvwx12345')
  })

  it('preserves null and undefined safely', () => {
    expect(redactValue(null)).toBe(null)
    expect(redactValue(undefined)).toBe(undefined)
  })
})

describe('summarizeStepOutput', () => {
  it('JSON-stringifies redacted object output for one-line rendering', () => {
    const out = summarizeStepOutput({ recipient: 'q@e.com', ok: true })
    expect(out).toContain('<redacted>')
    expect(out).toContain('"ok":true')
    expect(out).not.toContain('q@e.com')
  })

  it('truncates oversized output to the UI-friendly cap with `...`', () => {
    const longText = 'A'.repeat(1000)
    const out = summarizeStepOutput({ data: longText })
    expect(out.length).toBeLessThanOrEqual(280)
    expect(out.endsWith('...')).toBe(true)
  })

  it('returns empty string for null / undefined / empty', () => {
    expect(summarizeStepOutput(null)).toBe('')
    expect(summarizeStepOutput(undefined)).toBe('')
    expect(summarizeStepOutput('')).toBe('')
  })

  it('handles non-object output by stringifying through redactString', () => {
    expect(summarizeStepOutput('Bearer abcdefghijklmnopqrstuvwx12345 leaked')).toContain('Bearer <redacted>')
  })

  it('redacts bare email addresses in free-text step output strings', () => {
    const out = summarizeStepOutput('Delivery succeeded for qa-private@example.com')
    expect(out).toContain('<email:redacted>')
    expect(out).not.toContain('qa-private@example.com')
  })

  it('redacts bare email addresses inside object output free-text fields', () => {
    // `note` is NOT in STRUCTURED_FIELDS_TO_REDACT, so it falls through
    // to redactString which must redact the embedded bare email.
    const out = summarizeStepOutput({
      note: 'forwarded to handler-private@example.com for triage',
      ok: true,
    })
    expect(out).toContain('<email:redacted>')
    expect(out).not.toContain('handler-private@example.com')
  })
})

describe('summarizeStepError', () => {
  it('redacts error strings', () => {
    const out = summarizeStepError('SMTP_PASSWORD=leakyPw timed out')
    expect(out).toContain('SMTP_PASSWORD=<redacted>')
    expect(out).not.toContain('leakyPw')
  })

  it('returns empty string for null / undefined / empty', () => {
    expect(summarizeStepError(null)).toBe('')
    expect(summarizeStepError(undefined)).toBe('')
    expect(summarizeStepError('')).toBe('')
  })

  it('passes through clean error messages unchanged', () => {
    const out = summarizeStepError('Action failed: connection refused')
    expect(out).toBe('Action failed: connection refused')
  })

  it('redacts bare email addresses in free-text step error strings', () => {
    const out = summarizeStepError('Failed to deliver to recipient-private@example.com: connection refused')
    expect(out).toContain('<email:redacted>')
    expect(out).not.toContain('recipient-private@example.com')
  })

  it('redacts multiple bare emails in a multi-recipient error', () => {
    const out = summarizeStepError(
      'Failed to deliver to alice-private@example.com and bob-private@sub.example.io: timeout',
    )
    expect(out).not.toContain('alice-private@example.com')
    expect(out).not.toContain('bob-private@sub.example.io')
    const matches = out.match(/<email:redacted>/g)
    expect(matches).toHaveLength(2)
  })
})

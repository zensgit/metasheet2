import { describe, expect, it } from 'vitest'
import {
  redactString,
  redactValue,
  REDACTION_VERSION,
} from '../../src/multitable/automation-log-redact'

describe('automation-log-redact (shared backend redactor)', () => {
  describe('redactString', () => {
    it('scrubs Bearer / JWT / access_token / conn-string, keeps prose', () => {
      expect(redactString('Authorization Bearer abc.def.ghi123456')).toContain('Bearer <redacted>')
      expect(redactString('url ...?access_token=SECRETVALUE123 here')).toContain('access_token=<redacted>')
      const dsn = redactString('dsn postgres://user:secretpw@db.host:5432/app')
      expect(dsn).toContain('postgres://<redacted>@')
      expect(dsn).not.toContain('secretpw')
      const jwt = 'eyJ' + 'a'.repeat(30)
      expect(redactString(`token ${jwt}`)).toContain('<jwt:redacted>')
    })

    it('masks the DingTalk robot webhook URL wholesale', () => {
      const url = 'https://oapi.dingtalk.com/robot/send?access_token=abcDEF123._~-'
      expect(redactString(`delivery to ${url}`)).toContain('<dingtalk-robot-webhook-redacted>')
    })

    it('leaves business prose untouched', () => {
      expect(redactString('Order 42 shipped to warehouse A')).toBe('Order 42 shipped to warehouse A')
    })
  })

  describe('redactValue — the four snapshot channels', () => {
    it('rule_snapshot: scrubs in-string token + Bearer header, keeps business fields', () => {
      const ruleSnapshot = {
        id: 'rule_1',
        name: 'Notify on submit',
        actions: [
          {
            type: 'send_webhook',
            config: {
              url: 'https://hooks.example.com/x?access_token=SUPERSECRETTOKEN',
              headers: { authorization: 'Bearer zzz.yyy.xxx00001' },
            },
          },
        ],
      }
      const out = redactValue(ruleSnapshot) as typeof ruleSnapshot
      expect(out.id).toBe('rule_1')
      expect(out.name).toBe('Notify on submit')
      expect(out.actions[0].type).toBe('send_webhook')
      const serialized = JSON.stringify(out)
      expect(serialized).toContain('Bearer <redacted>')
      expect(serialized).toContain('access_token=<redacted>')
      expect(serialized).not.toContain('SUPERSECRETTOKEN')
      expect(serialized).not.toContain('zzz.yyy.xxx00001')
    })

    it('masks structured-field keys wholesale (password / accessToken / webhookUrl / to)', () => {
      const out = redactValue({
        password: 'hunter2',
        accessToken: 'tok_123',
        webhookUrl: 'https://x?access_token=zzz',
        to: ['a@example.com', 'b@example.com'],
        keep: 'visible',
      }) as Record<string, unknown>
      expect(out.password).toBe('<redacted>')
      expect(out.accessToken).toBe('<redacted>')
      expect(out.webhookUrl).toBe('<redacted>')
      expect(out.to).toEqual(['<redacted>', '<redacted>'])
      expect(out.keep).toBe('visible')
    })

    it('steps: scrubs step.output.responseBody and step.error, keeps actionType/status', () => {
      const steps = [
        {
          actionType: 'send_webhook',
          status: 'failed',
          output: { responseBody: 'returned access_token=LEAKED999' },
          error: 'connect postgres://u:secretpw@h/db failed',
        },
      ]
      const out = redactValue(steps) as typeof steps
      expect(out[0].actionType).toBe('send_webhook')
      expect(out[0].status).toBe('failed')
      const serialized = JSON.stringify(out)
      expect(serialized).not.toContain('LEAKED999')
      expect(serialized).not.toContain('secretpw')
      expect(serialized).toContain('access_token=<redacted>')
      expect(serialized).toContain('postgres://<redacted>@')
    })

    it('trigger_event with only business data is preserved verbatim', () => {
      const evt = { recordId: 'rec_1', data: { name: 'Alice', amount: 100 } }
      expect(redactValue(evt)).toEqual(evt)
    })

    it('passes null / undefined through untouched', () => {
      expect(redactValue(null)).toBeNull()
      expect(redactValue(undefined)).toBeUndefined()
    })
  })

  it('exposes a redaction version tag', () => {
    expect(REDACTION_VERSION).toBe(1)
  })
})

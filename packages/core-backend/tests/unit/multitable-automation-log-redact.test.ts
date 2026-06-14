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

    it('scrubs database URI credentials containing raw @ characters before persistence', () => {
      const postgres = redactString('dsn postgres://u@ser:p@ss@db.example.com:5432/app')
      expect(postgres).toContain('postgres://<redacted>@db.example.com:5432/app')
      expect(postgres).not.toContain('u@ser')
      expect(postgres).not.toContain('p@ss')
      expect(postgres).not.toContain('ss@db')

      const mysql = redactString('mysql://root:r@w@10.0.0.5:3306/data')
      expect(mysql).toBe('mysql://<redacted>@10.0.0.5:3306/data')
      expect(mysql).not.toContain('r@w')
      expect(mysql).not.toContain('w@10')
    })

    it('scrubs malformed database URI credentials containing reserved delimiters before persistence', () => {
      for (const secret of ['pa#ss', 'pa?ss', 'pa/ss', 'pa)ss', "pa'ss"]) {
        const out = redactString(`postgres://user:${secret}@db.example.com:5432/app`)
        expect(out).toBe('postgres://<redacted>@db.example.com:5432/app')
        expect(out).not.toContain(secret)
      }

      const mysql = redactString('mysql://root:r)w@10.0.0.5:3306/data')
      expect(mysql).toBe('mysql://<redacted>@10.0.0.5:3306/data')
      expect(mysql).not.toContain('r)w')

      const internalHost = redactString('postgres://user:pa/ss@db_service:5432/app')
      expect(internalHost).toBe('postgres://<redacted>@db_service:5432/app')
      expect(internalHost).not.toContain('pa/ss')
    })

    it('scrubs malformed database URI credentials mixing raw @ with reserved delimiters', () => {
      const slash = redactString('postgres://user:pa@ss/word@db.example.com:5432/app')
      expect(slash).toBe('postgres://<redacted>@db.example.com:5432/app')
      expect(slash).not.toContain('pa@ss')
      expect(slash).not.toContain('word@db')

      const query = redactString('postgres://user:pa@ss?word@db.example.com:5432/app')
      expect(query).toBe('postgres://<redacted>@db.example.com:5432/app')
      expect(query).not.toContain('pa@ss')
      expect(query).not.toContain('word@db')

      const hash = redactString('postgres://user:pa@ss#word@db.example.com:5432/app')
      expect(hash).toBe('postgres://<redacted>@db.example.com:5432/app')
      expect(hash).not.toContain('pa@ss')
      expect(hash).not.toContain('word@db')

      const mysql = redactString('mysql://root:r@w/ord@10.0.0.5:3306/data')
      expect(mysql).toBe('mysql://<redacted>@10.0.0.5:3306/data')
      expect(mysql).not.toContain('r@w')
      expect(mysql).not.toContain('ord@10')
    })

    it('preserves the database host when malformed URI query text contains @', () => {
      const out = redactString('postgres://user:pa/ss@db.example.com:5432/app?notify=a@b')
      expect(out).toBe('postgres://<redacted>@db.example.com:5432/app?notify=a@b')
      expect(out).not.toContain('pa/ss')
    })

    it('scrubs adjacent and nested database URLs before persistence', () => {
      const adjacent = redactString('postgres://u:p@db/app,mysql://root:rootpw@other/db')
      expect(adjacent).toBe('postgres://<redacted>@db/app,mysql://<redacted>@other/db')
      expect(adjacent).not.toContain('u:p')
      expect(adjacent).not.toContain('root:rootpw')

      const nested = redactString('postgres://u:p@db/app?next=mysql://root:rootpw@other/db')
      expect(nested).toBe('postgres://<redacted>@db/app?next=mysql://<redacted>@other/db')
      expect(nested).not.toContain('u:p')
      expect(nested).not.toContain('root:rootpw')

      const nestedOnly = redactString('postgres://db/app?next=mysql://root:rootpw@other/db')
      expect(nestedOnly).toBe('postgres://db/app?next=mysql://<redacted>@other/db')
      expect(nestedOnly).not.toContain('root:rootpw')
    })

    it('does not scrub database URLs without userinfo', () => {
      expect(redactString('postgres://db.example.com:5432/app')).toBe('postgres://db.example.com:5432/app')
      expect(redactString('mysql://10.0.0.5:3306/data')).toBe('mysql://10.0.0.5:3306/data')
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
    it('rule_snapshot: masks auth header wholesale + scrubs in-string token, keeps business fields', () => {
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
      // auth header value masked wholesale (structured key, case-insensitive)
      expect(out.actions[0].config.headers.authorization).toBe('<redacted>')
      const serialized = JSON.stringify(out)
      expect(serialized).toContain('access_token=<redacted>')
      expect(serialized).not.toContain('SUPERSECRETTOKEN')
      expect(serialized).not.toContain('zzz.yyy.xxx00001')
    })

    it('masks secret structured keys wholesale (case/separator-insensitive)', () => {
      const out = redactValue({
        password: 'hunter2',
        accessToken: 'tok_123',
        access_token: 'tok_456',
        webhookUrl: 'https://x?access_token=zzz',
        keep: 'visible',
      }) as Record<string, unknown>
      expect(out.password).toBe('<redacted>')
      expect(out.accessToken).toBe('<redacted>')
      expect(out.access_token).toBe('<redacted>')
      expect(out.webhookUrl).toBe('<redacted>')
      expect(out.keep).toBe('visible')
    })

    it('masks arbitrary auth headers case/separator-insensitively (the Blocking gap)', () => {
      const out = redactValue({
        headers: {
          Authorization: 'Basic dXNlcjpzZWNyZXQ=',
          'X-API-Key': 'abc123key',
          'X-Auth-Token': 'xyz789tok',
          Cookie: 'sid=deadbeef; csrf=tok',
          'Set-Cookie': 'sid=deadbeef',
          'Content-Type': 'application/json',
        },
      }) as { headers: Record<string, unknown> }
      expect(out.headers.Authorization).toBe('<redacted>')
      expect(out.headers['X-API-Key']).toBe('<redacted>')
      expect(out.headers['X-Auth-Token']).toBe('<redacted>')
      expect(out.headers.Cookie).toBe('<redacted>')
      expect(out.headers['Set-Cookie']).toBe('<redacted>')
      expect(out.headers['Content-Type']).toBe('application/json') // non-secret header preserved
      const serialized = JSON.stringify(out)
      expect(serialized).not.toContain('dXNlcjpzZWNyZXQ=')
      expect(serialized).not.toContain('abc123key')
      expect(serialized).not.toContain('deadbeef')
    })

    it('preserves contact/PII keys (to / recipient) — PII masking deferred to the retry gate', () => {
      const out = redactValue({
        to: ['a@example.com', 'b@example.com'],
        recipient: 'ops@example.com',
        name: 'Alice',
      }) as Record<string, unknown>
      expect(out.to).toEqual(['a@example.com', 'b@example.com'])
      expect(out.recipient).toBe('ops@example.com')
      expect(out.name).toBe('Alice')
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

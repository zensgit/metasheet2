import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REDACTION_VERSION,
  redactString,
  redactValue,
} from './multitable-phase3-release-gate-redact.mjs'

test('REDACTION_VERSION is exported', () => {
  assert.equal(typeof REDACTION_VERSION, 'number')
})

test('redactString masks Bearer tokens', () => {
  const out = redactString('Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890')
  assert.equal(out, 'Authorization: Bearer <redacted>')
})

test('redactString masks JWT', () => {
  const jwt =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
  assert.match(redactString(jwt), /<jwt:redacted>/)
})

test('redactString masks DingTalk SEC robot secret', () => {
  const out = redactString('robot=SECabcdef1234567890')
  assert.match(out, /SEC<redacted>/)
  assert.doesNotMatch(out, /SECabcdef1234567890/)
})

test('redactString masks sk- style API key', () => {
  const out = redactString('OPENAI=sk-abcdefghijklmnop1234567890qrstuv')
  assert.match(out, /sk-<redacted>/)
})

test('redactString masks access_token in URL', () => {
  const out = redactString(
    'https://api.example.com/?access_token=secret123abc&foo=bar',
  )
  assert.match(out, /access_token=<redacted>/)
  assert.doesNotMatch(out, /secret123abc/)
})

test('redactString masks env-style API_KEY assignment', () => {
  const out = redactString('OPENAI_API_KEY=plain-value-not-sk-prefixed-9876543210')
  assert.match(out, /OPENAI_API_KEY=<redacted>/)
  assert.doesNotMatch(out, /plain-value-not-sk-prefixed-9876543210/)
})

test('redactString masks env-style CLIENT_SECRET / TOKEN / SECRET / PASSWORD', () => {
  const cases = [
    'DINGTALK_CLIENT_SECRET=clientsecretvalue',
    'AUTH_TOKEN=tokenvalue123',
    'STATE_SECRET=stateseed999',
    'DB_PASSWORD=p4ss_w0rd!!',
  ]
  for (const input of cases) {
    const out = redactString(input)
    assert.match(out, /=<redacted>/, `failed for: ${input}`)
    assert.doesNotMatch(out, /clientsecretvalue|tokenvalue123|stateseed999|p4ss_w0rd!!/, `leak: ${input}`)
  }
})

test('redactString masks SMTP credentials in env format', () => {
  const out = redactString(
    'SMTP_PASSWORD=mySmtpPw99\nSMTP_USER=admin@example.com\nSMTP_HOST=smtp.example.com\nSMTP_PORT=587',
  )
  assert.match(out, /SMTP_PASSWORD=<redacted>/)
  assert.match(out, /SMTP_USER=<redacted>/)
  assert.match(out, /SMTP_HOST=<redacted>/)
  assert.match(out, /SMTP_PORT=<redacted>/)
  assert.doesNotMatch(out, /mySmtpPw99|admin@example\.com|smtp\.example\.com/)
})

test('redactString masks MULTITABLE_EMAIL_SMTP_* project-prefixed env names', () => {
  const out = redactString(
    [
      'MULTITABLE_EMAIL_SMTP_HOST=smtp.example.com',
      'MULTITABLE_EMAIL_SMTP_USER=smtp-user',
      'MULTITABLE_EMAIL_SMTP_PASSWORD=smtp-password-secret',
      'MULTITABLE_EMAIL_SMTP_FROM=ops-private@example.com',
      'MULTITABLE_EMAIL_SMTP_PORT=587',
    ].join('\n'),
  )
  assert.match(out, /MULTITABLE_EMAIL_SMTP_HOST=<redacted>/)
  assert.match(out, /MULTITABLE_EMAIL_SMTP_USER=<redacted>/)
  assert.match(out, /MULTITABLE_EMAIL_SMTP_PASSWORD=<redacted>/)
  assert.match(out, /MULTITABLE_EMAIL_SMTP_FROM=<redacted>/)
  assert.match(out, /MULTITABLE_EMAIL_SMTP_PORT=<redacted>/)
  assert.doesNotMatch(
    out,
    /smtp\.example\.com|smtp-user|smtp-password-secret|ops-private@example\.com/,
  )
})

test('redactString masks MULTITABLE_EMAIL_SMOKE_TO recipient env name', () => {
  const out = redactString(
    'MULTITABLE_EMAIL_SMOKE_TO=recipient-private@example.com\nMULTITABLE_EMAIL_SMOKE_SUBJECT=hello world',
  )
  assert.match(out, /MULTITABLE_EMAIL_SMOKE_TO=<redacted>/)
  assert.match(out, /MULTITABLE_EMAIL_SMOKE_SUBJECT=<redacted>/)
  assert.doesNotMatch(out, /recipient-private@example\.com|hello world/)
})

test('redactString masks DingTalk robot webhook URL', () => {
  const out = redactString(
    'webhook=https://oapi.dingtalk.com/robot/send?access_token=abc123xyz456',
  )
  assert.match(out, /access_token=<redacted>/)
  assert.doesNotMatch(out, /abc123xyz456/)
})

test('redactString masks postgres URI credentials', () => {
  const out = redactString('postgres://leakyuser:l3akyp4ss@db.example.com:5432/app')
  assert.match(out, /postgres:\/\/<redacted>@/)
  assert.doesNotMatch(out, /leakyuser:l3akyp4ss/)
})

test('redactString masks mysql URI credentials', () => {
  const out = redactString('mysql://root:rootpw@10.0.0.5:3306/data')
  assert.match(out, /mysql:\/\/<redacted>@/)
  assert.doesNotMatch(out, /root:rootpw/)
})

test('redactString masks database URI credentials containing raw @ characters', () => {
  const postgres = redactString('postgres://u@ser:p@ss@db.example.com:5432/app')
  assert.equal(postgres, 'postgres://<redacted>@db.example.com:5432/app')
  assert.doesNotMatch(postgres, /u@ser|p@ss|ss@db/)

  const mysql = redactString('mysql://root:r@w@10.0.0.5:3306/data')
  assert.equal(mysql, 'mysql://<redacted>@10.0.0.5:3306/data')
  assert.doesNotMatch(mysql, /r@w|w@10/)
})

test('redactString masks malformed database URI credentials containing reserved delimiters', () => {
  for (const secret of ['pa#ss', 'pa?ss', 'pa/ss', 'pa)ss', "pa'ss"]) {
    const out = redactString(`postgres://user:${secret}@db.example.com:5432/app`)
    assert.equal(out, 'postgres://<redacted>@db.example.com:5432/app')
    assert.doesNotMatch(out, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }

  const mysql = redactString('mysql://root:r)w@10.0.0.5:3306/data')
  assert.equal(mysql, 'mysql://<redacted>@10.0.0.5:3306/data')
  assert.doesNotMatch(mysql, /r\)w/)

  const internalHost = redactString('postgres://user:pa/ss@db_service:5432/app')
  assert.equal(internalHost, 'postgres://<redacted>@db_service:5432/app')
  assert.doesNotMatch(internalHost, /pa\/ss/)
})

test('redactString masks malformed database URI credentials mixing raw @ with reserved delimiters', () => {
  const slash = redactString('postgres://user:pa@ss/word@db.example.com:5432/app')
  assert.equal(slash, 'postgres://<redacted>@db.example.com:5432/app')
  assert.doesNotMatch(slash, /pa@ss|word@db/)

  const query = redactString('postgres://user:pa@ss?word@db.example.com:5432/app')
  assert.equal(query, 'postgres://<redacted>@db.example.com:5432/app')
  assert.doesNotMatch(query, /pa@ss|word@db/)

  const hash = redactString('postgres://user:pa@ss#word@db.example.com:5432/app')
  assert.equal(hash, 'postgres://<redacted>@db.example.com:5432/app')
  assert.doesNotMatch(hash, /pa@ss|word@db/)

  const mysql = redactString('mysql://root:r@w/ord@10.0.0.5:3306/data')
  assert.equal(mysql, 'mysql://<redacted>@10.0.0.5:3306/data')
  assert.doesNotMatch(mysql, /r@w|ord@10/)
})

test('redactString preserves the database host when malformed URI query text contains @', () => {
  const out = redactString('postgres://user:pa/ss@db.example.com:5432/app?notify=a@b')
  assert.equal(out, 'postgres://<redacted>@db.example.com:5432/app?notify=a@b')
  assert.doesNotMatch(out, /pa\/ss/)
})

test('redactString masks adjacent and nested database URLs', () => {
  const adjacent = redactString('postgres://u:p@db/app,mysql://root:rootpw@other/db')
  assert.equal(adjacent, 'postgres://<redacted>@db/app,mysql://<redacted>@other/db')
  assert.doesNotMatch(adjacent, /u:p|root:rootpw/)

  const nested = redactString('postgres://u:p@db/app?next=mysql://root:rootpw@other/db')
  assert.equal(nested, 'postgres://<redacted>@db/app?next=mysql://<redacted>@other/db')
  assert.doesNotMatch(nested, /u:p|root:rootpw/)

  const nestedOnly = redactString('postgres://db/app?next=mysql://root:rootpw@other/db')
  assert.equal(nestedOnly, 'postgres://db/app?next=mysql://<redacted>@other/db')
  assert.doesNotMatch(nestedOnly, /root:rootpw/)
})

test('redactString does not mask database URLs without userinfo', () => {
  assert.equal(redactString('postgres://db.example.com:5432/app'), 'postgres://db.example.com:5432/app')
  assert.equal(redactString('mysql://10.0.0.5:3306/data'), 'mysql://10.0.0.5:3306/data')
})

test('redactValue masks structured fields by name', () => {
  const obj = {
    authToken: 'realtokenvalue1234567890',
    recipient: 'admin@example.com',
    smtpHost: 'smtp.example.com',
    keep: 'this stays',
  }
  const out = redactValue(obj)
  assert.equal(out.authToken, '<redacted>')
  assert.equal(out.recipient, '<redacted>')
  assert.equal(out.smtpHost, '<redacted>')
  assert.equal(out.keep, 'this stays')
})

test('redactValue masks recipient arrays', () => {
  const obj = { recipients: ['a@b.com', 'c@d.com'] }
  const out = redactValue(obj)
  assert.deepEqual(out.recipients, ['<redacted>', '<redacted>'])
})

test('redactValue recurses into nested objects, masking nested structured fields by name', () => {
  const obj = { smtp: { password: 'secret', port: 587 }, ok: true }
  const out = redactValue(obj)
  assert.equal(out.smtp.password, '<redacted>')
  assert.equal(out.smtp.port, 587)
  assert.equal(out.ok, true)
})

test('redactValue does not leak via string fields that pass through redactString', () => {
  const obj = { detail: 'leaked Bearer abcdefghijklmnopqrstuvwx12345' }
  const out = redactValue(obj)
  assert.match(out.detail, /Bearer <redacted>/)
  assert.doesNotMatch(out.detail, /abcdefghijklmnopqrstuvwx12345/)
})

test('redactValue preserves null and undefined safely', () => {
  assert.equal(redactValue(null), null)
  assert.equal(redactValue(undefined), undefined)
})

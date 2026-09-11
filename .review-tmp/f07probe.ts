import { collectSecretConfigValues, secretKeyValueTextPattern } from '../packages/core-backend/src/data-adapters/data-source-secret-keys.ts'

const authRule = /(\bauthorization\b\s*[=:]\s*)(?:bearer|basic|digest|negotiate)?\s*[^\s;,)]+/gi

function newRedact(config: any, message: string): string {
  let out = message
  for (const s of collectSecretConfigValues([config.credentials, config.connection])) out = out.split(s).join('***')
  out = out.replace(secretKeyValueTextPattern(), '$1***')
  return out.replace(authRule, '$1***')
}

function oldRedact(config: any, message: string): string {
  let out = message
  const creds = config.credentials ?? {}
  const conn = config.connection ?? {}
  const vals = [creds.password, creds.token, creds.apiKey, creds.secret, conn.password]
    .filter((v: any): v is string => typeof v === 'string' && v.length > 0)
  for (const s of vals) out = out.split(s).join('***')
  out = out.replace(/(\b(?:password|pwd|pass|token|api[_-]?key|secret)\b\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s;,)]+)/gi, '$1***')
  return out.replace(authRule, '$1***')
}

const cases: Array<[string, any, string]> = [
  ['F07 claimed case', { credentials: { secret: 'xy', password: 'xyz' }, connection: {} }, 'auth failed, tried xyz'],
  ['F07 failure_scenario', { credentials: { apiKey: 'k1', bearerToken: 'k1-prod-9f2a' }, connection: {} }, 'HTTP 401 for Authorization header; tried k1-prod-9f2a'],
  ['old-order also shadows (apiKey prefix of secret)', { credentials: { apiKey: 'ab', secret: 'abcdef' }, connection: {} }, 'login failed with abcdef'],
  ['old-order also shadows (password prefix of token)', { credentials: { password: 'pw', token: 'pw-long-tail' }, connection: {} }, 'rejected pw-long-tail'],
  ['plain password', { credentials: { password: 'p@ss w0rd' }, connection: {} }, 'auth failed for p@ss w0rd'],
]

console.log('collect(F07 case) =', JSON.stringify(collectSecretConfigValues([{ secret: 'xy', password: 'xyz' }, {}])))
for (const [name, cfg, msg] of cases) {
  console.log('\n#', name)
  console.log('  in  :', msg)
  console.log('  old :', oldRedact(cfg, msg))
  console.log('  new :', newRedact(cfg, msg))
  console.log('  regression?', oldRedact(cfg, msg) !== newRedact(cfg, msg))
}

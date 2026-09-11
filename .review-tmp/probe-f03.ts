const m = await import('../packages/core-backend/src/data-adapters/data-source-secret-keys.ts')
const isSecretConfigKey = m.isSecretConfigKey as (k: string) => boolean

const bypassClaims = [
  'dbpass', 'userpass', 'pass1', 'db_pw', 'pw', 'pswd', 'passcode', 'p4ssword',
  'pässword', 'pаssword', 'ｐａｓｓｗｏｒｄ',
  'auth', 'basicAuth', 'cookie', 'sslKey', 'clientKey', 'tlsKey', 'bearer',
]
const hitClaims = [
  'DBPass', 'pass_1', 'pass​word', 'clientSecret', 'bearerToken', 'privateKey',
  'x-api-key', 'hasCredentials', 'maxTokens', 'tokenBucket', 'secretary', 'xpasswordx',
]

console.log('--- claimed FALSE (bypass) ---')
for (const k of bypassClaims) console.log(JSON.stringify(k).padEnd(30), isSecretConfigKey(k))
console.log('--- claimed TRUE ---')
for (const k of hitClaims) console.log(JSON.stringify(k).padEnd(30), isSecretConfigKey(k))

console.log('--- extra ---')
const extra = ['password', 'Password', 'PASSWORD', 'db_password', 'dbPassword', 'passwd',
  'pwd', 'passphrase', 'pass', 'db_pass', 'passthrough', 'bypass', 'compass', 'passport',
  'apiKey', 'api_key', 'accessKey', 'privateKey', 'authorization', 'Authorization',
  'maxTokens', 'tokenBucket', 'secretary', 'strictOffsetOrdering', 'host', 'port',
  'database', 'encrypt', 'trustServerCertificate', 'user', 'username', 'schema',
  'dbPass', 'userPass', 'PWD', 'Pwd', 'db-pw', 'sslPassword', 'tokenUrl', 'maxToken']
for (const k of extra) console.log(k.padEnd(30), isSecretConfigKey(k))

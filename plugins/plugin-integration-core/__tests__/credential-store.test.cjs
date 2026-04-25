'use strict'

// ---------------------------------------------------------------------------
// credential-store.cjs — committed tests
//
// Verifies:
//   1. Dev fallback path when INTEGRATION_ENCRYPTION_KEY is absent and
//      NODE_ENV != production.
//   2. Production refuses to start without the env key.
//   3. Env key (64-hex-char, 32 bytes) works in production mode.
//   4. Encrypt → decrypt round-trip for a variety of payloads.
//   5. Tamper detection: flipping ciphertext bytes throws.
//   6. Malformed ciphertext is rejected with a clear format error.
//   7. Fingerprint is a stable short hex string.
//   8. Host-backed mode writes enc: values through services.security.
//   9. Host-backed mode still reads legacy v1: ciphertext.
//
// Run: node __tests__/credential-store.test.cjs
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const path = require('node:path')
const { createCredentialStore, __internals } = require(path.join(__dirname, '..', 'lib', 'credential-store.cjs'))

async function runInScope(envPatch, fn) {
  const saved = {}
  for (const k of Object.keys(envPatch)) {
    saved[k] = process.env[k]
    if (envPatch[k] === null || envPatch[k] === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = envPatch[k]
    }
  }
  try {
    return await fn()
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

function createMockSecurityService() {
  return {
    calls: [],
    async encrypt(plaintext) {
      this.calls.push(['encrypt', plaintext])
      return `enc:${Buffer.from(plaintext, 'utf8').toString('base64')}`
    },
    async decrypt(ciphertext) {
      this.calls.push(['decrypt', ciphertext])
      if (!ciphertext.startsWith('enc:')) {
        throw new Error('mock security decrypt expects enc: ciphertext')
      }
      return Buffer.from(ciphertext.slice(4), 'base64').toString('utf8')
    },
    async hash(value) {
      this.calls.push(['hash', value])
      return crypto.createHash('sha256').update(value).digest('hex')
    },
  }
}

async function main() {
  // --- 1. Dev fallback -------------------------------------------------
  await runInScope({ NODE_ENV: 'development', INTEGRATION_ENCRYPTION_KEY: null }, async () => {
    const warnLogs = []
    const store = createCredentialStore({ logger: { warn: (m) => warnLogs.push(m) } })
    assert.equal(store.source, 'dev-fallback', 'dev fallback source')
    assert.equal(store.format, 'v1', 'dev fallback writes v1')
    assert.ok(warnLogs.length === 1 && /INTEGRATION_ENCRYPTION_KEY/.test(warnLogs[0]), 'warns about missing key')
  })

  // --- 2. Production refuses without key -------------------------------
  await runInScope({ NODE_ENV: 'production', INTEGRATION_ENCRYPTION_KEY: null }, async () => {
    let err = null
    try { createCredentialStore() } catch (e) { err = e }
    assert.ok(err, 'prod throws without key')
    assert.match(err.message, /INTEGRATION_ENCRYPTION_KEY/, 'error message names the env var')
  })

  // --- 3-5. Production with key — roundtrip + tamper + format ----------
  await runInScope(
    { NODE_ENV: 'production', INTEGRATION_ENCRYPTION_KEY: 'a'.repeat(64) },
    async () => {
      const store = createCredentialStore()
      assert.equal(store.source, 'env', 'env source')
      assert.equal(store.format, 'v1', 'env-backed fallback writes v1')

      const payloads = [
        'simple',
        'K3WISE_password_with_special!@#$%_chars',
        '中文密码 with 空格',
        '{"type":"json","nested":{"x":1}}',
        '',  // empty string
      ]
      for (const p of payloads) {
        const ct = await store.encrypt(p)
        assert.ok(ct.startsWith('v1:'), `ciphertext for "${p.slice(0, 20)}" is v1-tagged`)
        assert.notEqual(ct, p, 'ciphertext differs from plaintext')
        assert.equal(await store.decrypt(ct), p, `roundtrip for "${p.slice(0, 20)}"`)
      }

      // Tamper: flip last 2 chars of the data segment — MUST throw
      const ct = await store.encrypt('hello')
      const parts = ct.split(':')
      const d = parts[3]
      const tampered = [parts[0], parts[1], parts[2], d.slice(0, -2) + (d.slice(-2) === 'AA' ? 'BB' : 'AA')].join(':')
      let tErr = null
      try { await store.decrypt(tampered) } catch (e) { tErr = e }
      assert.ok(tErr, 'tamper must throw')

      // Malformed ciphertext — format error
      let fErr = null
      try { await store.decrypt('not-a-v1-ciphertext') } catch (e) { fErr = e }
      assert.ok(fErr && /invalid ciphertext format/.test(fErr.message), 'format rejection')

      // Fingerprint: stable and short
      const fp1 = await store.fingerprint(ct)
      const fp2 = await store.fingerprint(ct)
      assert.equal(fp1, fp2, 'fingerprint stable')
      assert.match(fp1, /^[0-9a-f]{16}$/, 'fingerprint shape')
    },
  )

  // --- 6. Key decode accepts hex and base64 ----------------------------
  const hexKey = 'a'.repeat(64)
  assert.ok(__internals.decodeKey(hexKey), 'hex key decoded')
  const rawBuf = Buffer.alloc(32, 7)
  const b64Key = rawBuf.toString('base64')
  const decoded = __internals.decodeKey(b64Key)
  assert.ok(decoded && decoded.equals(rawBuf), 'base64 key decoded to original bytes')

  // --- 7. Wrong-length keys rejected -----------------------------------
  assert.equal(__internals.decodeKey('short'), null, 'short key rejected')
  assert.equal(__internals.decodeKey('a'.repeat(10)), null, 'wrong hex length rejected')
  assert.equal(__internals.decodeKey(null), null, 'null rejected')
  assert.equal(__internals.decodeKey(''), null, 'empty rejected')

  // --- 8. Host-backed mode writes enc: and delegates enc: reads ----------
  await runInScope({ NODE_ENV: 'production', INTEGRATION_ENCRYPTION_KEY: null }, async () => {
    const security = createMockSecurityService()
    const store = createCredentialStore({ security })

    assert.equal(store.source, 'host-security', 'host security source')
    assert.equal(store.format, 'enc', 'host security writes enc')

    const ct = await store.encrypt('host-secret')
    assert.equal(ct, `enc:${Buffer.from('host-secret', 'utf8').toString('base64')}`, 'host encrypt delegated')
    assert.equal(await store.decrypt(ct), 'host-secret', 'host decrypt delegated')

    const fp1 = await store.fingerprint(ct)
    const fp2 = await store.fingerprint(ct)
    assert.equal(fp1, fp2, 'host fingerprint stable')
    assert.match(fp1, /^[0-9a-f]{16}$/, 'host fingerprint shape')
    assert.deepEqual(
      security.calls.map(([name]) => name),
      ['encrypt', 'decrypt', 'hash', 'hash'],
      'host security calls recorded',
    )
  })

  // --- 9. Host-backed mode still reads legacy v1 payloads ----------------
  await runInScope({ NODE_ENV: 'production', INTEGRATION_ENCRYPTION_KEY: 'b'.repeat(64) }, async () => {
    const legacyStore = createCredentialStore()
    const legacyCiphertext = await legacyStore.encrypt('legacy-secret')
    assert.ok(__internals.isLegacyCiphertext(legacyCiphertext), 'legacy ciphertext detected')

    const security = createMockSecurityService()
    const hostStore = createCredentialStore({ security })
    assert.equal(await hostStore.decrypt(legacyCiphertext), 'legacy-secret', 'host store reads legacy v1')
    assert.equal(security.calls.length, 0, 'legacy decrypt does not call host decrypt')
  })

  // --- 10. Bad security service shape rejected ---------------------------
  let badSecurityErr = null
  try { createCredentialStore({ security: { encrypt: async () => 'enc:x' } }) } catch (e) { badSecurityErr = e }
  assert.ok(badSecurityErr, 'bad security service shape rejected')
  assert.match(badSecurityErr.message, /security service/, 'bad security service error message')

  console.log('✓ credential-store: 10 scenarios passed')
}

main().catch((err) => {
  console.error('✗ credential-store FAILED')
  console.error(err)
  process.exit(1)
})

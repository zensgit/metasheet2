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
//
// Run: node __tests__/credential-store.test.cjs
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict')
const path = require('node:path')
const { createCredentialStore, __internals } = require(path.join(__dirname, '..', 'lib', 'credential-store.cjs'))

function runInScope(envPatch, fn) {
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
    return fn()
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

async function main() {
  // --- 1. Dev fallback -------------------------------------------------
  runInScope({ NODE_ENV: 'development', INTEGRATION_ENCRYPTION_KEY: null }, () => {
    const warnLogs = []
    const store = createCredentialStore({ logger: { warn: (m) => warnLogs.push(m) } })
    assert.equal(store.source, 'dev-fallback', 'dev fallback source')
    assert.ok(warnLogs.length === 1 && /INTEGRATION_ENCRYPTION_KEY/.test(warnLogs[0]), 'warns about missing key')
  })

  // --- 2. Production refuses without key -------------------------------
  runInScope({ NODE_ENV: 'production', INTEGRATION_ENCRYPTION_KEY: null }, () => {
    let err = null
    try { createCredentialStore() } catch (e) { err = e }
    assert.ok(err, 'prod throws without key')
    assert.match(err.message, /INTEGRATION_ENCRYPTION_KEY/, 'error message names the env var')
  })

  // --- 3-5. Production with key — roundtrip + tamper + format ----------
  runInScope(
    { NODE_ENV: 'production', INTEGRATION_ENCRYPTION_KEY: 'a'.repeat(64) },
    () => {
      const store = createCredentialStore()
      assert.equal(store.source, 'env', 'env source')

      const payloads = [
        'simple',
        'K3WISE_password_with_special!@#$%_chars',
        '中文密码 with 空格',
        '{"type":"json","nested":{"x":1}}',
        '',  // empty string
      ]
      for (const p of payloads) {
        const ct = store.encrypt(p)
        assert.ok(ct.startsWith('v1:'), `ciphertext for "${p.slice(0, 20)}" is v1-tagged`)
        assert.notEqual(ct, p, 'ciphertext differs from plaintext')
        assert.equal(store.decrypt(ct), p, `roundtrip for "${p.slice(0, 20)}"`)
      }

      // Tamper: flip last 2 chars of the data segment — MUST throw
      const ct = store.encrypt('hello')
      const parts = ct.split(':')
      const d = parts[3]
      const tampered = [parts[0], parts[1], parts[2], d.slice(0, -2) + (d.slice(-2) === 'AA' ? 'BB' : 'AA')].join(':')
      let tErr = null
      try { store.decrypt(tampered) } catch (e) { tErr = e }
      assert.ok(tErr, 'tamper must throw')

      // Malformed ciphertext — format error
      let fErr = null
      try { store.decrypt('not-a-v1-ciphertext') } catch (e) { fErr = e }
      assert.ok(fErr && /invalid ciphertext format/.test(fErr.message), 'format rejection')

      // Fingerprint: stable and short
      const fp1 = store.fingerprint(ct)
      const fp2 = store.fingerprint(ct)
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

  console.log('✓ credential-store: 7 scenarios passed')
}

main().catch((err) => {
  console.error('✗ credential-store FAILED')
  console.error(err)
  process.exit(1)
})

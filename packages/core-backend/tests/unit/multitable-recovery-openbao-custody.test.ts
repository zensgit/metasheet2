import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createRecoveryOpenBaoCustody } from '../../src/multitable/recovery-openbao-custody'
import { RECOVERY_ARCHIVE_DEK_FINGERPRINT_DOMAIN } from '../../src/multitable/recovery-archive-crypto'
import { recoveryResourceTestTls } from '../utils/recovery-resource-tls'

const token = 'synthetic-openbao-token-26'
const keyId = 'synthetic-staging-key'
const wrappingKeys = [randomBytes(32), randomBytes(32)]
const fingerprintKey = randomBytes(32), manifestKey = randomBytes(32)
let server: Server, tls: Awaited<ReturnType<typeof recoveryResourceTestTls>>, unrelatedTls: Awaited<ReturnType<typeof recoveryResourceTestTls>>, url: string
let wrappingVersion = 1, depth = 0, calls = 0
let fault: 'none' | 'wrong-dek' | 'wrong-version' | 'string-verdict' | 'redirect' | 'oversize' | 'timeout' | 'error' = 'none'

beforeAll(async () => {
  tls = await recoveryResourceTestTls()
  unrelatedTls = await recoveryResourceTestTls()
  server = createServer(tls, async (req, res) => {
    calls++
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const input = JSON.parse(Buffer.concat(chunks).toString())
    if (req.headers['x-vault-token'] !== token) { res.writeHead(403).end(); return }
    if (fault === 'redirect') { res.writeHead(307, { location: 'https://untrusted.invalid/' }).end(); return }
    if (fault === 'timeout') return
    if (fault === 'oversize') { res.writeHead(200, { 'content-type': 'application/json' }).end('x'.repeat(70000)); return }
    if (fault === 'error') { res.writeHead(500).end('synthetic-secret-host-token'); return }
    let data: object
    try {
      if (req.url === '/v1/transit/datakey/plaintext/wrap') {
        expect(input.bits).toBe(256)
        const dek = randomBytes(32), iv = randomBytes(12)
        const cipher = createCipheriv('aes-256-gcm', wrappingKeys[wrappingVersion - 1]!, iv)
        cipher.setAAD(Buffer.from(input.associated_data, 'base64'))
        const ciphertext = Buffer.concat([iv, cipher.update(dek), cipher.final(), cipher.getAuthTag()])
        data = { plaintext: (fault === 'wrong-dek' ? Buffer.from('bad') : dek).toString('base64'), ciphertext: `vault:v${wrappingVersion}:${ciphertext.toString('base64')}` }
      } else if (req.url === '/v1/transit/decrypt/wrap') {
        const parts = input.ciphertext.split(':'); const bytes = Buffer.from(parts[2], 'base64')
        const cipher = createDecipheriv('aes-256-gcm', wrappingKeys[Number(parts[1].slice(1)) - 1]!, bytes.subarray(0, 12))
        cipher.setAAD(Buffer.from(input.associated_data, 'base64')); cipher.setAuthTag(bytes.subarray(-16))
        data = { plaintext: Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('base64') }
      } else if (req.url === '/v1/transit/hmac/fingerprint/sha2-256' || req.url === '/v1/transit/hmac/manifest/sha2-256') {
        expect(input.key_version).toBe(1)
        const key = req.url.includes('/fingerprint/') ? fingerprintKey : manifestKey
        data = { hmac: `vault:v${fault === 'wrong-version' ? 2 : 1}:${createHmac('sha256', key).update(Buffer.from(input.input, 'base64')).digest('base64')}` }
      } else if (req.url === '/v1/transit/verify/manifest/sha2-256') {
        const expected = 'vault:v1:' + createHmac('sha256', manifestKey).update(Buffer.from(input.input, 'base64')).digest('base64')
        data = { valid: fault === 'string-verdict' ? 'false' : input.hmac === expected }
      } else throw new Error('unexpected protocol path')
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }))
    } catch { res.writeHead(400).end('synthetic-custody-private-error') }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); tls.key.fill(0); unrelatedTls.key.fill(0) })
function adapter(overrides: object = {}) {
  return createRecoveryOpenBaoCustody({ url, token, ca: tls.cert, keyId, wrappingKey: 'wrap', fingerprintKey: 'fingerprint',
    fingerprintKeyVersion: 1, manifestKey: 'manifest', manifestKeyVersion: 1, timeoutMs: 300, transactionDepth: { currentTransactionDepth: () => depth }, ...overrides })
}

describe('OpenBao candidate custody over verified TLS', () => {
  test('mint and unwrap preserve actual DEK; wrapping rotation leaves fingerprint unchanged', async () => {
    fault = 'none'; const custody = adapter(), generationId = randomUUID()
    wrappingVersion = 1
    const first = await custody.produceGenerationDek({ keyId, generationId })
    const original = await custody.deriveDekFingerprint({ keyId, dek: first.dek })
    expect(original).toBe(createHmac('sha256', fingerprintKey).update(Buffer.concat([Buffer.from(RECOVERY_ARCHIVE_DEK_FINGERPRINT_DOMAIN + '\0'), Buffer.from(first.dek)])).digest('hex'))
    wrappingVersion = 2
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', wrappingKeys[1]!, iv)
    cipher.setAAD(Buffer.from(JSON.stringify(['metasheet.recovery-archive.openbao-wrap.v1', keyId, generationId])))
    const wrappedDek = Buffer.from('vault:v2:' + Buffer.concat([iv, cipher.update(first.dek), cipher.final(), cipher.getAuthTag()]).toString('base64'))
    const wrappedDekId = createHash('sha256').update(wrappedDek).digest('hex')
    const second = await custody.unwrapGenerationDek({ keyId, generationId, wrappedDek, wrappedDekId })
    expect(second.dek).toEqual(first.dek); expect(second.wrappedDekId).toBe(wrappedDekId)
    expect(await custody.deriveDekFingerprint({ keyId, dek: second.dek })).toBe(original)
    await expect(custody.unwrapGenerationDek({ ...first, keyId, generationId: randomUUID() })).rejects.toThrow('RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_FAILED')
  })
  test('root MAC verifies exactly and mismatch is false', async () => {
    fault = 'none'; const custody = adapter(), preimage = Buffer.from('synthetic-root')
    const mac = await custody.macManifestRoot({ keyId, preimage })
    expect(await custody.verifyManifestRootMac({ keyId, preimage, mac })).toBe(true)
    expect(await custody.verifyManifestRootMac({ keyId, preimage: Buffer.from('changed-root'), mac })).toBe(false)
  })
  test('all five custody verbs refuse transaction IO', async () => {
    fault = 'none'; const custody = adapter(), generationId = randomUUID(), minted = await custody.produceGenerationDek({ keyId, generationId })
    const mac = await custody.macManifestRoot({ keyId, preimage: Buffer.from('root') }); const before = calls
    depth = 1
    try {
      for (const run of [() => custody.produceGenerationDek({ keyId, generationId }), () => custody.unwrapGenerationDek({ keyId, generationId, ...minted }),
        () => custody.deriveDekFingerprint({ keyId, dek: minted.dek }), () => custody.macManifestRoot({ keyId, preimage: Buffer.from('root') }),
        () => custody.verifyManifestRootMac({ keyId, preimage: Buffer.from('root'), mac })]) await expect(run()).rejects.toThrow()
      expect(calls).toBe(before)
    } finally { depth = 0 }
  })
  test('bad request binding rejects before network', async () => {
    fault = 'none'; const custody = adapter(), generationId = randomUUID(), minted = await custody.produceGenerationDek({ keyId, generationId }), before = calls
    await expect(custody.unwrapGenerationDek({ keyId, generationId, ...minted, wrappedDekId: 'a'.repeat(64) })).rejects.toThrow()
    await expect(custody.produceGenerationDek({ keyId: 'foreign-key', generationId })).rejects.toThrow()
    await expect(custody.produceGenerationDek({ keyId, generationId: 'invalid' })).rejects.toThrow()
    expect(calls).toBe(before)
  })
  test.each(['wrong-dek', 'redirect', 'oversize', 'timeout', 'error'] as const)('%s is a closed error without values', async kind => {
    fault = kind
    await expect(adapter().produceGenerationDek({ keyId, generationId: randomUUID() })).rejects.toThrow(/^RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_FAILED$/)
    fault = 'none'
  })
  test('wrong pinned fingerprint version and non-boolean verdict refuse', async () => {
    fault = 'wrong-version'; await expect(adapter().deriveDekFingerprint({ keyId, dek: randomBytes(32) })).rejects.toThrow()
    fault = 'none'; const custody = adapter(), preimage = Buffer.from('root'), mac = await custody.macManifestRoot({ keyId, preimage })
    fault = 'string-verdict'; await expect(custody.verifyManifestRootMac({ keyId, preimage, mac })).rejects.toThrow()
    fault = 'none'
  })
  test('wrong CA and wrong token cannot reach successful custody', async () => {
    fault = 'none'
    const before = calls
    await expect(adapter({ ca: unrelatedTls.cert }).produceGenerationDek({ keyId, generationId: randomUUID() })).rejects.toThrow()
    expect(calls).toBe(before)
    await expect(adapter({ token: token + 'wrong' }).produceGenerationDek({ keyId, generationId: randomUUID() })).rejects.toThrow()
  })
  test.each([{ url: 'http://127.0.0.1' }, { url: 'https://user:secret@example.invalid' }, { fingerprintKeyVersion: 0 }, { fingerprintKey: 'wrap' }, { timeoutMs: 0 }, { token: '' }, { token: 'contains whitespace' }])('invalid resource config refuses', options => {
    expect(() => adapter(options)).toThrow(/^RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_FAILED$/)
  })
})

import { createCipheriv, randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, test } from 'vitest'
import { createLocalCustodyBackup, createLocalCustodySession } from '../../src/multitable/recovery-local-custody'
import { createTransactionGuardedKeyCustody } from '../../src/multitable/recovery-archive-crypto'

const probe = { currentTransactionDepth: () => 0 }
const error = { message: 'RECOVERY_LOCAL_CUSTODY_REFUSED' }
const require = createRequire(import.meta.url)

function fixture() {
  const custodyId = randomUUID()
  const secret = randomBytes(32)
  const backup = createLocalCustodyBackup({ custodyId, recoverySecret: secret, transactionDepth: probe })
  const session = createLocalCustodySession(probe)
  session.unlock({ custodyId, recoverySecret: secret, backup })
  return { custodyId, secret, backup, session }
}

describe('explicit local custody core', () => {
  test('explicit admission wraps, authenticates and unwraps through the existing transaction guard', async () => {
    const f = fixture()
    const admitted = f.session.admitForArchive(f.custodyId)
    expect(admitted.keyId).toMatch(new RegExp(`^local-v1:${f.custodyId}:`))
    expect('produceGenerationDek' in admitted).toBe(false)
    const guarded = createTransactionGuardedKeyCustody(admitted, probe)
    const generationId = randomUUID()
    const issued = await guarded.produceGenerationDek({ keyId: admitted.keyId, generationId })
    const request = { keyId: admitted.keyId, generationId, wrappedDekId: issued.wrappedDekId, wrappedDek: issued.wrappedDek }
    expect((await guarded.unwrapGenerationDek(request)).dek).toEqual(issued.dek)
    const preimage = Buffer.from('synthetic archive preimage')
    const mac = await guarded.macManifestRoot({ keyId: admitted.keyId, preimage })
    expect(await guarded.verifyManifestRootMac({ keyId: admitted.keyId, preimage, mac })).toBe(true)
    expect(await guarded.deriveDekFingerprint({ keyId: admitted.keyId, dek: issued.dek })).toBe(f.session.localDekIdentity(issued.dek))
    f.session.lock()
    await expect(guarded.unwrapGenerationDek(request)).rejects.toThrow('RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_FAILED')
  })

  test('rejects wrong expected identity, raw sessions and forged/copied admissions', () => {
    const f = fixture()
    expect(() => f.session.admitForArchive(randomUUID())).toThrow(error.message)
    const admitted = f.session.admitForArchive(f.custodyId)
    for (const fake of [{ ...admitted }, { assurance: 'local-v1' }, f.session]) {
      expect(() => createTransactionGuardedKeyCustody(fake as never, probe)).toThrow('RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_FAILED')
    }
    f.session.lock()
    expect(() => f.session.admitForArchive(f.custodyId)).toThrow(error.message)
  })

  test('re-unlock revokes old admission while new admission can read retained old versions', async () => {
    const f = fixture()
    const admitted = f.session.admitForArchive(f.custodyId)
    const old = createTransactionGuardedKeyCustody(admitted, probe)
    const generationId = randomUUID()
    const issued = await old.produceGenerationDek({ keyId: admitted.keyId, generationId })
    const rotated = f.session.exportRotatedBackup(f.secret)
    f.session.lock()
    f.session.unlock({ custodyId: f.custodyId, recoverySecret: f.secret, backup: rotated })
    await expect(old.macManifestRoot({ keyId: admitted.keyId, preimage: Buffer.from('old') })).rejects.toThrow('RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_FAILED')
    const replacement = f.session.admitForArchive(f.custodyId)
    const current = createTransactionGuardedKeyCustody(replacement, probe)
    expect((await current.unwrapGenerationDek({ ...issued, keyId: admitted.keyId, generationId })).dek).toEqual(issued.dek)
    await expect(current.produceGenerationDek({ keyId: admitted.keyId, generationId })).rejects.toThrow('RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_FAILED')
    await expect(current.produceGenerationDek({ keyId: replacement.keyId, generationId })).resolves.toHaveProperty('dek')
    f.session.lock()
  })

  test('explicit admission rejects cross-custody and unqualified local key IDs', async () => {
    const f = fixture()
    const admitted = f.session.admitForArchive(f.custodyId)
    const guarded = createTransactionGuardedKeyCustody(admitted, probe)
    for (const keyId of [admitted.keyId.replace(f.custodyId, randomUUID()), admitted.keyId.split(':')[2], ` ${admitted.keyId}`]) {
      await expect(guarded.produceGenerationDek({ keyId, generationId: randomUUID() })).rejects.toThrow('RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_FAILED')
    }
    f.session.lock()
  })
  test('starts locked and is not structurally the KMS adapter', () => {
    const session = createLocalCustodySession(probe)
    expect(session.assurance).toBe('local-v1')
    expect(session.isUnlocked()).toBe(false)
    expect('produceGenerationDek' in session).toBe(false)
    expect(() => session.issueLocalDek(randomUUID())).toThrowError(error.message)
  })

  test('backup unlock recovers exact DEK and manifest MAC in a fresh session', () => {
    const { custodyId, secret, backup, session } = fixture()
    const generationId = randomUUID()
    const issued = session.issueLocalDek(generationId)
    const preimage = Buffer.from('synthetic-manifest')
    const mac = session.signLocalManifest(issued.keyId, preimage)
    session.lock()
    expect(session.isUnlocked()).toBe(false)
    const restored = createLocalCustodySession(probe)
    restored.unlock({ custodyId, recoverySecret: secret, backup })
    expect(restored.openLocalDek({ ...issued, generationId })).toEqual(issued.dek)
    expect(restored.verifyLocalManifest(issued.keyId, preimage, mac)).toBe(true)
    expect(restored.verifyLocalManifest(issued.keyId, Buffer.from('changed'), mac)).toBe(false)
    restored.lock()
  })

  test('rotation remains inactive until explicit unlock and retains old key material', () => {
    const { custodyId, secret, backup, session } = fixture()
    const generationId = randomUUID()
    const old = session.issueLocalDek(generationId)
    const identity = session.localDekIdentity(old.dek)
    const rotated = session.exportRotatedBackup(secret)
    expect(session.issueLocalDek(generationId).keyId).toBe(old.keyId)
    session.lock()
    session.unlock({ custodyId, recoverySecret: secret, backup: rotated })
    const fresh = session.issueLocalDek(generationId)
    expect(fresh.keyId).not.toBe(old.keyId)
    expect(session.openLocalDek({ ...old, generationId })).toEqual(old.dek)
    expect(session.localDekIdentity(old.dek)).toBe(identity)
    const original = createLocalCustodySession(probe)
    original.unlock({ custodyId, recoverySecret: secret, backup })
    expect(() => original.openLocalDek({ ...fresh, generationId })).toThrow(error.message)
    original.lock()
    session.lock()
  })

  test('wrong unlock secret or custody identity never admits state', () => {
    const { custodyId, secret, backup, session } = fixture()
    session.lock()
    expect(() => session.unlock({ custodyId, recoverySecret: randomBytes(32), backup })).toThrow(error.message)
    expect(session.isUnlocked()).toBe(false)
    expect(() => session.unlock({ custodyId: randomUUID(), recoverySecret: secret, backup })).toThrow(error.message)
    expect(session.isUnlocked()).toBe(false)
  })

  test.each(['nonce', 'ciphertext', 'tag'])('tampered backup %s refuses', (field) => {
    const { custodyId, secret, backup, session } = fixture()
    session.lock()
    const envelope = JSON.parse(Buffer.from(backup).toString())
    const bytes = Buffer.from(envelope[field], 'base64')
    bytes[0] ^= 1
    envelope[field] = bytes.toString('base64')
    expect(() => session.unlock({ custodyId, recoverySecret: secret, backup: Buffer.from(JSON.stringify(envelope)) })).toThrow(error.message)
    expect(session.isUnlocked()).toBe(false)
  })

  test('closed envelope, exact algorithms and size bounds refuse malformed backups', () => {
    const { custodyId, secret, backup, session } = fixture()
    session.lock()
    const envelope = JSON.parse(Buffer.from(backup).toString())
    for (const patch of [{ extra: true }, { version: 2 }, { assurance: 'kms' }, { nonce: 'AA==' }, { tag: '' }]) {
      expect(() => session.unlock({ custodyId, recoverySecret: secret, backup: Buffer.from(JSON.stringify({ ...envelope, ...patch })) })).toThrow(error.message)
    }
    expect(() => session.unlock({ custodyId, recoverySecret: secret, backup: Buffer.alloc(20_000) })).toThrow(error.message)
  })

  test('generation, version and wrapped identity substitutions refuse', () => {
    const { session } = fixture()
    const generationId = randomUUID()
    const issued = session.issueLocalDek(generationId)
    for (const patch of [{ generationId: randomUUID() }, { keyId: randomUUID() }, { wrappedId: randomUUID() }]) {
      expect(() => session.openLocalDek({ ...issued, generationId, ...patch })).toThrow(error.message)
    }
    const wrapped = Buffer.from(issued.wrapped)
    wrapped[wrapped.length - 1] ^= 1
    expect(() => session.openLocalDek({ ...issued, generationId, wrapped })).toThrow(error.message)
    session.lock()
  })

  test('failed export and unlock do not replace an active session', () => {
    const { session, custodyId, backup, secret } = fixture()
    const keyId = session.issueLocalDek(randomUUID()).keyId
    expect(() => session.exportRotatedBackup(Buffer.alloc(1))).toThrow(error.message)
    expect(() => session.unlock({ custodyId, backup, recoverySecret: secret })).toThrow(error.message)
    expect(session.issueLocalDek(randomUUID()).keyId).toBe(keyId)
    session.lock()
  })

  test.each([1, undefined, Number.NaN])('unknown/nonzero transaction depth %s refuses', (depth) => {
    const { custodyId, secret, backup, session } = fixture()
    session.lock()
    const guarded = createLocalCustodySession({ currentTransactionDepth: () => depth as number })
    expect(() => guarded.unlock({ custodyId, recoverySecret: secret, backup })).toThrow(error.message)
    expect(() => createLocalCustodyBackup({ custodyId, recoverySecret: secret, transactionDepth: { currentTransactionDepth: () => depth as number } })).toThrow(error.message)
  })

  test('every crypto operation rechecks transaction depth after unlock', () => {
    const { custodyId, secret, backup, session } = fixture()
    session.lock()
    let depth = 0
    const live = createLocalCustodySession({ currentTransactionDepth: () => depth })
    live.unlock({ custodyId, recoverySecret: secret, backup })
    const generationId = randomUUID()
    const issued = live.issueLocalDek(generationId)
    depth = 1
    for (const call of [
      () => live.issueLocalDek(generationId),
      () => live.openLocalDek({ ...issued, generationId }),
      () => live.localDekIdentity(issued.dek),
      () => live.signLocalManifest(issued.keyId, Buffer.from('x')),
      () => live.verifyLocalManifest(issued.keyId, Buffer.from('x'), Buffer.alloc(32)),
      () => live.exportRotatedBackup(secret),
    ]) expect(call).toThrow(error.message)
    live.lock()
    expect(live.isUnlocked()).toBe(false)
  })

  test('rotation preserves old MAC verification and rejects shortened MACs', () => {
    const { custodyId, secret, session } = fixture()
    const old = session.issueLocalDek(randomUUID())
    const data = Buffer.from('retained-manifest')
    const signature = session.signLocalManifest(old.keyId, data)
    const rotated = session.exportRotatedBackup(secret)
    session.lock()
    session.unlock({ custodyId, recoverySecret: secret, backup: rotated })
    expect(session.verifyLocalManifest(old.keyId, data, signature)).toBe(true)
    expect(session.verifyLocalManifest(old.keyId, data, signature.subarray(0, 16))).toBe(false)
    const current = session.issueLocalDek(randomUUID())
    expect(session.verifyLocalManifest(current.keyId, data, signature)).toBe(false)
    session.lock()
  })

  test('caller buffers cannot mutate unlocked keys; error causes remain values-free', () => {
    const { custodyId, secret, backup, session } = fixture()
    const generationId = randomUUID()
    const issued = session.issueLocalDek(generationId)
    secret.fill(0)
    backup.fill(0)
    const expected = Buffer.from(issued.dek)
    issued.dek.fill(0)
    expect(session.openLocalDek({ ...issued, generationId })).toEqual(expected)
    const hostile = createLocalCustodySession({ currentTransactionDepth: () => { throw new Error('private-secret-material') } })
    try {
      hostile.unlock({ custodyId, recoverySecret: secret, backup })
      expect.unreachable()
    } catch (caught) {
      expect(caught).toMatchObject(error)
      expect(caught).not.toHaveProperty('cause')
      expect(String(caught)).not.toContain('private-secret-material')
    }
    session.lock()
  })

  test('key count limit refuses rotation without losing the active version', () => {
    const { custodyId, secret, session } = fixture()
    for (let i = 1; i < 64; i += 1) {
      const rotated = session.exportRotatedBackup(secret)
      session.lock()
      session.unlock({ custodyId, recoverySecret: secret, backup: rotated })
    }
    const last = session.issueLocalDek(randomUUID()).keyId
    expect(() => session.exportRotatedBackup(secret)).toThrow(error.message)
    expect(session.issueLocalDek(randomUUID()).keyId).toBe(last)
    session.lock()
  })

  test('fresh process restores synthetic content from separate encrypted backup files', async () => {
    const { custodyId, secret, backup, session } = fixture()
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tm-local-custody-'))
    try {
      const keyDir = path.join(root, 'offline-custody')
      const archiveDir = path.join(root, 'archives')
      await fs.mkdir(keyDir, { mode: 0o700 })
      await fs.mkdir(archiveDir, { mode: 0o700 })
      const generationId = randomUUID()
      const issued = session.issueLocalDek(generationId)
      const records = [{ id: 'synthetic-row', fields: { count: 7, title: 'restored' } }]
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', issued.dek, nonce, { authTagLength: 16 })
      cipher.setAAD(Buffer.from(generationId))
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(records)), cipher.final()])
      const manifest = Buffer.from(JSON.stringify({ generationId, keyId: issued.keyId, wrappedId: issued.wrappedId,
        wrapped: Buffer.from(issued.wrapped).toString('base64'), nonce: nonce.toString('base64'),
        ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') }))
      await fs.writeFile(path.join(keyDir, 'backup'), backup, { mode: 0o600 })
      await fs.writeFile(path.join(archiveDir, 'manifest'), manifest, { mode: 0o600 })
      await fs.writeFile(path.join(archiveDir, 'mac'), session.signLocalManifest(issued.keyId, manifest), { mode: 0o600 })
      session.lock()
      issued.dek.fill(0)
      const source = path.resolve('src/multitable/recovery-local-custody.ts')
      const script = `
        const fs = require('node:fs'); const { createDecipheriv } = require('node:crypto');
        const { createLocalCustodySession } = require(${JSON.stringify(source)});
        const session = createLocalCustodySession({ currentTransactionDepth: () => 0 });
        if (session.isUnlocked()) process.exit(2);
        const secret = Buffer.from(fs.readFileSync(0, 'utf8'), 'base64');
        try {
          session.unlock({ custodyId: ${JSON.stringify(custodyId)}, recoverySecret: secret,
            backup: fs.readFileSync(${JSON.stringify(path.join(keyDir, 'backup'))}) });
          const manifest = fs.readFileSync(${JSON.stringify(path.join(archiveDir, 'manifest'))});
          const data = JSON.parse(manifest);
          if (!session.verifyLocalManifest(data.keyId, manifest, fs.readFileSync(${JSON.stringify(path.join(archiveDir, 'mac'))}))) process.exit(3);
          const dek = session.openLocalDek({ ...data, wrapped: Buffer.from(data.wrapped, 'base64') });
          const cipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(data.nonce, 'base64'), { authTagLength: 16 });
          cipher.setAAD(Buffer.from(data.generationId)); cipher.setAuthTag(Buffer.from(data.tag, 'base64'));
          const content = Buffer.concat([cipher.update(Buffer.from(data.ciphertext, 'base64')), cipher.final()]);
          dek.fill(0); process.stdout.write(content); content.fill(0);
        } finally { secret.fill(0); session.lock(); }`
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = execFile(process.execPath, [require.resolve('tsx/cli'), '-e', script], { timeout: 15_000 }, (failure, output) => failure ? reject(failure) : resolve(output))
        child.stdin!.end(secret.toString('base64'))
      })
      expect(JSON.parse(stdout)).toEqual(records)
    } finally {
      session.lock()
      secret.fill(0)
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

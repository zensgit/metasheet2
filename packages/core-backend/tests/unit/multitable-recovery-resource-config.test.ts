import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { readRecoveryResourcePrivateFile, readRecoveryResourceJson, readRecoveryRemoteResourceConfig } from '../../src/multitable/recovery-resource-config'

const roots: string[] = []
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tm-resource-config-')); roots.push(root)
  const file = join(root, 'private.json')
  await writeFile(file, '{"synthetic":true}', { mode: 0o600 })
  return { root, file }
}
describe('private resource config references', () => {
  test('owner-only regular file reads exact bytes and JSON', async () => {
    const f = await fixture()
    expect((await readRecoveryResourcePrivateFile(f.file, 128)).toString()).toBe('{"synthetic":true}')
    expect(await readRecoveryResourceJson(f.file)).toEqual({ synthetic: true })
  })
  test('complete resource packet resolves distinct private credentials and exact configured values', async () => {
    const f = await fixture(), objectToken = join(f.root, 'object-token'), custodyToken = join(f.root, 'custody-token'), caPath = join(f.root, 'ca')
    await writeFile(objectToken, 'synthetic-object-token\n', { mode: 0o600 })
    await writeFile(custodyToken, 'synthetic-custody-token\n', { mode: 0o600 })
    await writeFile(caPath, 'synthetic-ca', { mode: 0o600 })
    const config = { objectStore: { url: 'https://object.invalid', tokenPath: objectToken, caPath, timeoutMs: 1000, storeId: 'synthetic-store', maxObjectBytes: 1024 },
      keyCustody: { url: 'https://custody.invalid', tokenPath: custodyToken, caPath, timeoutMs: 1000, keyId: 'synthetic-key', wrappingKey: 'wrap', fingerprintKey: 'fingerprint', fingerprintKeyVersion: 1, manifestKey: 'manifest', manifestKeyVersion: 1 },
      policy: { workerIntervalMs: 1000 }, worker: { leaseMs: 1000, replayHorizonMs: 2000, sweepLimit: 10, maxChunksPerRun: 10 } }
    await writeFile(f.file, JSON.stringify(config), { mode: 0o600 })
    const { tokenPath: _objectToken, caPath: _objectCa, ...object } = config.objectStore
    const { tokenPath: _custodyToken, caPath: _custodyCa, ...custody } = config.keyCustody
    expect(await readRecoveryRemoteResourceConfig(f.file)).toEqual({ objectStore: { ...object, token: 'synthetic-object-token', ca: Buffer.from('synthetic-ca') },
      keyCustody: { ...custody, token: 'synthetic-custody-token', ca: Buffer.from('synthetic-ca') }, policy: config.policy, worker: config.worker })
    await writeFile(f.file, JSON.stringify({ ...config, worker: { ...config.worker, recheckAuthority: 'injected' } }), { mode: 0o600 })
    await expect(readRecoveryRemoteResourceConfig(f.file)).rejects.toThrow(/^RECOVERY_ARCHIVE_RESOURCE_CONFIG_REFUSED$/)
  })
  test('group-readable files, symlinks, relative paths and oversized data refuse with no values', async () => {
    const f = await fixture(), alias = join(f.root, 'alias')
    await symlink(f.file, alias)
    for (const path of [alias, 'relative', f.file]) await expect(readRecoveryResourcePrivateFile(path, 1)).rejects.toThrow(/^RECOVERY_ARCHIVE_RESOURCE_CONFIG_REFUSED$/)
    await chmod(f.file, 0o644)
    await expect(readRecoveryResourcePrivateFile(f.file, 128)).rejects.toThrow(/^RECOVERY_ARCHIVE_RESOURCE_CONFIG_REFUSED$/)
  })
  test('non-object or malformed JSON refuses', async () => {
    const f = await fixture()
    for (const data of ['null', '[]', 'invalid']) {
      await writeFile(f.file, data, { mode: 0o600 })
      await expect(readRecoveryResourceJson(f.file)).rejects.toThrow(/^RECOVERY_ARCHIVE_RESOURCE_CONFIG_REFUSED$/)
    }
  })
  test('unknown resource fields and callback injection refuse before resolving credentials', async () => {
    const f = await fixture()
    for (const config of [{ objectStore: {}, keyCustody: {}, policy: {}, worker: {}, extra: true },
      { objectStore: { apply: 'injected' }, keyCustody: {}, policy: {}, worker: {} }]) {
      await writeFile(f.file, JSON.stringify(config), { mode: 0o600 })
      await expect(readRecoveryRemoteResourceConfig(f.file)).rejects.toThrow(/^RECOVERY_ARCHIVE_RESOURCE_CONFIG_REFUSED$/)
    }
  })
})

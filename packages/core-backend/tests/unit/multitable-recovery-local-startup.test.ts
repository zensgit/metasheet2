import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { Duplex } from 'node:stream'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareRecoveryLocalStartup, parseRecoveryLocalStartupConfig, readRecoveryLocalStartupConfig } from '../../src/multitable/recovery-local-startup'
import { createLocalCustodyBackup, resolveLocalArchiveCustody } from '../../src/multitable/recovery-local-custody'
import { createLocalCustodyStore } from '../../src/multitable/recovery-local-custody-store'
import { provisionRecoveryArchiveFileRoot } from '../../src/multitable/recovery-archive-file-store'
import type { RecoveryArchiveApplicationDatabaseRuntime } from '../../src/multitable/recovery-archive-application'

const roots: string[] = []
const env = { MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true', MULTITABLE_ENABLE_WRITER_FENCE: 'true' }
const refusal = 'RECOVERY_LOCAL_STARTUP_REFUSED'
const require = createRequire(import.meta.url)
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tm-startup-'))
  roots.push(root)
  const archivePath = path.join(root, 'archive')
  const custodyPath = path.join(root, 'custody')
  await fs.mkdir(archivePath, { mode: 0o700 })
  await fs.mkdir(custodyPath, { mode: 0o700 })
  const transactionDepthProbe = { currentTransactionDepth: () => 0 }
  const database = {
    transactionDepthProbe,
    query: vi.fn(() => { throw new Error('database not expected before listener admission') }),
    transaction: vi.fn(() => { throw new Error('transaction not expected before listener admission') }),
  } as unknown as RecoveryArchiveApplicationDatabaseRuntime
  const custodyId = randomUUID()
  const storeId = randomUUID()
  const secret = randomBytes(32)
  const store = await createLocalCustodyStore({ archivePath, custodyPath, custodyId, transactionDepth: transactionDepthProbe })
  const backup = createLocalCustodyBackup({ custodyId, recoverySecret: secret, transactionDepth: transactionDepthProbe })
  const receipt = await store.putBackup(randomUUID(), backup)
  await provisionRecoveryArchiveFileRoot({ basePath: archivePath, storeId, transactionDepth: transactionDepthProbe })
  const config = { archivePath, custodyPath, custodyId, storeId, receipt, maxObjectBytes: 1024 * 1024,
    auditedReplayHorizonMs: 0, asyncResumeHorizonMs: 60_000, workerIntervalMs: 100,
    leaseMs: 60_000, replayHorizonMs: 0, sweepLimit: 10, maxChunksPerRun: 10 }
  const configPath = path.join(root, 'startup.json')
  await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
  const cancellation = new AbortController()
  const readSecret = vi.fn(async () => Buffer.from(secret))
  const input = { env, configPath, signal: cancellation.signal, readSecret, resolveDatabase: vi.fn(() => database) }
  return { root, secret, config, configPath, cancellation, database, input }
}

describe('locked local archive startup', () => {
  it('manual capture requires an explicit closed policy and never inherits numeric defaults', async () => {
    const f = await fixture()
    expect(parseRecoveryLocalStartupConfig(f.config)).not.toHaveProperty('manualCapture')
    const manualCapture = { keyId: 'synthetic-key', keyRowVersion: '1', leaseSeconds: 60, expiresAfterSeconds: 600 }
    const parsed = parseRecoveryLocalStartupConfig({ ...f.config, manualCapture })
    manualCapture.leaseSeconds = 1
    expect(parsed.manualCapture).toEqual({ ...manualCapture, leaseSeconds: 60 })
    expect(Object.isFrozen(parsed.manualCapture)).toBe(true)
    for (const policy of [null, {}, { ...manualCapture, expiresAfterSeconds: 0 },
      { ...manualCapture, leaseSeconds: 0 }, { ...manualCapture, keyId: '' },
      { ...manualCapture, keyRowVersion: '0' }, { ...manualCapture, retention: 1 }]) {
      expect(() => parseRecoveryLocalStartupConfig({ ...f.config, manualCapture: policy })).toThrow(refusal)
    }
    f.secret.fill(0)
  })
  it.each(['off', 'wrong-secret', 'cancel'] as const)('actual launcher refuses %s without listening', async mode => {
    const f = await fixture()
    const launcher = fileURLToPath(new URL('../../scripts/start-recovery-local.mts', import.meta.url))
    const child = spawn(process.execPath, ['--import', require.resolve('tsx'), launcher, f.configPath], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { PATH: process.env.PATH, NODE_ENV: 'test', VITEST: 'true',
        DATABASE_URL: 'postgresql://synthetic@127.0.0.1:9/synthetic',
        MULTITABLE_RECOVERY_ARCHIVE_ENABLED: mode === 'off' ? '' : 'true', MULTITABLE_ENABLE_WRITER_FENCE: 'true' },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    })
    const pipe = child.stdio[3] as Duplex
    pipe.on('error', () => undefined)
    let stdout = ''
    let stderr = ''
    child.stdout!.on('data', bytes => {
      stdout += String(bytes)
      if (mode === 'cancel' && stdout.includes('RECOVERY_LOCAL_CUSTODY_LOCKED')) child.kill('SIGTERM')
    })
    child.stderr!.on('data', bytes => { stderr += String(bytes) })
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000)
    try {
      if (mode !== 'cancel') pipe.end(randomBytes(32))
      const code = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
      expect(code).toBe(1)
      expect(stderr).toContain(refusal)
      expect(stderr).not.toContain(f.configPath)
      expect(stdout).not.toContain('core listening on')
      if (mode === 'off') expect(stdout).not.toContain('RECOVERY_LOCAL_CUSTODY_LOCKED')
      else expect(stdout).toContain('RECOVERY_LOCAL_CUSTODY_LOCKED')
    } finally {
      clearTimeout(timeout)
      pipe.destroy()
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      f.secret.fill(0)
    }
  })
  it.each([{}, { ...env, MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'TRUE' }, { ...env, MULTITABLE_ENABLE_WRITER_FENCE: '' }])('OFF ignores all configuration and IO (%s)', async flags => {
    const readSecret = vi.fn()
    const resolveDatabase = vi.fn()
    await expect(prepareRecoveryLocalStartup({ env: flags, configPath: '/does-not-exist',
      signal: AbortSignal.abort(), readSecret, resolveDatabase })).resolves.toBeUndefined()
    expect(readSecret).not.toHaveBeenCalled()
    expect(resolveDatabase).not.toHaveBeenCalled()
  })

  it('waits locked for explicit input, scrubs it, creates authentic revocable custody and real callbacks', async () => {
    const f = await fixture()
    let release!: (secret: Buffer) => void
    f.input.readSecret.mockImplementation(() => new Promise(resolve => { release = resolve }))
    let settled = false
    const startup = prepareRecoveryLocalStartup(f.input).then(value => { settled = true; return value })
    await vi.waitFor(() => expect(f.input.readSecret).toHaveBeenCalledTimes(1))
    expect(settled).toBe(false)
    expect(f.database.query).not.toHaveBeenCalled()
    const supplied = Buffer.from(f.secret)
    release(supplied)
    const local = (await startup)!
    expect(supplied.every(byte => byte === 0)).toBe(true)
    const operations = resolveLocalArchiveCustody(local.composition.keyCustody)!
    expect(operations).toBeDefined()
    expect(() => resolveLocalArchiveCustody({ ...local.composition.keyCustody })).toThrow('RECOVERY_LOCAL_CUSTODY_REFUSED')
    expect(typeof local.composition.worker.recheckAuthority).toBe('function')
    expect(typeof local.composition.worker.apply.afterCommit).toBe('function')
    expect(typeof local.composition.worker.processDerivedWork).toBe('function')
    const request = { generationId: randomUUID(), keyId: String(Reflect.get(local.composition.keyCustody, 'keyId')) }
    const dek = await operations.produceGenerationDek(request)
    expect(dek.dek).toHaveLength(32)
    dek.dek.fill(0)
    local.releaseCustody()
    local.releaseCustody()
    // Revocation remains on the original operation object, not only on a lookup wrapper.
    await expect(operations.produceGenerationDek(request)).rejects.toThrow()
    f.secret.fill(0)
  })

  it('fresh startup needs explicit input again and never persists it', async () => {
    const f = await fixture()
    for (let attempt = 0; attempt < 2; attempt++) {
      const local = (await prepareRecoveryLocalStartup(f.input))!
      local.releaseCustody()
    }
    expect(f.input.readSecret).toHaveBeenCalledTimes(2)
    expect((await fs.readdir(f.config.custodyPath))).toEqual([`${f.config.custodyId}-${f.config.receipt.backupId}.custody`])
    expect(JSON.parse(await fs.readFile(f.configPath, 'utf8'))).toEqual(f.config)
    f.secret.fill(0)
  })

  it.each(['wrong-secret', 'cancel', 'tampered-receipt', 'root-replaced'] as const)('fails closed on %s and scrubs supplied bytes', async mode => {
    const f = await fixture()
    const supplied = mode === 'wrong-secret' ? randomBytes(32) : Buffer.from(f.secret)
    f.input.readSecret.mockImplementation(async () => {
      if (mode === 'cancel') f.cancellation.abort()
      if (mode === 'root-replaced') {
        await fs.rename(f.config.custodyPath, `${f.config.custodyPath}-old`)
        await fs.mkdir(f.config.custodyPath, { mode: 0o700 })
      }
      return supplied
    })
    if (mode === 'tampered-receipt') {
      await fs.writeFile(f.configPath, JSON.stringify({ ...f.config, receipt: { ...f.config.receipt, sha256: '0'.repeat(64) } }))
    }
    await expect(prepareRecoveryLocalStartup(f.input)).rejects.toThrow(refusal)
    expect(supplied.every(byte => byte === 0)).toBe(true)
    expect(f.database.query).not.toHaveBeenCalled()
    f.secret.fill(0)
  })

  it('rejects non-private configuration, symlinks, unknown keys and missing runtime policy', async () => {
    const f = await fixture()
    for (const key of Object.keys(f.config)) {
      const incomplete = { ...f.config } as Record<string, unknown>
      delete incomplete[key]
      expect(() => parseRecoveryLocalStartupConfig(incomplete)).toThrow(refusal)
    }
    expect(() => parseRecoveryLocalStartupConfig({ ...f.config, recoverySecret: 'forbidden' })).toThrow(refusal)
    expect(() => parseRecoveryLocalStartupConfig({ ...f.config, workerIntervalMs: 2_147_483_648 })).toThrow(refusal)
    expect(() => parseRecoveryLocalStartupConfig({ ...f.config, receipt: { ...f.config.receipt, extra: true } })).toThrow(refusal)
    await fs.chmod(f.configPath, 0o644)
    await expect(readRecoveryLocalStartupConfig(f.configPath)).rejects.toThrow(refusal)
    await fs.chmod(f.configPath, 0o600)
    const alias = path.join(f.root, 'alias.json')
    await fs.symlink(f.configPath, alias)
    await expect(readRecoveryLocalStartupConfig(alias)).rejects.toThrow(refusal)
    expect(await readRecoveryLocalStartupConfig(f.configPath)).toEqual(f.config)
    f.secret.fill(0)
  })
})

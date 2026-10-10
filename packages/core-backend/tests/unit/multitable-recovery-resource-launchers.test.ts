import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { createRecoveryArchiveRemoteObjectStore } from '../../src/multitable/recovery-archive-remote-object-store'
import { recoveryResourceTestTls } from '../utils/recovery-resource-tls'

const backend = fileURLToPath(new URL('../../', import.meta.url))
function launch(script: string, config: string, env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', join(backend, 'scripts', script), config], {
    cwd: backend, env: { PATH: dirname(process.execPath), ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout!.on('data', bytes => { stdout += bytes.toString() })
  child.stderr!.on('data', bytes => { stderr += bytes.toString() })
  const exited = new Promise<number>(done => { child.once('error', () => done(-1)); child.once('exit', code => done(code ?? -1)) })
  return { child, exited, output: () => ({ stdout, stderr }) }
}
async function bounded<T>(promise: Promise<T>, child: ChildProcess): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('RESOURCE_LAUNCH_TIMEOUT')) }, 10000) })]) }
  finally { clearTimeout(timer!) }
}
async function port() {
  const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const value = (server.address() as AddressInfo).port; await new Promise<void>(done => server.close(() => done())); return value
}
test('explicit object CLI starts, drains and restarts with the same persisted archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tm-object-launcher-')), tls = await recoveryResourceTestTls()
  let processState: ReturnType<typeof launch> | undefined
  try {
    const token = 'synthetic-resource-token-'.padEnd(48, 'x'), storeId = randomUUID(), address = await port()
    const config = { host: '127.0.0.1', port: address, archivePath: join(root, 'archive'), storeId, maxObjectBytes: 1024, timeoutMs: 1000,
      tokenPath: join(root, 'token'), certPath: join(root, 'cert'), keyPath: join(root, 'key') }
    await mkdir(config.archivePath, { mode: 0o700 })
    for (const [file, data] of [[config.tokenPath, token], [config.certPath, tls.cert], [config.keyPath, tls.key]] as const) await writeFile(file, data, { mode: 0o600 })
    const path = join(root, 'config.json'); await writeFile(path, JSON.stringify(config), { mode: 0o600 })
    const store = createRecoveryArchiveRemoteObjectStore({ url: `https://127.0.0.1:${address}`, token, ca: tls.cert, storeId, maxObjectBytes: 1024, timeoutMs: 1000,
      transactionDepth: { currentTransactionDepth: () => 0 } })
    const bytes = Buffer.from('synthetic-ciphertext'), request = { generationId: randomUUID(), objectId: 'b'.repeat(64), version: 'immutable-1',
      sha256: createHash('sha256').update(bytes).digest('hex'), size: String(bytes.length), expiresAt: '2026-12-01T00:00:00.000Z', pinned: false, bytes }
    const { bytes: _bytes, ...descriptor } = request
    for (let iteration = 0; iteration < 2; iteration++) {
      processState = launch('start-recovery-object-service.mts', path)
      const current = processState
      await bounded(new Promise<void>((done, reject) => {
        current.child.stdout!.on('data', () => { if (current.output().stdout === 'RECOVERY_ARCHIVE_OBJECT_SERVICE_READY\n') done() })
        void current.exited.then(() => reject(new Error('RESOURCE_START_REFUSED')))
      }), current.child)
      expect(await store.put(request)).toEqual({ outcome: iteration ? 'existing' : 'created', object: descriptor })
      current.child.kill('SIGTERM')
      expect(await bounded(current.exited, current.child)).toBe(0)
      expect(current.output()).toEqual({ stdout: 'RECOVERY_ARCHIVE_OBJECT_SERVICE_READY\n', stderr: '' })
      processState = undefined
    }
  } finally {
    if (processState) { processState.child.kill('SIGTERM'); await bounded(processState.exited, processState.child) }
    tls.key.fill(0); await rm(root, { recursive: true, force: true })
  }
}, 25000)
test('explicit application CLI remains closed before reading resource paths when flags are OFF', async () => {
  const current = launch('start-recovery-remote.mts', '/nonexistent/synthetic-resource-config.json')
  expect(await bounded(current.exited, current.child)).toBe(1)
  expect(current.output()).toEqual({ stdout: '', stderr: 'RECOVERY_ARCHIVE_REMOTE_STARTUP_REFUSED\n' })
}, 15000)

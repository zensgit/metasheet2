import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:https'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRecoveryOpenBaoCustody } from '../src/multitable/recovery-openbao-custody'
import { recoveryResourceTestTls } from '../tests/utils/recovery-resource-tls'

// Explicit component proof only: no application, database, TM flag or held APFS driver.
const binary = resolve(process.argv[2] ?? '')
const root = await mkdtemp(join(tmpdir(), 'tm-openbao-component-'))
let child: ChildProcess | undefined
let exit: Promise<number> | undefined
const tls = await recoveryResourceTestTls()
let url = '', state = '', rootToken = '', unlock = ''
let phase = 'startup'
let serviceStartupFailure = 'none'
let lastApiStatus = 0, lastIoFailure = 'none'
let lastApiOperation = 'none'
let tokenLength = 0
async function port() {
  const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const value = (server.address() as AddressInfo).port; await new Promise<void>(done => server.close(() => done())); return value
}
async function api(path: string, payload?: object, token = rootToken) {
  lastIoFailure = 'none'
  lastApiOperation = path.startsWith('sys/mounts/') ? 'mount' : path.startsWith('transit/keys/') ? 'key_management'
    : path.startsWith('sys/policies/') ? 'policy' : path.startsWith('auth/token/') ? 'token'
    : path === 'sys/init' ? 'initialize' : path === 'sys/unseal' ? 'unseal' : 'component_operation'
  return await new Promise<{ status: number; body: Record<string, unknown> }>((resolveResult, reject) => {
    const bytes = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload))
    const req = request(url + '/v1/' + path, { method: bytes ? 'POST' : 'GET', ca: tls.cert, rejectUnauthorized: true, agent: false,
      headers: { 'x-vault-token': token, 'content-type': 'application/json' } }, res => {
      const chunks: Buffer[] = []; let size = 0
      res.on('data', data => { size += data.length; if (size > 65536) req.destroy(new Error('COMPONENT_IO_REFUSED')); else chunks.push(Buffer.from(data)) })
      res.on('end', () => { clearTimeout(timer); lastApiStatus = res.statusCode!; try { const body = Buffer.concat(chunks).toString(); resolveResult({ status: res.statusCode!, body: body ? JSON.parse(body) : {} }) } catch { lastIoFailure = 'JSON'; reject(new Error('COMPONENT_IO_REFUSED')) } })
    })
    const timer = setTimeout(() => req.destroy(new Error('COMPONENT_IO_REFUSED')), path === 'sys/init' ? 30000 : 5000)
    req.on('error', () => { lastIoFailure = 'NETWORK_OR_TIMEOUT'; clearTimeout(timer); reject(new Error('COMPONENT_IO_REFUSED')) }); req.end(bytes)
  })
}
async function start(path: string) {
  state = path
  await mkdir(path, { mode: 0o700, recursive: true })
  const config = join(root, 'bao.hcl'), address = await port(), cluster = await port()
  url = `https://127.0.0.1:${address}`
  await writeFile(config, `disable_mlock = true\napi_addr = "${url}"\ncluster_addr = "https://127.0.0.1:${cluster}"\n` +
    `storage "raft" {\n path = ${JSON.stringify(path)}\n node_id = "tm-component"\n}\nlistener "tcp" {\n address = "127.0.0.1:${address}"\n cluster_address = "127.0.0.1:${cluster}"\n tls_cert_file = ${JSON.stringify(join(root, 'cert.pem'))}\n tls_key_file = ${JSON.stringify(join(root, 'key.pem'))}\n}\n`, { mode: 0o600 })
  child = spawn(binary, ['server', '-config=' + config], { stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr!.on('data', bytes => {
    const message = Buffer.from(bytes).toString()
    for (const [pattern, code] of [[/Error parsing.*config/i, 'CONFIG_PARSE'], [/Error initializing core/i, 'CORE_INIT'],
      [/Error.*listener/i, 'LISTENER'], [/Error.*storage/i, 'STORAGE'], [/address already in use/i, 'PORT_BUSY']] as const) {
      if (pattern.test(message)) serviceStartupFailure = code
    }
  })
  exit = new Promise<number>(done => { child!.once('error', () => done(-1)); child!.once('exit', code => done(code ?? -1)) })
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null)
    try { await api('sys/health', undefined, ''); return } catch { await new Promise(done => setTimeout(done, 100)) }
  }
  throw new Error('COMPONENT_START_REFUSED')
}
async function stop() {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  let timer: ReturnType<typeof setTimeout>
  const result = await Promise.race([exit, new Promise<number>(done => { timer = setTimeout(() => done(-2), 10000) })])
  clearTimeout(timer!)
  if (result === -2) { child.kill('SIGKILL'); await exit; throw new Error('COMPONENT_DRAIN_REFUSED') }
  assert.equal(result, 0)
}
async function active() {
  const deadline = Date.now() + 15000
  while ((await api('sys/health')).status !== 200) {
    if (Date.now() >= deadline) throw new Error('COMPONENT_START_REFUSED')
    await new Promise(done => setTimeout(done, 100))
  }
}
let pass = false
try {
  await writeFile(join(root, 'key.pem'), tls.key, { mode: 0o600 }); await writeFile(join(root, 'cert.pem'), tls.cert, { mode: 0o600 })
  await start(join(root, 'original'))
  phase = 'initialization'
  const initialized = await api('sys/init', { secret_shares: 1, secret_threshold: 1 }, '')
  assert.equal(initialized.status, 200)
  if (!Array.isArray(initialized.body.keys_base64) || typeof initialized.body.root_token !== 'string') {
    phase = 'initialization_shape'; throw new Error('COMPONENT_IO_REFUSED')
  }
  rootToken = initialized.body.root_token as string; unlock = (initialized.body.keys_base64 as string[])[0]!
  phase = 'unseal'
  assert.equal((await api('sys/unseal', { key: unlock }, '')).status, 200)
  phase = 'active'
  await active()
  phase = 'key_setup'
  assert.equal((await api('sys/mounts/transit', { type: 'transit' })).status, 204)
  for (const key of ['wrap', 'fingerprint', 'manifest']) {
    assert.equal((await api('transit/keys/' + key, { type: 'aes256-gcm96', exportable: false, allow_plaintext_backup: false })).status, 200)
  }
  const policy = ['datakey/plaintext/wrap', 'decrypt/wrap', 'hmac/fingerprint/sha2-256', 'hmac/manifest/sha2-256', 'verify/manifest/sha2-256']
    .map(path => `path "transit/${path}" { capabilities = ["update"] }`).join('\n')
  assert.equal((await api('sys/policies/acl/tm-component', { policy })).status, 204)
  const issued = await api('auth/token/create', { policies: ['tm-component'], no_default_policy: true })
  assert.equal(issued.status, 200)
  const token = (issued.body.auth as { client_token: string }).client_token
  tokenLength = token.length
  phase = 'custody_protocol'
  const keyId = 'synthetic-staging-key', generationId = randomUUID(), preimage = Buffer.from('synthetic-manifest-root')
  const custody = (manifestKeyVersion = 1) => createRecoveryOpenBaoCustody({ url, token, ca: tls.cert, timeoutMs: 2000,
    keyId, wrappingKey: 'wrap', fingerprintKey: 'fingerprint', fingerprintKeyVersion: 1,
    manifestKey: 'manifest', manifestKeyVersion, transactionDepth: { currentTransactionDepth: () => 0 } })
  phase = 'generation_mint'
  const minted = await custody().produceGenerationDek({ keyId, generationId })
  phase = 'generation_fingerprint'
  const fingerprint = await custody().deriveDekFingerprint({ keyId, dek: minted.dek })
  const mac = await custody().macManifestRoot({ keyId, preimage })
  phase = 'generation_unwrap'
  assert.deepEqual((await custody().unwrapGenerationDek({ keyId, generationId, ...minted })).dek, minted.dek)
  await assert.rejects(custody().unwrapGenerationDek({ keyId, generationId: randomUUID(), ...minted }))
  assert.equal(await custody().verifyManifestRootMac({ keyId, preimage, mac }), true)
  assert.equal(await custody().verifyManifestRootMac({ keyId, preimage: Buffer.from('tampered-root'), mac }), false)
  assert.equal((await api('transit/export/encryption-key/wrap', undefined, token)).status, 403)
  assert.equal((await api('transit/backup/wrap', undefined, token)).status, 403)
  phase = 'rotation'
  for (const key of ['wrap', 'fingerprint', 'manifest']) {
    assert.equal((await api('transit/keys/' + key + '/rotate', {})).status, 200)
    const current = await api('transit/keys/' + key)
    assert.equal(current.status, 200)
    const data = current.body.data as Record<string, unknown>
    assert.equal(data.latest_version, 2)
    assert.equal(data.exportable, false)
    assert.equal(data.allow_plaintext_backup, false)
  }
  // The 2.7 rewrap endpoint does not carry AEAD associated_data. Preserve the
  // generation binding using an explicit operator encrypt control for this proof.
  phase = 'operator_rotation_binding'
  const rewrapped = await api('transit/encrypt/wrap', { plaintext: Buffer.from(minted.dek).toString('base64'), key_version: 2,
    associated_data: Buffer.from(JSON.stringify(['metasheet.recovery-archive.openbao-wrap.v1', keyId, generationId])).toString('base64') })
  assert.equal(rewrapped.status, 200)
  const wrappedDek = Buffer.from((rewrapped.body.data as { ciphertext: string }).ciphertext)
  assert.equal(wrappedDek.toString().startsWith('vault:v2:'), true)
  const rotated = { wrappedDek, wrappedDekId: createHash('sha256').update(wrappedDek).digest('hex') }
  const unwrapped = await custody().unwrapGenerationDek({ keyId, generationId, ...rotated })
  assert.deepEqual(unwrapped.dek, minted.dek)
  await assert.rejects(custody().unwrapGenerationDek({ keyId, generationId: randomUUID(), ...rotated }))
  assert.equal(await custody().deriveDekFingerprint({ keyId, dek: unwrapped.dek }), fingerprint)
  assert.equal(await custody(2).verifyManifestRootMac({ keyId, preimage, mac }), true)
  const nextMac = await custody(2).macManifestRoot({ keyId, preimage })
  assert.equal(await custody(2).verifyManifestRootMac({ keyId, preimage, mac: nextMac }), true)
  await stop()
  phase = 'state_backup_restore'
  const backup = join(root, 'backup'); await cp(state, backup, { recursive: true })
  for (const entry of await readdir(backup, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const bytes = await readFile(join(entry.parentPath, entry.name))
    for (const secret of [Buffer.from(minted.dek), Buffer.from(unlock, 'base64'), Buffer.from(unlock), Buffer.from(rootToken)]) assert.equal(bytes.includes(secret), false)
    bytes.fill(0)
  }
  await rm(state, { recursive: true, force: true })
  await start(backup)
  assert.equal((await api('sys/unseal', { key: unlock }, '')).status, 200)
  await active()
  assert.deepEqual((await custody(2).unwrapGenerationDek({ keyId, generationId, ...rotated })).dek, minted.dek)
  assert.equal(await custody(2).deriveDekFingerprint({ keyId, dek: minted.dek }), fingerprint)
  assert.equal(await custody(2).verifyManifestRootMac({ keyId, preimage, mac }), true)
  await stop(); pass = true
  minted.dek.fill(0); unwrapped.dek.fill(0)
  console.log(JSON.stringify({ code: 'RECOVERY_OPENBAO_COMPONENT_PASS', mintUnwrap: true, wrongGenerationRefused: true,
    rootMac: true, wrappingRotationIdentity: true, operatorEncryptRotationControl: true, transparentRewrapUsed: false,
    pinnedFingerprintRotation: true, oldRootMacRotation: true,
    scopedTokenExportBackupRefused: true, encryptedStateBackupRestore: true, unlockRetainedSeparately: true,
    originalStateRemovedBeforeRestore: true, plaintextMaterialAbsentFromBackup: true,
    applicationOrDatabaseStarted: false, stagingExecuted: false }))
} catch {
  console.error(JSON.stringify({ code: 'RECOVERY_OPENBAO_COMPONENT_REFUSED', phase, serviceStartupFailure, lastApiStatus, lastIoFailure, lastApiOperation, tokenLength })); process.exitCode = 1
} finally {
  try { await stop() } catch { process.exitCode = 1 }
  tls.key.fill(0); rootToken = ''; unlock = ''
  await rm(root, { recursive: true, force: true })
  if (!pass) process.exitCode = 1
}

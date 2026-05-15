import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { test } from 'node:test'

const SCRIPT = path.resolve('scripts/ops/integration-issue1542-seed-workbench-systems.mjs')
const TOKEN = 'header.payload.signature-value-for-tests'

function descriptor() {
  return {
    id: 'standard_materials',
    name: 'Standard materials',
    fields: ['code', 'name', 'uom', 'erpSyncStatus'],
    fieldDetails: [
      { id: 'code', name: 'Code', type: 'string' },
      { id: 'name', name: 'Name', type: 'string' },
      { id: 'uom', name: 'UOM', type: 'string' },
      { id: 'erpSyncStatus', name: 'ERP Sync Status', type: 'select', options: ['pending', 'synced', 'failed'] },
    ],
  }
}

async function readJson(req) {
  let text = ''
  for await (const chunk of req) text += chunk
  return text ? JSON.parse(text) : null
}

async function withFakeServer(handler, fn) {
  const calls = []
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }))
        return
      }
      await handler(req, res, calls)
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: error.message } }))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    return await fn(`http://127.0.0.1:${address.port}`, calls)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function defaultHandler(req, res, calls) {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (req.method === 'GET' && url.pathname === '/api/integration/staging/descriptors') {
    calls.push({ method: req.method, path: url.pathname })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [descriptor()] }))
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/integration/staging/install') {
    const body = await readJson(req)
    calls.push({ method: req.method, path: url.pathname, body })
    res.writeHead(201, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      data: {
        sheetIds: { standard_materials: 'sheet_from_install' },
        viewIds: { standard_materials: 'view_from_install' },
        openLinks: { standard_materials: '/multitable/sheet_from_install/view_from_install' },
        targets: [{
          id: 'standard_materials',
          sheetId: 'sheet_from_install',
          viewId: 'view_from_install',
          openLink: '/multitable/sheet_from_install/view_from_install',
        }],
        warnings: [],
      },
    }))
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/integration/external-systems') {
    const body = await readJson(req)
    calls.push({ method: req.method, path: url.pathname, body })
    res.writeHead(201, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: { ...body, createdAt: '2026-05-15T00:00:00Z' } }))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }))
}

async function runScript(args, { token = TOKEN } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'issue1542-seed-'))
  const tokenFile = path.join(dir, 'token.jwt')
  await writeFile(tokenFile, token, { mode: 0o600 })
  const outDir = path.join(dir, 'out')
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [
      SCRIPT,
      '--token-file',
      tokenFile,
      '--out-dir',
      outDir,
      ...args,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, METASHEET_AUTH_TOKEN: '', ADMIN_TOKEN: '', AUTH_TOKEN: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolve({ code, stdout, stderr, dir, outDir }))
  })
  return result
}

test('seeds staging source and metadata-only K3 target from existing sheet id', async () => {
  await withFakeServer(defaultHandler, async (baseUrl, calls) => {
    const result = await runScript([
      '--base-url',
      baseUrl,
      '--tenant-id',
      'default',
      '--project-id',
      'project_a',
      '--standard-materials-sheet-id',
      'sheet_materials',
      '--standard-materials-view-id',
      'view_materials',
      '--standard-materials-open-link',
      '/multitable/sheet_materials/view_materials',
    ])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /Issue #1542 Data Factory seed: PASS/)

    const upserts = calls.filter((call) => call.method === 'POST' && call.path === '/api/integration/external-systems')
    assert.equal(upserts.length, 2)
    const source = upserts.find((call) => call.body.kind === 'metasheet:staging').body
    const target = upserts.find((call) => call.body.kind === 'erp:k3-wise-webapi').body
    assert.equal(source.id, 'metasheet_staging_project_a')
    assert.equal(source.role, 'source')
    assert.equal(source.status, 'active')
    assert.equal(source.config.objects.standard_materials.sheetId, 'sheet_materials')
    assert.equal(source.config.objects.standard_materials.viewId, 'view_materials')
    assert.equal(target.role, 'target')
    assert.equal(target.status, 'active')
    assert.equal(target.config.autoSubmit, false)
    assert.equal(target.config.autoAudit, false)
    assert.equal(target.config.metadataOnly, true)
    assert.equal(Object.prototype.hasOwnProperty.call(target, 'credentials'), false)

    const evidence = JSON.parse(await readFile(path.join(result.outDir, 'integration-issue1542-seed-workbench-systems.json'), 'utf8'))
    assert.equal(evidence.decision, 'PASS')
    assert.equal(evidence.mode, 'seed-existing-sheet')
    assert.equal(evidence.systems.stagingSource.sheetId, 'sheet_materials')
    assert.equal(evidence.systems.k3Target.credentials, 'not written by this tool')
    await rm(result.dir, { recursive: true, force: true })
  })
})
test('can install staging first and use returned standard_materials sheet id', async () => {
  await withFakeServer(defaultHandler, async (baseUrl, calls) => {
    const result = await runScript([
      '--base-url',
      baseUrl,
      '--tenant-id',
      'default',
      '--project-id',
      'project_b',
      '--install-staging',
    ])
    assert.equal(result.code, 0, result.stderr)

    const install = calls.find((call) => call.method === 'POST' && call.path === '/api/integration/staging/install')
    assert.ok(install)
    assert.equal(install.body.projectId, 'project_b')
    const source = calls.find((call) => call.body?.kind === 'metasheet:staging').body
    assert.equal(source.config.objects.standard_materials.sheetId, 'sheet_from_install')

    const evidence = JSON.parse(await readFile(path.join(result.outDir, 'integration-issue1542-seed-workbench-systems.json'), 'utf8'))
    assert.equal(evidence.mode, 'install-staging-and-seed')
    assert.equal(evidence.systems.stagingSource.sheetId, 'sheet_from_install')
    await rm(result.dir, { recursive: true, force: true })
  })
})

test('install-staging explains metadata-only fallback when no sheet id is returned', async () => {
  await withFakeServer(async (req, res, calls) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/api/integration/staging/descriptors') {
      calls.push({ method: req.method, path: url.pathname })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [descriptor()] }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/integration/staging/install') {
      calls.push({ method: req.method, path: url.pathname, body: await readJson(req) })
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        data: {
          sheetIds: {},
          viewIds: {},
          warnings: ['context.api.multitable.provisioning.ensureObject not available'],
        },
      }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }))
  }, async (baseUrl, calls) => {
    const result = await runScript([
      '--base-url',
      baseUrl,
      '--tenant-id',
      'default',
      '--project-id',
      'project_b',
      '--install-staging',
    ])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /staging install did not return sheetIds\.standard_materials/)
    assert.match(result.stderr, /--standard-materials-sheet-id issue1542_metadata_standard_materials/)
    assert.equal(calls.filter((call) => call.path === '/api/integration/external-systems').length, 0)
    await rm(result.dir, { recursive: true, force: true })
  })
})

test('rejects missing sheet id unless install-staging is supplied', async () => {
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [
      SCRIPT,
      '--base-url',
      'http://127.0.0.1:9',
      '--auth-token',
      TOKEN,
      '--tenant-id',
      'default',
    ], {
      cwd: process.cwd(),
      env: { ...process.env, METASHEET_AUTH_TOKEN: '', ADMIN_TOKEN: '', AUTH_TOKEN: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolve({ code, stderr }))
  })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /--standard-materials-sheet-id is required unless --install-staging is supplied/)
})

test('writes artifacts with private file mode and without bearer token leakage', async () => {
  await withFakeServer(defaultHandler, async (baseUrl) => {
    const result = await runScript([
      '--base-url',
      `${baseUrl}?access_token=leak-me`,
      '--tenant-id',
      'default',
      '--project-id',
      'project_c',
      '--standard-materials-sheet-id',
      'sheet_materials',
      '--k3-base-url',
      'http://user:rawpass@k3.local/K3API/?api_key=raw&sign=raw',
    ])
    assert.equal(result.code, 0, result.stderr)
    const jsonPath = path.join(result.outDir, 'integration-issue1542-seed-workbench-systems.json')
    const mdPath = path.join(result.outDir, 'integration-issue1542-seed-workbench-systems.md')
    const json = await readFile(jsonPath, 'utf8')
    const md = await readFile(mdPath, 'utf8')
    assert.equal(json.includes(TOKEN), false)
    assert.equal(md.includes(TOKEN), false)
    assert.equal(json.includes('rawpass'), false)
    assert.equal(json.includes('api_key=raw'), false)
    assert.equal(json.includes('sign=raw'), false)
    const jsonMode = (await stat(jsonPath)).mode & 0o777
    const mdMode = (await stat(mdPath)).mode & 0o777
    assert.equal(jsonMode, 0o600)
    assert.equal(mdMode, 0o600)
    await rm(result.dir, { recursive: true, force: true })
  })
})

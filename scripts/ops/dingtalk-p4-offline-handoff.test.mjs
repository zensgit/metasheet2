import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sessionScript = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-p4-smoke-session.mjs')
const handoffScript = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-p4-final-handoff.mjs')
const statusScript = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-p4-smoke-status.mjs')
const recordScript = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-p4-evidence-record.mjs')
const manualClientIds = new Set([
  'send-group-message-form-link',
  'authorized-user-submit',
  'unauthorized-user-denied',
])
const manualAdminIds = new Set(['no-email-user-create-bind'])

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'dingtalk-p4-offline-handoff-'))
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      if (!raw) {
        resolve(null)
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  res.statusCode = status
  if (body === undefined) {
    res.end()
    return
  }
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function createFakeApiServer() {
  let groupCount = 0
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const body = await readRequestBody(req)

      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/multitable/bases') {
        sendJson(res, 201, { ok: true, data: { base: { id: 'base_1', name: body.name } } })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/multitable/sheets') {
        sendJson(res, 200, { ok: true, data: { sheet: { id: 'sheet_1', baseId: body.baseId } } })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/multitable/fields') {
        sendJson(res, 201, { ok: true, data: { field: { id: 'field_1', name: body.name } } })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/multitable/views') {
        sendJson(res, 201, { ok: true, data: { view: { id: 'view_form_1', type: body.type } } })
        return
      }

      if (req.method === 'PATCH' && url.pathname === '/api/multitable/sheets/sheet_1/views/view_form_1/form-share') {
        sendJson(res, 200, {
          ok: true,
          data: {
            enabled: true,
            status: 'active',
            accessMode: 'dingtalk_granted',
            publicToken: 'public_token_should_not_leak',
          },
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/multitable/dingtalk-groups') {
        groupCount += 1
        sendJson(res, 201, {
          ok: true,
          data: {
            id: `dt_group_${groupCount}`,
            name: body.name,
            sheetId: body.sheetId,
          },
        })
        return
      }

      if (req.method === 'POST' && /^\/api\/multitable\/dingtalk-groups\/dt_group_[12]\/test-send$/.test(url.pathname)) {
        sendJson(res, 204)
        return
      }

      const manualDeliveriesMatch = url.pathname.match(/^\/api\/multitable\/dingtalk-groups\/(dt_group_[12])\/deliveries$/)
      if (req.method === 'GET' && manualDeliveriesMatch) {
        sendJson(res, 200, {
          ok: true,
          data: {
            deliveries: [{ id: `delivery_${manualDeliveriesMatch[1]}`, status: 'success' }],
          },
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/multitable/sheets/sheet_1/automations') {
        if (body.actionType === 'send_dingtalk_group_message') {
          sendJson(res, 200, { ok: true, data: { rule: { id: 'rule_group_1' } } })
          return
        }
        if (body.actionType === 'send_dingtalk_person_message') {
          sendJson(res, 200, { ok: true, data: { rule: { id: 'rule_person_1' } } })
          return
        }
      }

      const testRunMatch = url.pathname.match(/^\/api\/multitable\/sheets\/sheet_1\/automations\/(rule_group_1|rule_person_1)\/test$/)
      if (req.method === 'POST' && testRunMatch) {
        sendJson(res, 200, {
          id: `exec_${testRunMatch[1]}`,
          status: 'success',
          steps: [{ status: 'success' }],
        })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/multitable/sheets/sheet_1/automations/rule_group_1/dingtalk-group-deliveries') {
        sendJson(res, 200, {
          ok: true,
          data: {
            deliveries: [
              { id: 'rule_group_delivery_1', destinationId: 'dt_group_1', status: 'success' },
              { id: 'rule_group_delivery_2', destinationId: 'dt_group_2', status: 'success' },
            ],
          },
        })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/multitable/sheets/sheet_1/automations/rule_person_1/dingtalk-person-deliveries') {
        sendJson(res, 200, {
          ok: true,
          data: {
            deliveries: [{ id: 'rule_person_delivery_1', userId: 'user_person_bound', status: 'success' }],
          },
        })
        return
      }

      sendJson(res, 404, { ok: false, error: { message: `unexpected route ${req.method} ${url.pathname}` } })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: { message: error instanceof Error ? error.message : String(error) } })
    }
  })

  return {
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      return `http://127.0.0.1:${address.port}`
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

function runAsyncScript(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => resolve({ status: code, stdout, stderr }))
  })
}

function runSyncScript(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

function fillManualEvidence(sessionDir) {
  const evidencePath = path.join(sessionDir, 'workspace', 'evidence.json')
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
  for (const check of evidence.checks) {
    if (!manualClientIds.has(check.id) && !manualAdminIds.has(check.id)) continue
    const artifactRef = `artifacts/${check.id}/evidence.txt`
    const artifactPath = path.join(sessionDir, 'workspace', artifactRef)
    mkdirSync(path.dirname(artifactPath), { recursive: true })
    writeFileSync(artifactPath, `${check.id} offline manual proof\n`, 'utf8')
    const result = runSyncScript(recordScript, [
      '--session-dir',
      sessionDir,
      '--check-id',
      check.id,
      '--status',
      'pass',
      '--source',
      manualClientIds.has(check.id) ? 'manual-client' : 'manual-admin',
      '--operator',
      'qa',
      '--performed-at',
      '2026-04-23T10:00:00.000Z',
      '--summary',
      `${check.id} verified in offline handoff chain`,
      '--artifact',
      artifactRef,
      ...(check.id === 'unauthorized-user-denied'
        ? [
            '--submit-blocked',
            '--record-insert-delta',
            '0',
            '--blocked-reason',
            'Visible error showed the user is not in the allowlist.',
          ]
        : []),
    ])
    assert.equal(result.status, 0, result.stderr || result.stdout)
  }
  const updated = JSON.parse(readFileSync(evidencePath, 'utf8'))
  assert.equal(updated.updatedBy, 'dingtalk-p4-evidence-record')
}

function assertNoSecrets(value) {
  assert.doesNotMatch(value, /secret-admin-token/)
  assert.doesNotMatch(value, /robot-secret-a/)
  assert.doesNotMatch(value, /robot-secret-b/)
  assert.doesNotMatch(value, /SECabcdefghijklmnop12345678/)
  assert.doesNotMatch(value, /public_token_should_not_leak/)
}

test('DingTalk P4 offline handoff chain reaches release-ready without leaking secrets', async () => {
  const tmpDir = makeTmpDir()
  const sessionDir = path.join(tmpDir, '142-session')
  const packetDir = path.join(tmpDir, 'packet')
  const envFile = path.join(tmpDir, 'p4.env')
  const fakeApi = createFakeApiServer()

  try {
    const apiBase = await fakeApi.listen()
    writeFileSync(envFile, [
      `DINGTALK_P4_API_BASE=${apiBase}`,
      'DINGTALK_P4_WEB_BASE=https://metasheet.example.test',
      'DINGTALK_P4_AUTH_TOKEN=secret-admin-token',
      'DINGTALK_P4_GROUP_A_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=robot-secret-a&timestamp=1690000000000&sign=robot-sign-a',
      'DINGTALK_P4_GROUP_B_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=robot-secret-b',
      'DINGTALK_P4_GROUP_A_SECRET=SECabcdefghijklmnop12345678',
      'DINGTALK_P4_ALLOWED_USER_IDS=user_authorized',
      'DINGTALK_P4_PERSON_USER_IDS=user_person_bound',
    ].join('\n'), 'utf8')

    const sessionResult = await runAsyncScript(sessionScript, [
      '--env-file',
      envFile,
      '--output-dir',
      sessionDir,
    ])
    assert.equal(sessionResult.status, 0, sessionResult.stderr || sessionResult.stdout)
    assertNoSecrets(sessionResult.stdout)
    assertNoSecrets(readFileSync(path.join(sessionDir, 'session-summary.json'), 'utf8'))

    fillManualEvidence(sessionDir)

    const finalizeResult = runSyncScript(sessionScript, ['--finalize', sessionDir])
    assert.equal(finalizeResult.status, 0, finalizeResult.stderr || finalizeResult.stdout)
    const finalizedSummary = JSON.parse(readFileSync(path.join(sessionDir, 'session-summary.json'), 'utf8'))
    assert.equal(finalizedSummary.overallStatus, 'pass')
    assert.equal(finalizedSummary.finalStrictStatus, 'pass')
    assert.equal(finalizedSummary.nextCommands.some((command) => command.includes('dingtalk-p4-smoke-status.mjs')), true)

    const handoffResult = runSyncScript(handoffScript, [
      '--session-dir',
      sessionDir,
      '--output-dir',
      packetDir,
    ])
    assert.equal(handoffResult.status, 0, handoffResult.stderr || handoffResult.stdout)
    const handoffSummaryText = readFileSync(path.join(packetDir, 'handoff-summary.json'), 'utf8')
    assertNoSecrets(handoffSummaryText)
    const handoffSummary = JSON.parse(handoffSummaryText)
    assert.equal(handoffSummary.status, 'pass')
    assert.equal(handoffSummary.publishCheck.status, 'pass')
    assert.equal(existsSync(path.join(packetDir, 'manifest.json')), true)

    const statusResult = runSyncScript(statusScript, [
      '--session-dir',
      sessionDir,
      '--handoff-summary',
      path.join(packetDir, 'handoff-summary.json'),
      '--require-release-ready',
    ])
    assert.equal(statusResult.status, 0, statusResult.stderr || statusResult.stdout)
    const statusText = readFileSync(path.join(sessionDir, 'smoke-status.json'), 'utf8')
    assertNoSecrets(statusText)
    const statusSummary = JSON.parse(statusText)
    assert.equal(statusSummary.overallStatus, 'release_ready')
    assert.equal(statusSummary.totals.gaps, 0)
  } finally {
    await fakeApi.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

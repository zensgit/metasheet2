import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-p4-smoke-session.mjs')

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'dingtalk-p4-smoke-session-'))
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
  const requests = []
  let groupCount = 0

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const body = await readRequestBody(req)
      requests.push({
        method: req.method,
        pathname: url.pathname,
        search: url.search,
        headers: req.headers,
        body,
      })

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

      const testSendMatch = url.pathname.match(/^\/api\/multitable\/dingtalk-groups\/(dt_group_[12])\/test-send$/)
      if (req.method === 'POST' && testSendMatch) {
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
    requests,
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

function runScript(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
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

test('dingtalk-p4-smoke-session runs preflight, API runner, and non-strict compile', async () => {
  const tmpDir = makeTmpDir()
  const outputDir = path.join(tmpDir, 'session')
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

    const result = await runScript([
      '--env-file',
      envFile,
      '--output-dir',
      outputDir,
    ])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.doesNotMatch(result.stdout, /secret-admin-token/)
    assert.doesNotMatch(result.stdout, /robot-secret-a/)
    assert.equal(existsSync(path.join(outputDir, 'preflight/preflight-summary.json')), true)
    assert.equal(existsSync(path.join(outputDir, 'workspace/evidence.json')), true)
    assert.equal(existsSync(path.join(outputDir, 'workspace/manual-evidence-checklist.md')), true)
    assert.equal(existsSync(path.join(outputDir, 'compiled/summary.json')), true)
    assert.equal(existsSync(path.join(outputDir, 'session-summary.json')), true)

    const sessionSummaryText = readFileSync(path.join(outputDir, 'session-summary.json'), 'utf8')
    assert.doesNotMatch(sessionSummaryText, /secret-admin-token/)
    assert.doesNotMatch(sessionSummaryText, /robot-secret-a/)
    assert.doesNotMatch(sessionSummaryText, /SECabcdefghijklmnop12345678/)
    const sessionSummary = JSON.parse(sessionSummaryText)
    assert.equal(sessionSummary.overallStatus, 'manual_pending')
    assert.deepEqual(sessionSummary.steps.map((step) => step.id), ['preflight', 'api-runner', 'compile'])
    assert.equal(sessionSummary.steps.every((step) => step.status === 'pass'), true)
    assert.equal(sessionSummary.pendingChecks.some((check) => check.id === 'authorized-user-submit' && check.manual), true)
    assert.equal(sessionSummary.pendingChecks.some((check) => check.id === 'send-group-message-form-link' && check.manual), true)

    const compiledSummary = JSON.parse(readFileSync(path.join(outputDir, 'compiled/summary.json'), 'utf8'))
    assert.equal(compiledSummary.overallStatus, 'fail')
    assert.equal(compiledSummary.remoteClientStatus, 'fail')
    assert.equal(fakeApi.requests.some((request) => request.pathname === '/health'), true)
    assert.equal(fakeApi.requests.some((request) => request.pathname.endsWith('/dingtalk-person-deliveries')), true)
  } finally {
    await fakeApi.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-smoke-session stops after failed preflight', () => {
  const tmpDir = makeTmpDir()
  const outputDir = path.join(tmpDir, 'session')

  try {
    const result = spawnSync(process.execPath, [
      scriptPath,
      '--skip-api',
      '--api-base',
      'http://127.0.0.1:8900',
      '--web-base',
      'https://metasheet.example.test',
      '--auth-token',
      'secret-admin-token',
      '--group-a-webhook',
      'https://oapi.dingtalk.com/robot/send?access_token=robot-secret-a',
      '--group-b-webhook',
      'https://oapi.dingtalk.com/robot/send?access_token=robot-secret-b',
      '--output-dir',
      outputDir,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    assert.equal(result.status, 1)
    assert.doesNotMatch(result.stdout, /secret-admin-token/)
    assert.equal(existsSync(path.join(outputDir, 'preflight/preflight-summary.json')), true)
    assert.equal(existsSync(path.join(outputDir, 'workspace/evidence.json')), false)
    assert.equal(existsSync(path.join(outputDir, 'compiled/summary.json')), false)

    const sessionSummary = JSON.parse(readFileSync(path.join(outputDir, 'session-summary.json'), 'utf8'))
    assert.equal(sessionSummary.overallStatus, 'fail')
    assert.deepEqual(sessionSummary.steps.map((step) => step.id), ['preflight'])
    assert.equal(sessionSummary.steps[0].status, 'fail')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

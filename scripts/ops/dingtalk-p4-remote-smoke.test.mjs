import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-p4-remote-smoke.mjs')

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'dingtalk-p4-remote-smoke-'))
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
        assert.equal(body.baseId, 'base_1')
        sendJson(res, 200, { ok: true, data: { sheet: { id: 'sheet_1', baseId: 'base_1', seeded: true } } })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/multitable/fields') {
        assert.equal(body.sheetId, 'sheet_1')
        assert.equal(body.type, 'string')
        sendJson(res, 201, { ok: true, data: { field: { id: 'field_1', name: body.name } } })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/multitable/views') {
        assert.equal(body.sheetId, 'sheet_1')
        assert.equal(body.type, 'form')
        sendJson(res, 201, {
          ok: true,
          data: {
            view: {
              id: 'view_form_1',
              sheetId: 'sheet_1',
              type: 'form',
              config: body.config,
            },
          },
        })
        return
      }

      if (req.method === 'PATCH' && url.pathname === '/api/multitable/sheets/sheet_1/views/view_form_1/form-share') {
        assert.equal(body.enabled, true)
        assert.equal(body.accessMode, 'dingtalk_granted')
        assert.deepEqual(body.allowedUserIds, ['user_authorized'])
        sendJson(res, 200, {
          ok: true,
          data: {
            enabled: true,
            status: 'active',
            accessMode: 'dingtalk_granted',
            publicToken: 'public_token_should_not_leak',
            allowedUserIds: ['user_authorized'],
          },
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/multitable/dingtalk-groups') {
        groupCount += 1
        assert.equal(body.sheetId, 'sheet_1')
        assert.equal(body.enabled, true)
        assert.match(body.webhookUrl, /access_token=robot-secret-/)
        if (body.secret) assert.match(body.secret, /^SEC/)
        sendJson(res, 201, {
          ok: true,
          data: {
            id: `dt_group_${groupCount}`,
            name: body.name,
            enabled: true,
            sheetId: 'sheet_1',
          },
        })
        return
      }

      const testSendMatch = url.pathname.match(/^\/api\/multitable\/dingtalk-groups\/(dt_group_[12])\/test-send$/)
      if (req.method === 'POST' && testSendMatch) {
        assert.equal(url.searchParams.get('sheetId'), 'sheet_1')
        assert.match(body.subject, /P4 smoke/)
        sendJson(res, 204)
        return
      }

      const manualDeliveriesMatch = url.pathname.match(/^\/api\/multitable\/dingtalk-groups\/(dt_group_[12])\/deliveries$/)
      if (req.method === 'GET' && manualDeliveriesMatch) {
        assert.equal(url.searchParams.get('sheetId'), 'sheet_1')
        sendJson(res, 200, {
          ok: true,
          data: {
            deliveries: [
              {
                id: `delivery_${manualDeliveriesMatch[1]}`,
                destinationId: manualDeliveriesMatch[1],
                sourceType: 'manual_test',
                status: 'success',
              },
            ],
          },
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/multitable/sheets/sheet_1/automations') {
        assert.equal(body.triggerType, 'record.created')
        if (body.actionType === 'send_dingtalk_group_message') {
          assert.deepEqual(body.actionConfig.destinationIds, ['dt_group_1', 'dt_group_2'])
          assert.equal(body.actionConfig.publicFormViewId, 'view_form_1')
          sendJson(res, 200, { ok: true, data: { rule: { id: 'rule_group_1', actionType: body.actionType } } })
          return
        }
        if (body.actionType === 'send_dingtalk_person_message') {
          assert.deepEqual(body.actionConfig.userIds, ['user_person_bound'])
          assert.equal(body.actionConfig.publicFormViewId, 'view_form_1')
          sendJson(res, 200, { ok: true, data: { rule: { id: 'rule_person_1', actionType: body.actionType } } })
          return
        }
      }

      const testRunMatch = url.pathname.match(/^\/api\/multitable\/sheets\/sheet_1\/automations\/(rule_group_1|rule_person_1)\/test$/)
      if (req.method === 'POST' && testRunMatch) {
        const actionType = testRunMatch[1] === 'rule_group_1'
          ? 'send_dingtalk_group_message'
          : 'send_dingtalk_person_message'
        sendJson(res, 200, {
          id: `exec_${testRunMatch[1]}`,
          ruleId: testRunMatch[1],
          triggeredBy: 'manual_test',
          status: 'success',
          steps: [{ actionType, status: 'success' }],
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
            deliveries: [
              { id: 'rule_person_delivery_1', userId: 'user_person_bound', status: 'success' },
            ],
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
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

test('dingtalk-p4-remote-smoke runs API chain, writes pending manual gates, and redacts secrets', async () => {
  const tmpDir = makeTmpDir()
  const outputDir = path.join(tmpDir, 'smoke')
  const fakeApi = createFakeApiServer()

  try {
    const apiBase = await fakeApi.listen()
    const result = await runScript([
      '--api-base',
      apiBase,
      '--web-base',
      'https://metasheet.example.test',
      '--auth-token',
      'secret-admin-token',
      '--group-a-webhook',
      'https://oapi.dingtalk.com/robot/send?access_token=robot-secret-a&timestamp=1690000000000&sign=abc-sign-a',
      '--group-b-webhook',
      'https://oapi.dingtalk.com/robot/send?access_token=robot-secret-b&timestamp=1690000000001&sign=abc-sign-b',
      '--group-a-secret',
      'SECabcdefghijklmnop12345678',
      '--allowed-user',
      'user_authorized',
      '--person-user',
      'user_person_bound',
      '--output-dir',
      outputDir,
    ])

    assert.equal(result.code, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /Wrote .*evidence\.json/)
    assert.doesNotMatch(result.stdout, /secret-admin-token/)
    assert.doesNotMatch(result.stdout, /robot-secret-a/)
    assert.doesNotMatch(result.stdout, /SECabcdefghijklmnop12345678/)
    assert.equal(existsSync(path.join(outputDir, 'evidence.json')), true)
    assert.equal(existsSync(path.join(outputDir, 'manual-evidence-checklist.md')), true)
    assert.equal(existsSync(path.join(outputDir, 'artifacts/send-group-message-form-link')), true)
    assert.equal(existsSync(path.join(outputDir, 'artifacts/authorized-user-submit')), true)
    assert.equal(existsSync(path.join(outputDir, 'artifacts/unauthorized-user-denied')), true)
    assert.equal(existsSync(path.join(outputDir, 'artifacts/no-email-user-create-bind')), true)

    const evidenceText = readFileSync(path.join(outputDir, 'evidence.json'), 'utf8')
    assert.doesNotMatch(evidenceText, /secret-admin-token/)
    assert.doesNotMatch(evidenceText, /robot-secret-a/)
    assert.doesNotMatch(evidenceText, /robot-secret-b/)
    assert.doesNotMatch(evidenceText, /abc-sign-a/)
    assert.doesNotMatch(evidenceText, /1690000000000/)
    assert.doesNotMatch(evidenceText, /SECabcdefghijklmnop12345678/)
    assert.doesNotMatch(evidenceText, /public_token_should_not_leak/)

    const evidence = JSON.parse(evidenceText)
    const byId = new Map(evidence.checks.map((check) => [check.id, check]))
    assert.equal(byId.get('create-table-form').status, 'pass')
    assert.equal(byId.get('bind-two-dingtalk-groups').status, 'pass')
    assert.equal(byId.get('set-form-dingtalk-granted').status, 'pass')
    assert.equal(byId.get('send-group-message-form-link').status, 'pending')
    assert.equal(byId.get('delivery-history-group-person').status, 'pass')
    assert.equal(byId.get('authorized-user-submit').status, 'pending')
    assert.equal(byId.get('unauthorized-user-denied').status, 'pending')
    assert.equal(byId.get('no-email-user-create-bind').status, 'pending')
    assert.equal(byId.get('send-group-message-form-link').evidence.source, 'manual-client')
    assert.equal(byId.get('send-group-message-form-link').evidence.operator, '')
    assert.equal(byId.get('send-group-message-form-link').evidence.apiBootstrap.groupRuleDeliveryCount, 2)
    assert.equal(byId.get('authorized-user-submit').evidence.source, 'manual-client')
    assert.equal(byId.get('no-email-user-create-bind').evidence.source, 'manual-admin')
    assert.deepEqual(
      byId.get('no-email-user-create-bind').evidence.suggestedArtifacts,
      [
        'artifacts/no-email-user-create-bind/admin-create-bind-result.png',
        'artifacts/no-email-user-create-bind/account-linked-after-refresh.png',
        'artifacts/no-email-user-create-bind/temp-password-redacted-note.txt',
      ],
    )
    assert.equal(byId.get('no-email-user-create-bind').evidence.adminEvidence.temporaryPasswordRedacted, true)
    assert.equal(byId.get('delivery-history-group-person').evidence.personRuleDeliveryCount, 1)

    const checklist = readFileSync(path.join(outputDir, 'manual-evidence-checklist.md'), 'utf8')
    assert.match(checklist, /manual-client/)
    assert.match(checklist, /manual-admin/)
    assert.match(checklist, /artifacts\/authorized-user-submit/)
    assert.match(checklist, /admin-create-bind-result\.png/)
    assert.match(checklist, /temporary password/)

    assert.equal(fakeApi.requests.every((request) => request.headers.authorization === 'Bearer secret-admin-token'), true)
    assert.equal(fakeApi.requests.some((request) => request.pathname.endsWith('/dingtalk-person-deliveries')), true)
  } finally {
    await fakeApi.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-remote-smoke keeps delivery history pending without person recipients', async () => {
  const tmpDir = makeTmpDir()
  const outputDir = path.join(tmpDir, 'smoke')
  const fakeApi = createFakeApiServer()

  try {
    const apiBase = await fakeApi.listen()
    const result = await runScript([
      '--api-base',
      apiBase,
      '--auth-token',
      'secret-admin-token',
      '--group-a-webhook',
      'https://oapi.dingtalk.com/robot/send?access_token=robot-secret-a',
      '--group-b-webhook',
      'https://oapi.dingtalk.com/robot/send?access_token=robot-secret-b',
      '--allowed-user',
      'user_authorized',
      '--output-dir',
      outputDir,
    ])

    assert.equal(result.code, 0, result.stderr || result.stdout)
    const evidence = JSON.parse(readFileSync(path.join(outputDir, 'evidence.json'), 'utf8'))
    const deliveryCheck = evidence.checks.find((check) => check.id === 'delivery-history-group-person')
    assert.equal(deliveryCheck.status, 'pending')
    assert.equal(deliveryCheck.evidence.groupRuleDeliveryCount, 2)
    assert.equal(deliveryCheck.evidence.personUserCount, 0)
    assert.equal(fakeApi.requests.some((request) => request.pathname.endsWith('/dingtalk-person-deliveries')), false)
  } finally {
    await fakeApi.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-remote-smoke rejects missing auth token before making requests', () => {
  const result = spawnSync(process.execPath, [
    scriptPath,
    '--api-base',
    'http://127.0.0.1:9',
    '--group-a-webhook',
    'https://oapi.dingtalk.com/robot/send?access_token=robot-secret-a',
    '--group-b-webhook',
    'https://oapi.dingtalk.com/robot/send?access_token=robot-secret-b',
    '--allowed-user',
    'user_authorized',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /--auth-token/)
  assert.doesNotMatch(result.stderr, /robot-secret-a/)
})

test('dingtalk-p4-remote-smoke rejects malformed DingTalk robot secrets', () => {
  const result = spawnSync(process.execPath, [
    scriptPath,
    '--api-base',
    'http://127.0.0.1:9',
    '--auth-token',
    'secret-admin-token',
    '--group-a-webhook',
    'https://oapi.dingtalk.com/robot/send?access_token=robot-secret-a',
    '--group-b-webhook',
    'https://oapi.dingtalk.com/robot/send?access_token=robot-secret-b',
    '--group-a-secret',
    'not-a-secret',
    '--allowed-user',
    'user_authorized',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /--group-a-secret/)
  assert.doesNotMatch(result.stderr, /secret-admin-token/)
})

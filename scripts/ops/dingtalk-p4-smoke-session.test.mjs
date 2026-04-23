import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-p4-smoke-session.mjs')
const requiredIds = [
  'create-table-form',
  'bind-two-dingtalk-groups',
  'set-form-dingtalk-granted',
  'send-group-message-form-link',
  'authorized-user-submit',
  'unauthorized-user-denied',
  'delivery-history-group-person',
  'no-email-user-create-bind',
]
const manualClientIds = new Set([
  'send-group-message-form-link',
  'authorized-user-submit',
  'unauthorized-user-denied',
])
const manualAdminIds = new Set(['no-email-user-create-bind'])

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'dingtalk-p4-smoke-session-'))
}

function manualArtifactRefForCheck(id) {
  return `artifacts/${id}/evidence.txt`
}

function makePassingEvidenceForCheck(id) {
  if (manualClientIds.has(id) || manualAdminIds.has(id)) {
    return {
      source: manualClientIds.has(id) ? 'manual-client' : 'manual-admin',
      operator: 'qa',
      performedAt: '2026-04-22T15:00:00.000Z',
      summary: `${id} manual evidence ok`,
      artifacts: [manualArtifactRefForCheck(id)],
      ...(id === 'unauthorized-user-denied'
        ? {
            submitBlocked: true,
            recordInsertDelta: 0,
            blockedReason: 'Visible error showed the user is not in the allowlist.',
          }
        : {}),
      ...(id === 'no-email-user-create-bind'
        ? {
            adminEvidence: {
              emailWasBlank: true,
              createdLocalUserId: 'local_no_email_001',
              boundDingTalkExternalId: 'dt_no_email_001',
              accountLinkedAfterRefresh: true,
              temporaryPasswordRedacted: true,
            },
          }
        : {}),
    }
  }
  return {
    source: 'api-bootstrap',
    notes: `${id} ok`,
  }
}

function writeCompletedSession(sessionDir, options = {}) {
  const workspaceDir = path.join(sessionDir, 'workspace')
  mkdirSync(workspaceDir, { recursive: true })
  const evidence = {
    runId: 'remote-20260422',
    executedAt: '2026-04-22T15:00:00.000Z',
    environment: {
      apiBase: 'http://142.171.239.56:8900',
      webBase: 'http://142.171.239.56:8081',
      operator: 'qa',
    },
    checks: requiredIds.map((id) => ({
      id,
      status: 'pass',
      evidence: makePassingEvidenceForCheck(id),
    })),
    artifacts: [],
  }
  writeFileSync(path.join(workspaceDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  for (const id of [...manualClientIds, ...manualAdminIds]) {
    const artifactRef = manualArtifactRefForCheck(id)
    if (options.omitArtifactFor === id) continue
    const artifactPath = path.join(workspaceDir, artifactRef)
    mkdirSync(path.dirname(artifactPath), { recursive: true })
    writeFileSync(artifactPath, `${id} evidence\n`, 'utf8')
  }
  writeFileSync(path.join(sessionDir, 'session-summary.json'), `${JSON.stringify({
    tool: 'dingtalk-p4-smoke-session',
    runId: 'existing-session',
    generatedAt: '2026-04-22T15:00:00.000Z',
    steps: [
      { id: 'preflight', label: 'preflight', status: 'pass', exitCode: 0 },
      { id: 'api-runner', label: 'api runner', status: 'pass', exitCode: 0 },
      { id: 'compile', label: 'compile', status: 'pass', exitCode: 0 },
    ],
  }, null, 2)}\n`, 'utf8')
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

test('dingtalk-p4-smoke-session writes an editable env template', () => {
  const tmpDir = makeTmpDir()
  const envPath = path.join(tmpDir, 'dingtalk-p4.env')

  try {
    const result = spawnSync(process.execPath, [
      scriptPath,
      '--init-env-template',
      envPath,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Wrote .*dingtalk-p4\.env/)
    const content = readFileSync(envPath, 'utf8')
    assert.match(content, /DINGTALK_P4_API_BASE=/)
    assert.match(content, /DINGTALK_P4_AUTH_TOKEN=/)
    assert.match(content, /DINGTALK_P4_GROUP_A_WEBHOOK=/)
    assert.match(content, /DINGTALK_P4_ALLOWED_USER_IDS=/)
    assert.match(content, /DINGTALK_P4_AUTHORIZED_USER_ID=/)
    assert.match(content, /DINGTALK_P4_UNAUTHORIZED_USER_ID=/)
    assert.match(content, /DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID=/)
    assert.doesNotMatch(content, /secret-admin-token/)
    assert.equal(statSync(envPath).mode & 0o777, 0o600)
    assert.equal(existsSync(path.join(tmpDir, 'session-summary.json')), false)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

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
      'DINGTALK_P4_AUTHORIZED_USER_ID=user_authorized',
      'DINGTALK_P4_UNAUTHORIZED_USER_ID=user_unauthorized',
      'DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID=dt_no_email_001',
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
    assert.equal(existsSync(path.join(outputDir, 'smoke-status.json')), true)
    assert.equal(existsSync(path.join(outputDir, 'smoke-todo.md')), true)

    const sessionSummaryText = readFileSync(path.join(outputDir, 'session-summary.json'), 'utf8')
    assert.doesNotMatch(sessionSummaryText, /secret-admin-token/)
    assert.doesNotMatch(sessionSummaryText, /robot-secret-a/)
    assert.doesNotMatch(sessionSummaryText, /SECabcdefghijklmnop12345678/)
    const sessionSummary = JSON.parse(sessionSummaryText)
    assert.equal(sessionSummary.overallStatus, 'manual_pending')
    assert.equal(sessionSummary.sessionPhase, 'bootstrap')
    assert.equal(sessionSummary.finalStrictStatus, 'not_run')
    assert.deepEqual(sessionSummary.manualTargets, {
      authorizedUserId: 'user_authorized',
      unauthorizedUserId: 'user_unauthorized',
      noEmailDingTalkExternalId: 'dt_no_email_001',
    })
    assert.deepEqual(sessionSummary.steps.map((step) => step.id), ['preflight', 'api-runner', 'compile', 'status-report'])
    assert.equal(sessionSummary.steps.every((step) => step.status === 'pass'), true)
    assert.equal(sessionSummary.statusReport.status, 'pass')
    assert.match(sessionSummary.statusReport.smokeTodoMd, /smoke-todo\.md$/)
    assert.equal(sessionSummary.statusReport.remoteSmokeTodos.remaining > 0, true)
    assert.equal(sessionSummary.pendingChecks.some((check) => check.id === 'authorized-user-submit' && check.manual), true)
    assert.equal(sessionSummary.pendingChecks.some((check) => check.id === 'send-group-message-form-link' && check.manual), true)
    assert.equal(sessionSummary.nextCommands.some((command) => command.includes('dingtalk-p4-smoke-status.mjs')), true)
    assert.equal(sessionSummary.nextCommands.some((command) => command.includes('dingtalk-p4-evidence-record.mjs')), true)
    assert.equal(sessionSummary.nextCommands.some((command) => command.includes('dingtalk-p4-final-closeout.mjs')), false)
    assert.equal(sessionSummary.nextCommands.some((command) => command.includes('--finalize')), true)

    const compiledSummary = JSON.parse(readFileSync(path.join(outputDir, 'compiled/summary.json'), 'utf8'))
    assert.equal(compiledSummary.overallStatus, 'fail')
    assert.equal(compiledSummary.remoteClientStatus, 'fail')
    const evidence = JSON.parse(readFileSync(path.join(outputDir, 'workspace/evidence.json'), 'utf8'))
    assert.equal(evidence.manualTargets.unauthorizedUserId, 'user_unauthorized')
    assert.equal(evidence.manualTargets.noEmailDingTalkExternalId, 'dt_no_email_001')
    const preflightSummary = JSON.parse(readFileSync(path.join(outputDir, 'preflight/preflight-summary.json'), 'utf8'))
    assert.equal(preflightSummary.checks.find((check) => check.id === 'manual-targets-declared').status, 'pass')
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
    assert.deepEqual(sessionSummary.steps.map((step) => step.id), ['preflight', 'status-report'])
    assert.equal(sessionSummary.steps[0].status, 'fail')
    assert.equal(sessionSummary.steps[1].status, 'pass')
    assert.equal(existsSync(path.join(outputDir, 'smoke-todo.md')), true)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-smoke-session finalizes completed manual evidence with strict compile', () => {
  const tmpDir = makeTmpDir()
  const outputDir = path.join(tmpDir, 'session')

  try {
    writeCompletedSession(outputDir)

    const result = spawnSync(process.execPath, [
      scriptPath,
      '--finalize',
      outputDir,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(existsSync(path.join(outputDir, 'compiled/summary.json')), true)
    const compiledSummary = JSON.parse(readFileSync(path.join(outputDir, 'compiled/summary.json'), 'utf8'))
    assert.equal(compiledSummary.overallStatus, 'pass')

    const sessionSummary = JSON.parse(readFileSync(path.join(outputDir, 'session-summary.json'), 'utf8'))
    assert.equal(sessionSummary.runId, 'existing-session')
    assert.equal(sessionSummary.overallStatus, 'pass')
    assert.equal(sessionSummary.sessionPhase, 'finalize')
    assert.equal(sessionSummary.finalStrictStatus, 'pass')
    assert.deepEqual(sessionSummary.steps.map((step) => step.id), ['preflight', 'api-runner', 'compile', 'strict-compile', 'status-report'])
    assert.equal(sessionSummary.steps.at(-1).status, 'pass')
    assert.equal(sessionSummary.pendingChecks.length, 0)
    assert.equal(sessionSummary.finalStrictSummary.overallStatus, 'pass')
    assert.equal(sessionSummary.statusReport.status, 'pass')
    assert.equal(sessionSummary.statusReport.remoteSmokeTodos.remaining, 0)
    assert.equal(existsSync(path.join(outputDir, 'smoke-status.json')), true)
    assert.equal(existsSync(path.join(outputDir, 'smoke-todo.md')), true)
    assert.equal(sessionSummary.nextCommands.some((command) => command.includes('dingtalk-p4-smoke-status.mjs')), true)
    assert.equal(sessionSummary.nextCommands.some((command) => command.includes('--strict')), false)
    assert.equal(sessionSummary.nextCommands.some((command) => command.includes('dingtalk-p4-final-closeout.mjs')), true)
    assert.equal(sessionSummary.nextCommands.some((command) => command.includes('dingtalk-p4-final-handoff.mjs')), true)
    assert.equal(sessionSummary.nextCommands.some((command) => command.includes('--require-dingtalk-p4-pass')), true)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-smoke-session finalize fails when strict evidence is incomplete', () => {
  const tmpDir = makeTmpDir()
  const outputDir = path.join(tmpDir, 'session')

  try {
    writeCompletedSession(outputDir, { omitArtifactFor: 'authorized-user-submit' })

    const result = spawnSync(process.execPath, [
      scriptPath,
      '--finalize',
      outputDir,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    assert.equal(result.status, 1)
    assert.match(result.stdout, /session-summary\.json/)
    const sessionSummary = JSON.parse(readFileSync(path.join(outputDir, 'session-summary.json'), 'utf8'))
    assert.equal(sessionSummary.overallStatus, 'fail')
    assert.equal(sessionSummary.sessionPhase, 'finalize')
    assert.equal(sessionSummary.finalStrictStatus, 'fail')
    const strictStep = sessionSummary.steps.find((step) => step.id === 'strict-compile')
    assert.equal(strictStep.status, 'fail')
    assert.equal(sessionSummary.steps.at(-1).id, 'status-report')
    assert.equal(sessionSummary.steps.at(-1).status, 'pass')
    assert.equal(sessionSummary.finalStrictSummary.overallStatus, 'fail')
    assert.equal(sessionSummary.statusReport.status, 'pass')
    assert.equal(existsSync(path.join(outputDir, 'smoke-todo.md')), true)
    assert.equal(sessionSummary.finalStrictSummary.manualEvidenceIssueCount > 0, true)
    assert.equal(sessionSummary.nextCommands.some((command) => command.includes('dingtalk-p4-evidence-record.mjs')), true)
    assert.equal(sessionSummary.nextCommands.some((command) => command.includes('dingtalk-p4-final-closeout.mjs')), false)
    assert.equal(sessionSummary.nextCommands.some((command) => command.includes('--finalize')), true)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-smoke-session rejects finalize output-dir ambiguity', () => {
  const result = spawnSync(process.execPath, [
    scriptPath,
    '--finalize',
    'output/session',
    '--output-dir',
    'output/other',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /--output-dir is not used with --finalize/)
})

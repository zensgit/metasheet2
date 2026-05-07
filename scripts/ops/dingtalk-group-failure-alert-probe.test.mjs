import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-group-failure-alert-probe.mjs')
const testToken = 'test-admin-token-for-probe'

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'dingtalk-group-failure-alert-probe-'))
}

function runScript(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
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
    child.on('close', (status) => {
      resolve({ status, stdout, stderr })
    })
  })
}

function baseRule(overrides = {}) {
  return {
    id: 'rule_1',
    name: 'Notify DingTalk group',
    enabled: true,
    actionType: 'send_dingtalk_group_message',
    actionConfig: {
      destinationId: 'group_1',
      titleTemplate: 'Please fill',
      bodyTemplate: 'Open form',
      notifyRuleCreatorOnFailure: true,
    },
    actions: [],
    ...overrides,
  }
}

async function withServer(payloads, fn) {
  const requests = []
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization })
    if (req.headers.authorization !== `Bearer ${testToken}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { message: 'Authentication required' } }))
      return
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const body = payloads[url.pathname]
    if (!body) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { message: `No fixture for ${url.pathname}` } }))
      return
    }
    if (typeof body.__status === 'number') {
      const { __status, ...payload } = body
      res.writeHead(__status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const apiBase = `http://127.0.0.1:${address.port}`
  try {
    return await fn(apiBase, requests)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function withSlowServer(delayMs, fn) {
  const requests = []
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization })
    setTimeout(() => {
      if (res.destroyed) return
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        success: true,
        user: { id: 'admin_1', role: 'admin' },
      }))
    }, delayMs)
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const apiBase = `http://127.0.0.1:${address.port}`
  try {
    return await fn(apiBase, requests)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function getClosedLocalPort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise((resolve) => server.close(resolve))
  return address.port
}

function makePayloads({ rule = baseRule(), groupDeliveries = [], personDeliveries = [] } = {}) {
  return {
    '/api/auth/me': {
      success: true,
      user: { id: 'admin_1', role: 'admin' },
    },
    '/api/multitable/sheets/sheet_1/automations': {
      ok: true,
      data: { rules: [rule] },
    },
    '/api/multitable/sheets/sheet_1/automations/rule_1/dingtalk-group-deliveries': {
      ok: true,
      data: { deliveries: groupDeliveries },
    },
    '/api/multitable/sheets/sheet_1/automations/rule_1/dingtalk-person-deliveries': {
      ok: true,
      data: { deliveries: personDeliveries },
    },
  }
}

test('dingtalk-group-failure-alert-probe passes a deployed acceptance snapshot and redacts token inputs', async () => {
  const tmpDir = makeTmpDir()
  try {
    const tokenFile = path.join(tmpDir, 'token.txt')
    const outputDir = path.join(tmpDir, 'out')
    writeFileSync(tokenFile, `${testToken}\n`, 'utf8')

    await withServer(makePayloads({
      groupDeliveries: [{
        id: 'gd_1',
        destinationId: 'group_1',
        destinationName: 'Ops Group',
        sourceType: 'automation',
        subject: 'Please fill',
        success: false,
        httpStatus: 200,
        errorMessage: 'keyword mismatch',
        automationRuleId: 'rule_1',
        recordId: 'record_1',
        createdAt: '2026-05-07T00:00:00.000Z',
      }],
      personDeliveries: [{
        id: 'pd_1',
        localUserId: 'creator_1',
        dingtalkUserId: 'dt_creator_1',
        sourceType: 'automation',
        subject: 'MetaSheet DingTalk group delivery failed',
        success: true,
        status: 'success',
        automationRuleId: 'rule_1',
        recordId: 'record_1',
        createdAt: '2026-05-07T00:00:02.000Z',
      }],
    }), async (apiBase, requests) => {
      const result = await runScript([
        '--api-base', apiBase,
        '--auth-token-file', tokenFile,
        '--sheet-id', 'sheet_1',
        '--rule-id', 'rule_1',
        '--acceptance',
        '--expect-person-status', 'success',
        '--output-dir', outputDir,
      ])

      assert.equal(result.status, 0, result.stderr)
      assert.doesNotMatch(result.stdout, new RegExp(testToken))
      assert.ok(requests.every((request) => request.authorization === `Bearer ${testToken}`))
      assert.ok(existsSync(path.join(outputDir, 'summary.json')))
      assert.ok(existsSync(path.join(outputDir, 'summary.md')))
      const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
      assert.equal(summary.status, 'PASS')
      assert.equal(summary.rule.notifyRuleCreatorOnFailure[0], true)
      assert.equal(summary.groupDeliveries.failedCount, 1)
      assert.equal(summary.personDeliveries.latestCreatorAlert.status, 'success')
      assert.doesNotMatch(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'), new RegExp(testToken))
      assert.doesNotMatch(readFileSync(path.join(outputDir, 'summary.md'), 'utf8'), new RegExp(testToken))
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-group-failure-alert-probe matches a custom creator alert subject', async () => {
  const tmpDir = makeTmpDir()
  try {
    const outputDir = path.join(tmpDir, 'out')
    await withServer(makePayloads({
      groupDeliveries: [{
        id: 'gd_1',
        sourceType: 'automation',
        subject: 'Please fill',
        success: false,
        automationRuleId: 'rule_1',
        recordId: 'record_1',
      }],
      personDeliveries: [{
        id: 'pd_1',
        sourceType: 'automation',
        subject: 'Custom DingTalk failure alert subject',
        status: 'success',
        success: true,
        automationRuleId: 'rule_1',
        recordId: 'record_1',
      }],
    }), async (apiBase) => {
      const result = await runScript([
        '--api-base', apiBase,
        '--auth-token', testToken,
        '--sheet-id', 'sheet_1',
        '--rule-id', 'rule_1',
        '--record-id', 'record_1',
        '--acceptance',
        '--expect-person-status', 'success',
        '--alert-subject', 'Custom DingTalk failure alert subject',
        '--output-dir', outputDir,
      ])

      assert.equal(result.status, 0, result.stderr)
      const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
      assert.equal(summary.status, 'PASS')
      assert.equal(summary.expectations.alertSubject, 'Custom DingTalk failure alert subject')
      assert.equal(summary.personDeliveries.matchingCreatorAlertCount, 1)
      assert.equal(summary.personDeliveries.latestCreatorAlert.subject, 'Custom DingTalk failure alert subject')
      assert.match(readFileSync(path.join(outputDir, 'summary.md'), 'utf8'), /Custom DingTalk failure alert subject/)
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-group-failure-alert-probe reads custom creator alert subject from env', async () => {
  const tmpDir = makeTmpDir()
  try {
    const outputDir = path.join(tmpDir, 'out')
    await withServer(makePayloads({
      groupDeliveries: [{
        id: 'gd_1',
        sourceType: 'automation',
        subject: 'Please fill',
        success: false,
        automationRuleId: 'rule_1',
        recordId: 'record_1',
      }],
      personDeliveries: [{
        id: 'pd_1',
        sourceType: 'automation',
        subject: 'Env configured DingTalk failure alert',
        status: 'success',
        success: true,
        automationRuleId: 'rule_1',
        recordId: 'record_1',
      }],
    }), async (apiBase) => {
      const result = await runScript([
        '--api-base', apiBase,
        '--auth-token', testToken,
        '--sheet-id', 'sheet_1',
        '--rule-id', 'rule_1',
        '--record-id', 'record_1',
        '--acceptance',
        '--expect-person-status', 'success',
        '--output-dir', outputDir,
      ], {
        DINGTALK_GROUP_FAILURE_ALERT_SUBJECT: 'Env configured DingTalk failure alert',
      })

      assert.equal(result.status, 0, result.stderr)
      const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
      assert.equal(summary.status, 'PASS')
      assert.equal(summary.expectations.alertSubject, 'Env configured DingTalk failure alert')
      assert.equal(summary.personDeliveries.matchingCreatorAlertCount, 1)
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-group-failure-alert-probe requires the configured creator alert subject to match', async () => {
  const tmpDir = makeTmpDir()
  try {
    const outputDir = path.join(tmpDir, 'out')
    await withServer(makePayloads({
      groupDeliveries: [{
        id: 'gd_1',
        sourceType: 'automation',
        subject: 'Please fill',
        success: false,
        automationRuleId: 'rule_1',
        recordId: 'record_1',
      }],
      personDeliveries: [{
        id: 'pd_1',
        sourceType: 'automation',
        subject: 'Unrelated person notification',
        status: 'success',
        success: true,
        automationRuleId: 'rule_1',
        recordId: 'record_1',
      }],
    }), async (apiBase) => {
      const result = await runScript([
        '--api-base', apiBase,
        '--auth-token', testToken,
        '--sheet-id', 'sheet_1',
        '--rule-id', 'rule_1',
        '--record-id', 'record_1',
        '--acceptance',
        '--output-dir', outputDir,
      ])

      assert.notEqual(result.status, 0)
      const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
      assert.equal(summary.status, 'BLOCKED')
      assert.deepEqual(summary.failures.map((failure) => failure.code), ['CREATOR_ALERT_NOT_FOUND'])
      assert.equal(summary.personDeliveries.matchingCreatorAlertCount, 0)
      assert.equal(summary.personDeliveries.latestCreatorAlert, null)
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-group-failure-alert-probe ignores non-automation deliveries for creator alert counts', async () => {
  const tmpDir = makeTmpDir()
  try {
    const outputDir = path.join(tmpDir, 'out')
    await withServer(makePayloads({
      groupDeliveries: [{
        id: 'gd_1',
        sourceType: 'automation',
        subject: 'Please fill',
        success: false,
        automationRuleId: 'rule_1',
        recordId: 'record_1',
      }],
      personDeliveries: [{
        id: 'pd_manual',
        sourceType: 'manual_test',
        subject: 'MetaSheet DingTalk group delivery failed',
        status: 'success',
        success: true,
        automationRuleId: 'rule_1',
        recordId: 'record_1',
      }],
    }), async (apiBase) => {
      const result = await runScript([
        '--api-base', apiBase,
        '--auth-token', testToken,
        '--sheet-id', 'sheet_1',
        '--rule-id', 'rule_1',
        '--record-id', 'record_1',
        '--acceptance',
        '--output-dir', outputDir,
      ])

      assert.notEqual(result.status, 0)
      const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
      assert.equal(summary.status, 'BLOCKED')
      assert.deepEqual(summary.failures.map((failure) => failure.code), ['CREATOR_ALERT_NOT_FOUND'])
      assert.equal(summary.personDeliveries.creatorAlertCount, 0)
      assert.equal(summary.personDeliveries.matchingCreatorAlertCount, 0)
      assert.equal(summary.personDeliveries.latestCreatorAlert, null)
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-group-failure-alert-probe fails when the selected rule is not alert-enabled', async () => {
  const tmpDir = makeTmpDir()
  try {
    const outputDir = path.join(tmpDir, 'out')
    await withServer(makePayloads({
      rule: baseRule({
        actionConfig: {
          destinationId: 'group_1',
          titleTemplate: 'Please fill',
          bodyTemplate: 'Open form',
          notifyRuleCreatorOnFailure: false,
        },
      }),
    }), async (apiBase, requests) => {
      const result = await runScript([
        '--api-base', apiBase,
        '--auth-token', testToken,
        '--sheet-id', 'sheet_1',
        '--rule-id', 'rule_1',
        '--output-dir', outputDir,
      ])

      assert.notEqual(result.status, 0)
      const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
      assert.equal(summary.status, 'BLOCKED')
      assert.deepEqual(summary.failures.map((failure) => failure.code), ['ALERT_NOT_ENABLED'])
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-group-failure-alert-probe blocks acceptance when the selected rule is disabled', async () => {
  const tmpDir = makeTmpDir()
  try {
    const outputDir = path.join(tmpDir, 'out')
    await withServer(makePayloads({
      rule: baseRule({ enabled: false }),
      groupDeliveries: [{
        id: 'gd_1',
        sourceType: 'automation',
        subject: 'Please fill',
        success: false,
        automationRuleId: 'rule_1',
        recordId: 'record_1',
      }],
      personDeliveries: [{
        id: 'pd_1',
        sourceType: 'automation',
        subject: 'MetaSheet DingTalk group delivery failed',
        status: 'success',
        success: true,
        automationRuleId: 'rule_1',
        recordId: 'record_1',
      }],
    }), async (apiBase) => {
      const result = await runScript([
        '--api-base', apiBase,
        '--auth-token', testToken,
        '--sheet-id', 'sheet_1',
        '--rule-id', 'rule_1',
        '--record-id', 'record_1',
        '--acceptance',
        '--expect-person-status', 'success',
        '--output-dir', outputDir,
      ])

      assert.notEqual(result.status, 0)
      const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
      assert.equal(summary.status, 'BLOCKED')
      assert.equal(summary.rule.enabled, false)
      assert.deepEqual(summary.failures.map((failure) => failure.code), ['RULE_DISABLED'])
      assert.equal(summary.failures[0].detail.enabled, false)
      assert.match(summary.nextActions[0], /Enable the selected automation rule/)
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-group-failure-alert-probe scopes explicit disabled checks to the requested record', async () => {
  const tmpDir = makeTmpDir()
  try {
    const outputDir = path.join(tmpDir, 'out')
    await withServer(makePayloads({
      rule: baseRule({
        actionConfig: {
          destinationId: 'group_1',
          titleTemplate: 'Please fill',
          bodyTemplate: 'Open form',
          notifyRuleCreatorOnFailure: false,
        },
      }),
      groupDeliveries: [{
        id: 'gd_disabled',
        destinationId: 'group_1',
        destinationName: 'Ops Group',
        sourceType: 'automation',
        subject: 'Please fill',
        success: false,
        httpStatus: 200,
        errorMessage: 'keyword mismatch',
        automationRuleId: 'rule_1',
        recordId: 'record_disabled',
        createdAt: '2026-05-07T00:00:10.000Z',
      }],
      personDeliveries: [{
        id: 'pd_old',
        localUserId: 'creator_1',
        dingtalkUserId: 'dt_creator_1',
        sourceType: 'automation',
        subject: 'MetaSheet DingTalk group delivery failed',
        success: true,
        status: 'success',
        automationRuleId: 'rule_1',
        recordId: 'record_old_enabled_run',
        createdAt: '2026-05-07T00:00:02.000Z',
      }],
    }), async (apiBase, requests) => {
      const result = await runScript([
        '--api-base', apiBase,
        '--auth-token', testToken,
        '--sheet-id', 'sheet_1',
        '--rule-id', 'rule_1',
        '--record-id', 'record_disabled',
        '--expect-alert', 'disabled',
        '--expect-person-status', 'none',
        '--require-group-failure',
        '--output-dir', outputDir,
      ])

      assert.equal(result.status, 0, result.stderr)
      const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
      assert.equal(summary.status, 'PASS')
      assert.equal(summary.expectations.recordId, 'record_disabled')
      assert.equal(summary.groupDeliveries.failedCount, 1)
      assert.equal(summary.groupDeliveries.matchingFailedCount, 1)
      assert.equal(summary.personDeliveries.creatorAlertCount, 1)
      assert.equal(summary.personDeliveries.matchingCreatorAlertCount, 0)
      assert.equal(summary.personDeliveries.latestCreatorAlert, null)
      assert.ok(requests.some((request) => {
        return String(request.url).includes('/dingtalk-group-deliveries?')
          && String(request.url).includes('recordId=record_disabled')
      }))
      assert.ok(requests.some((request) => {
        return String(request.url).includes('/dingtalk-person-deliveries?')
          && String(request.url).includes('recordId=record_disabled')
      }))
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-group-failure-alert-probe acceptance mode requires delivery evidence', async () => {
  const tmpDir = makeTmpDir()
  try {
    const outputDir = path.join(tmpDir, 'out')
    await withServer(makePayloads(), async (apiBase) => {
      const result = await runScript([
        '--api-base', apiBase,
        '--auth-token', testToken,
        '--sheet-id', 'sheet_1',
        '--rule-id', 'rule_1',
        '--acceptance',
        '--output-dir', outputDir,
      ])

      assert.notEqual(result.status, 0)
      const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
      assert.equal(summary.status, 'BLOCKED')
      assert.deepEqual(
        summary.failures.map((failure) => failure.code),
        ['GROUP_FAILURE_NOT_FOUND', 'CREATOR_ALERT_NOT_FOUND'],
      )
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-group-failure-alert-probe writes a redacted summary for auth failures', async () => {
  const tmpDir = makeTmpDir()
  try {
    const outputDir = path.join(tmpDir, 'out')
    await withServer(makePayloads(), async (apiBase) => {
      const result = await runScript([
        '--api-base', apiBase,
        '--auth-token', 'expired-admin-token-value',
        '--sheet-id', 'sheet_1',
        '--rule-id', 'rule_1',
        '--output-dir', outputDir,
      ])

      assert.notEqual(result.status, 0)
      assert.doesNotMatch(result.stdout, /expired-admin-token-value/)
      assert.ok(existsSync(path.join(outputDir, 'summary.json')))
      assert.ok(existsSync(path.join(outputDir, 'summary.md')))
      const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
      assert.equal(summary.status, 'BLOCKED')
      assert.deepEqual(summary.failures.map((failure) => failure.code), ['AUTH_FAILED'])
      assert.match(summary.nextActions[0], /Refresh the admin token file/)
      assert.doesNotMatch(readFileSync(path.join(outputDir, 'summary.md'), 'utf8'), /expired-admin-token-value/)
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-group-failure-alert-probe writes API path detail for 404 failures', async () => {
  const tmpDir = makeTmpDir()
  try {
    const outputDir = path.join(tmpDir, 'out')
    const leakedAccessToken = '1234567890abcdef' + '1234567890abcdef'
    const leakedSecret = 'SEC' + '1234567890abcdef1234567890abcdef'
    const leakedJwt = [
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'eyJzdWIiOiJ0ZXN0LXVzZXIiLCJyb2xlIjoiYWRtaW4ifQ',
      'signatureplaceholder1234567890',
    ].join('.')
    const payloads = makePayloads({
      groupDeliveries: [{
        id: 'gd_1',
        sourceType: 'automation',
        subject: 'Please fill',
        success: false,
        automationRuleId: 'rule_1',
        recordId: 'record_1',
      }],
    })
    payloads['/api/multitable/sheets/sheet_1/automations/rule_1/dingtalk-person-deliveries'] = {
      __status: 404,
      ok: false,
      error: {
        message: `delivery route missing access_token=${leakedAccessToken} ${leakedSecret} ${leakedJwt}`,
        webhook: `https://oapi.dingtalk.com/robot/send?access_token=${leakedAccessToken}`,
      },
    }

    await withServer(payloads, async (apiBase) => {
      const result = await runScript([
        '--api-base', apiBase,
        '--auth-token', testToken,
        '--sheet-id', 'sheet_1',
        '--rule-id', 'rule_1',
        '--record-id', 'record_1',
        '--acceptance',
        '--output-dir', outputDir,
      ])

      assert.notEqual(result.status, 0)
      const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
      assert.equal(summary.status, 'BLOCKED')
      assert.deepEqual(summary.failures.map((failure) => failure.code), ['API_NOT_FOUND'])
      assert.equal(summary.failures[0].detail.status, 404)
      assert.match(summary.failures[0].detail.pathname, /dingtalk-person-deliveries/)
      assert.match(summary.failures[0].detail.response.error.message, /delivery route missing/)
      assert.equal(summary.failures[0].detail.response.error.webhook, '<redacted>')
      const summaryJsonText = readFileSync(path.join(outputDir, 'summary.json'), 'utf8')
      const summaryMarkdownText = readFileSync(path.join(outputDir, 'summary.md'), 'utf8')
      assert.doesNotMatch(summaryJsonText, new RegExp(leakedAccessToken))
      assert.doesNotMatch(summaryJsonText, new RegExp(leakedSecret))
      assert.doesNotMatch(summaryJsonText, new RegExp(leakedJwt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      assert.doesNotMatch(summaryMarkdownText, new RegExp(leakedAccessToken))
      assert.doesNotMatch(summaryMarkdownText, new RegExp(leakedSecret))
      assert.doesNotMatch(summaryMarkdownText, new RegExp(leakedJwt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      assert.match(summaryMarkdownText, /dingtalk-person-deliveries/)
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-group-failure-alert-probe writes API path detail for timed out requests', async () => {
  const tmpDir = makeTmpDir()
  try {
    const outputDir = path.join(tmpDir, 'out')
    await withSlowServer(300, async (apiBase) => {
      const result = await runScript([
        '--api-base', apiBase,
        '--auth-token', testToken,
        '--sheet-id', 'sheet_1',
        '--rule-id', 'rule_1',
        '--timeout-ms', '100',
        '--output-dir', outputDir,
      ])

      assert.notEqual(result.status, 0)
      const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
      assert.equal(summary.status, 'BLOCKED')
      assert.deepEqual(summary.failures.map((failure) => failure.code), ['API_TIMEOUT'])
      assert.equal(summary.failures[0].detail.pathname, '/api/auth/me')
      assert.equal(summary.failures[0].detail.timeoutMs, 100)
      assert.match(summary.nextActions[0], /larger --timeout-ms/)
      assert.match(readFileSync(path.join(outputDir, 'summary.md'), 'utf8'), /\/api\/auth\/me/)
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-group-failure-alert-probe writes API path detail for network failures', async () => {
  const tmpDir = makeTmpDir()
  try {
    const outputDir = path.join(tmpDir, 'out')
    const closedPort = await getClosedLocalPort()
    const result = await runScript([
      '--api-base', `http://127.0.0.1:${closedPort}`,
      '--auth-token', testToken,
      '--sheet-id', 'sheet_1',
      '--rule-id', 'rule_1',
      '--timeout-ms', '1000',
      '--output-dir', outputDir,
    ])

    assert.notEqual(result.status, 0)
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
    assert.equal(summary.status, 'BLOCKED')
    assert.deepEqual(summary.failures.map((failure) => failure.code), ['API_NETWORK_ERROR'])
    assert.equal(summary.failures[0].detail.pathname, '/api/auth/me')
    assert.match(summary.failures[0].detail.originalMessage, /fetch failed|ECONNREFUSED/i)
    assert.match(summary.nextActions[0], /host and port/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-group-failure-alert-probe writes a summary when rule selection is ambiguous', async () => {
  const tmpDir = makeTmpDir()
  try {
    const outputDir = path.join(tmpDir, 'out')
    await withServer(makePayloads({
      rule: baseRule(),
    }), async (apiBase) => {
      const payloads = makePayloads()
      payloads['/api/multitable/sheets/sheet_1/automations'] = {
        ok: true,
        data: {
          rules: [
            baseRule({ id: 'rule_1', name: 'First group rule' }),
            baseRule({ id: 'rule_2', name: 'Second group rule' }),
          ],
        },
      }

      await withServer(payloads, async (ambiguousApiBase) => {
        const result = await runScript([
          '--api-base', ambiguousApiBase,
          '--auth-token', testToken,
          '--sheet-id', 'sheet_1',
          '--output-dir', outputDir,
        ])

        assert.notEqual(result.status, 0)
        const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
        assert.equal(summary.status, 'BLOCKED')
        assert.deepEqual(summary.failures.map((failure) => failure.code), ['MULTIPLE_GROUP_RULES'])
        assert.deepEqual(
          summary.failures[0].detail.candidateRules.map((rule) => rule.id),
          ['rule_1', 'rule_2'],
        )
        assert.match(summary.nextActions[0], /Pass --rule-id/)
        const markdown = readFileSync(path.join(outputDir, 'summary.md'), 'utf8')
        assert.match(markdown, /rule_1/)
        assert.match(markdown, /rule_2/)
      })
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-group-failure-alert-probe writes a summary when requested rule is missing', async () => {
  const tmpDir = makeTmpDir()
  try {
    const outputDir = path.join(tmpDir, 'out')
    await withServer(makePayloads(), async (apiBase) => {
      const result = await runScript([
        '--api-base', apiBase,
        '--auth-token', testToken,
        '--sheet-id', 'sheet_1',
        '--rule-id', 'missing_rule',
        '--output-dir', outputDir,
      ])

      assert.notEqual(result.status, 0)
      assert.ok(existsSync(path.join(outputDir, 'summary.md')))
      const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
      assert.equal(summary.status, 'BLOCKED')
      assert.deepEqual(summary.failures.map((failure) => failure.code), ['RULE_NOT_FOUND'])
      assert.equal(summary.ruleId, 'missing_rule')
      assert.deepEqual(
        summary.failures[0].detail.availableGroupRules.map((rule) => rule.id),
        ['rule_1'],
      )
      assert.match(summary.nextActions[0], /Confirm the automation rule id/)
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-group-failure-alert-probe writes rule inventory when no group rule exists', async () => {
  const tmpDir = makeTmpDir()
  try {
    const outputDir = path.join(tmpDir, 'out')
    await withServer(makePayloads({
      rule: baseRule({
        id: 'rule_notify',
        name: 'Notify only',
        actionType: 'send_notification',
        actionConfig: { message: 'hello' },
      }),
    }), async (apiBase) => {
      const result = await runScript([
        '--api-base', apiBase,
        '--auth-token', testToken,
        '--sheet-id', 'sheet_1',
        '--output-dir', outputDir,
      ])

      assert.notEqual(result.status, 0)
      const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
      assert.equal(summary.status, 'BLOCKED')
      assert.deepEqual(summary.failures.map((failure) => failure.code), ['NO_GROUP_RULE'])
      assert.equal(summary.failures[0].detail.totalRuleCount, 1)
      assert.deepEqual(
        summary.failures[0].detail.availableRules.map((rule) => rule.id),
        ['rule_notify'],
      )
      assert.match(readFileSync(path.join(outputDir, 'summary.md'), 'utf8'), /rule_notify/)
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-group-failure-alert-probe writes a summary when token file is missing', async () => {
  const tmpDir = makeTmpDir()
  try {
    const outputDir = path.join(tmpDir, 'out')
    const missingTokenFile = path.join(tmpDir, 'missing-token.txt')
    const result = await runScript([
      '--auth-token-file', missingTokenFile,
      '--sheet-id', 'sheet_1',
      '--output-dir', outputDir,
    ])

    assert.notEqual(result.status, 0)
    assert.ok(existsSync(path.join(outputDir, 'summary.md')))
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
    assert.equal(summary.status, 'BLOCKED')
    assert.deepEqual(summary.failures.map((failure) => failure.code), ['AUTH_TOKEN_FILE_NOT_FOUND'])
    assert.equal(summary.sheetId, 'sheet_1')
    assert.match(summary.nextActions[0], /token file path exists/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-group-failure-alert-probe writes a summary when auth token is omitted', async () => {
  const tmpDir = makeTmpDir()
  try {
    const outputDir = path.join(tmpDir, 'out')
    const result = await runScript([
      '--sheet-id', 'sheet_1',
      '--output-dir', outputDir,
    ])

    assert.notEqual(result.status, 0)
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
    assert.equal(summary.status, 'BLOCKED')
    assert.deepEqual(summary.failures.map((failure) => failure.code), ['AUTH_TOKEN_REQUIRED'])
    assert.match(summary.nextActions[0], /--auth-token-file/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-group-failure-alert-probe writes a summary when sheet id is omitted', async () => {
  const tmpDir = makeTmpDir()
  try {
    const outputDir = path.join(tmpDir, 'out')
    const result = await runScript([
      '--auth-token', testToken,
      '--output-dir', outputDir,
    ])

    assert.notEqual(result.status, 0)
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
    assert.equal(summary.status, 'BLOCKED')
    assert.deepEqual(summary.failures.map((failure) => failure.code), ['SHEET_ID_REQUIRED'])
    assert.equal(summary.sheetId, '')
    assert.match(summary.nextActions[0], /--sheet-id/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-group-failure-alert-probe writes a summary for invalid arguments', async () => {
  const tmpDir = makeTmpDir()
  try {
    const outputDir = path.join(tmpDir, 'out')
    const result = await runScript([
      '--auth-token', testToken,
      '--sheet-id', 'sheet_1',
      '--expect-alert', 'maybe',
      '--output-dir', outputDir,
    ])

    assert.notEqual(result.status, 0)
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
    assert.equal(summary.status, 'BLOCKED')
    assert.deepEqual(summary.failures.map((failure) => failure.code), ['INVALID_ARGUMENTS'])
    assert.match(summary.failures[0].message, /--expect-alert/)
    assert.match(summary.nextActions[0], /Fix the probe arguments/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-group-failure-alert-probe can skip auth-me while keeping a redacted pass summary', async () => {
  const tmpDir = makeTmpDir()
  try {
    const outputDir = path.join(tmpDir, 'out')
    await withServer(makePayloads({
      groupDeliveries: [{
        id: 'gd_1',
        sourceType: 'automation',
        subject: 'Please fill',
        success: false,
        automationRuleId: 'rule_1',
        recordId: 'record_1',
      }],
      personDeliveries: [{
        id: 'pd_1',
        sourceType: 'automation',
        subject: 'MetaSheet DingTalk group delivery failed',
        status: 'success',
        success: true,
        automationRuleId: 'rule_1',
        recordId: 'record_1',
      }],
    }), async (apiBase, requests) => {
      const result = await runScript([
        '--api-base', apiBase,
        '--auth-token', testToken,
        '--sheet-id', 'sheet_1',
        '--rule-id', 'rule_1',
        '--record-id', 'record_1',
        '--acceptance',
        '--skip-auth-me',
        '--output-dir', outputDir,
      ])

      assert.equal(result.status, 0, result.stderr)
      assert.ok(requests.every((request) => request.url !== '/api/auth/me'))
      const summary = JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8'))
      assert.equal(summary.status, 'PASS')
      assert.equal(summary.auth.checked, false)
      assert.equal(summary.groupDeliveries.matchingFailedCount, 1)
      assert.equal(summary.personDeliveries.matchingCreatorAlertCount, 1)
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

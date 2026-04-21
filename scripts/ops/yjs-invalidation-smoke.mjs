#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '../..')
const webRequire = createRequire(path.join(repoRoot, 'apps/web/package.json'))
const { io } = webRequire('socket.io-client')

const DEFAULT_TIMEOUT_MS = 10_000

export function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

export function buildDefaultPatchUrl(baseUrl, recordId) {
  return `${normalizeBaseUrl(baseUrl)}/api/multitable/records/${encodeURIComponent(recordId)}`
}

export function renderInvalidationSmokeMarkdown(report) {
  const checks = Array.isArray(report?.checks) ? report.checks : []
  const failing = checks.filter((check) => check && check.ok === false)
  const lines = [
    '# Yjs Invalidation Smoke',
    '',
    `- Overall: **${report?.ok === false ? 'FAIL' : 'PASS'}**`,
    `- API base: \`${report?.apiBase || 'missing'}\``,
    `- Record ID: \`${report?.recordId || 'missing'}\``,
    `- Field ID: \`${report?.fieldId || 'missing'}\``,
    `- Patch URL: \`${report?.patchUrl || 'missing'}\``,
    `- Started at: \`${report?.startedAt || 'missing'}\``,
    `- Finished at: \`${report?.finishedAt || 'missing'}\``,
    `- JSON report: \`${report?.reportPath || 'missing'}\``,
    `- Markdown report: \`${report?.reportMdPath || 'missing'}\``,
    '',
    '## Checks',
    '',
    `- Total checks: \`${checks.length}\``,
    failing.length
      ? `- Failing checks: ${failing.map((check) => `\`${check.name}\``).join(', ')}`
      : '- Failing checks: none',
  ]

  if (report?.error) {
    lines.push(`- Error: \`${report.error}\``)
  }

  lines.push('', '## Check Results', '')
  for (const check of checks) {
    lines.push(`- \`${check.name}\`: **${check.ok ? 'PASS' : 'FAIL'}**`)
  }

  if (report?.invalidatedPayload) {
    lines.push('', '## Invalidation Payload', '', '```json')
    lines.push(JSON.stringify(report.invalidatedPayload, null, 2))
    lines.push('```')
  }

  return `${lines.join('\n')}\n`
}

export function parseConfig(env = process.env) {
  const apiBase = normalizeBaseUrl(env.API_BASE || env.BASE_URL || env.STAGING_BASE_URL)
  const recordId = String(env.RECORD_ID || '').trim()
  const fieldId = String(env.FIELD_ID || '').trim()
  const sheetId = String(env.SHEET_ID || '').trim()
  const token = String(env.AUTH_TOKEN || env.TOKEN || '').trim()
  const patchValue = env.PATCH_VALUE ?? `yjs-invalidation-smoke-${new Date().toISOString()}`
  const patchUrl = String(env.PATCH_URL || (apiBase && recordId ? buildDefaultPatchUrl(apiBase, recordId) : '')).trim()
  const outputDir = String(env.OUTPUT_DIR || `output/yjs-invalidation-smoke/${new Date().toISOString().replace(/[:.]/g, '-')}`)
  const reportPath = String(env.REPORT_JSON || path.join(outputDir, 'report.json'))
  const reportMdPath = String(env.REPORT_MD || path.join(outputDir, 'report.md'))
  const timeoutMs = Number(env.TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
  const confirmWrite = env.CONFIRM_WRITE === '1' || env.CONFIRM_WRITE === 'true'
  const allowDevToken = env.ALLOW_DEV_TOKEN === '1' || env.ALLOW_DEV_TOKEN === 'true'

  return {
    apiBase,
    recordId,
    fieldId,
    sheetId,
    token,
    patchValue,
    patchUrl,
    outputDir,
    reportPath,
    reportMdPath,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    confirmWrite,
    allowDevToken,
  }
}

export function validateConfig(config) {
  const missing = []
  if (!config.apiBase) missing.push('API_BASE or BASE_URL')
  if (!config.recordId) missing.push('RECORD_ID')
  if (!config.fieldId) missing.push('FIELD_ID')
  if (!config.patchUrl) missing.push('PATCH_URL')
  if (!config.token && !config.allowDevToken) missing.push('AUTH_TOKEN or TOKEN')
  if (!config.confirmWrite) missing.push('CONFIRM_WRITE=1')
  return missing
}

function authHeaders(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    ...extra,
  }
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options)
  const text = await res.text()
  let json = null
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = { raw: text }
    }
  }
  return { res, json }
}

async function resolveToken(config, record) {
  if (config.token) {
    record('auth.token-present', true)
    return config.token
  }

  const perms = [
    'multitable:read',
    'multitable:write',
    'multitable:admin',
  ].join(',')
  const url = `${config.apiBase}/api/auth/dev-token?userId=yjs-smoke-admin&roles=admin&perms=${encodeURIComponent(perms)}`
  const result = await fetchJson(url)
  const token = result.json?.token
  const ok = Boolean(result.res.ok && token)
  record('auth.dev-token', ok, { status: result.res.status })
  if (!ok) throw new Error('Unable to obtain dev token; provide AUTH_TOKEN/TOKEN for staging')
  return token
}

function waitForSocketConnect(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Socket connect timeout'))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timeout)
      socket.off('connect', onConnect)
      socket.off('connect_error', onConnectError)
    }
    const onConnect = () => {
      cleanup()
      resolve()
    }
    const onConnectError = (error) => {
      cleanup()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    socket.once('connect', onConnect)
    socket.once('connect_error', onConnectError)
  })
}

function waitForEvent(socket, event, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    let lastPayload = null
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for ${event}: ${JSON.stringify(lastPayload)}`))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timeout)
      socket.off(event, onEvent)
      socket.off('yjs:error', onError)
    }
    const onEvent = (payload) => {
      lastPayload = payload
      if (!predicate(payload)) return
      cleanup()
      resolve(payload)
    }
    const onError = (payload) => {
      cleanup()
      reject(new Error(`yjs:error: ${JSON.stringify(payload)}`))
    }
    socket.on(event, onEvent)
    socket.on('yjs:error', onError)
  })
}

async function patchRecord(config, token) {
  const body = {
    ...(config.sheetId ? { sheetId: config.sheetId } : {}),
    data: {
      [config.fieldId]: config.patchValue,
    },
  }
  return fetchJson(config.patchUrl, {
    method: 'PATCH',
    headers: authHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  })
}

async function fetchRecord(config, token) {
  const url = buildDefaultPatchUrl(config.apiBase, config.recordId)
  return fetchJson(url, {
    headers: authHeaders(token),
  })
}

function writeArtifacts(report) {
  fs.mkdirSync(path.dirname(report.reportPath), { recursive: true })
  fs.writeFileSync(report.reportPath, JSON.stringify(report, null, 2))
  fs.mkdirSync(path.dirname(report.reportMdPath), { recursive: true })
  fs.writeFileSync(report.reportMdPath, renderInvalidationSmokeMarkdown(report))
}

export async function runInvalidationSmoke(config = parseConfig()) {
  const report = {
    ok: true,
    apiBase: config.apiBase,
    recordId: config.recordId,
    fieldId: config.fieldId,
    patchUrl: config.patchUrl,
    outputDir: path.resolve(config.outputDir),
    reportPath: path.resolve(config.reportPath),
    reportMdPath: path.resolve(config.reportMdPath),
    startedAt: new Date().toISOString(),
    checks: [],
  }

  const record = (name, ok, details = {}) => {
    report.checks.push({ name, ok, ...details })
    if (!ok) report.ok = false
  }

  const missing = validateConfig(config)
  if (missing.length > 0) {
    record('config.required-env', false, { missing })
    report.error = `Missing required configuration: ${missing.join(', ')}`
    report.finishedAt = new Date().toISOString()
    writeArtifacts(report)
    return report
  }
  record('config.required-env', true)

  let socket = null
  try {
    const token = await resolveToken(config, record)

    const health = await fetchJson(`${config.apiBase}/health`)
    record('api.health', health.res.ok, { status: health.res.status })
    if (!health.res.ok) throw new Error(`Health check failed: ${health.res.status}`)

    const recordResult = await fetchRecord(config, token)
    record('api.record.get', recordResult.res.ok && recordResult.json?.ok !== false, {
      status: recordResult.res.status,
    })
    if (!recordResult.res.ok || recordResult.json?.ok === false) {
      throw new Error(`Record preflight failed: ${recordResult.res.status}`)
    }

    const socketUrl = `${config.apiBase}/yjs`
    socket = io(socketUrl, {
      transports: ['websocket'],
      auth: { token },
      forceNew: true,
      reconnection: false,
      timeout: config.timeoutMs,
    })
    await waitForSocketConnect(socket, config.timeoutMs)
    record('socket.connect', true, { socketUrl })

    const syncMessage = waitForEvent(
      socket,
      'yjs:message',
      (payload) => payload?.recordId === config.recordId && Array.isArray(payload?.data),
      config.timeoutMs,
    )
    socket.emit('yjs:subscribe', { recordId: config.recordId })
    await syncMessage
    record('socket.subscribe-sync', true)

    const invalidated = waitForEvent(
      socket,
      'yjs:invalidated',
      (payload) => payload?.recordId === config.recordId && payload?.reason === 'rest-write',
      config.timeoutMs,
    )
    const patchResult = await patchRecord(config, token)
    record('api.record.patch', patchResult.res.ok && patchResult.json?.ok !== false, {
      status: patchResult.res.status,
    })
    if (!patchResult.res.ok || patchResult.json?.ok === false) {
      invalidated.catch(() => {
        // Avoid an unhandled timeout rejection after the REST failure has
        // already determined the smoke result.
      })
      throw new Error(`Record patch failed: ${patchResult.res.status} ${JSON.stringify(patchResult.json)}`)
    }

    report.invalidatedPayload = await invalidated
    record('socket.invalidated', true)
  } catch (error) {
    report.ok = false
    report.error = error instanceof Error ? error.message : String(error)
  } finally {
    try {
      socket?.disconnect()
    } catch {
      // ignore teardown errors
    }
    report.finishedAt = new Date().toISOString()
    writeArtifacts(report)
  }

  return report
}

async function main() {
  const report = await runInvalidationSmoke(parseConfig())
  console.log(renderInvalidationSmokeMarkdown(report))
  process.exitCode = report.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

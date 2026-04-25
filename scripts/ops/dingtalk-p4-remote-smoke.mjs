#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_OUTPUT_ROOT = 'output/dingtalk-p4-remote-smoke'
const DEFAULT_API_BASE = 'http://127.0.0.1:8900'

const REQUIRED_CHECKS = [
  {
    id: 'create-table-form',
    label: 'Create a table and form view',
  },
  {
    id: 'bind-two-dingtalk-groups',
    label: 'Bind at least two DingTalk groups',
  },
  {
    id: 'set-form-dingtalk-granted',
    label: 'Set the form to dingtalk_granted',
  },
  {
    id: 'send-group-message-form-link',
    label: 'Send a DingTalk group message with a form link',
  },
  {
    id: 'authorized-user-submit',
    label: 'Verify an authorized user can open and submit',
  },
  {
    id: 'unauthorized-user-denied',
    label: 'Verify an unauthorized user cannot submit and no record is inserted',
  },
  {
    id: 'delivery-history-group-person',
    label: 'Verify group and person delivery history',
  },
  {
    id: 'no-email-user-create-bind',
    label: 'Create and bind a no-email DingTalk-synced local user',
  },
]
const MANUAL_EVIDENCE_REQUIREMENTS = [
  {
    id: 'send-group-message-form-link',
    source: 'manual-client',
    label: 'real DingTalk group message visibility',
  },
  {
    id: 'authorized-user-submit',
    source: 'manual-client',
    label: 'authorized DingTalk-bound user submit',
  },
  {
    id: 'unauthorized-user-denied',
    source: 'manual-client',
    label: 'unauthorized DingTalk-bound user denial',
  },
  {
    id: 'no-email-user-create-bind',
    source: 'manual-admin',
    label: 'no-email DingTalk-synced account creation and binding',
    suggestedArtifacts: [
      'artifacts/no-email-user-create-bind/admin-create-bind-result.png',
      'artifacts/no-email-user-create-bind/account-linked-after-refresh.png',
      'artifacts/no-email-user-create-bind/temp-password-redacted-note.txt',
    ],
  },
]
const MANUAL_EVIDENCE_BY_ID = new Map(MANUAL_EVIDENCE_REQUIREMENTS.map((requirement) => [requirement.id, requirement]))

function printHelp() {
  console.log(`Usage: node scripts/ops/dingtalk-p4-remote-smoke.mjs [options]

Runs the API-addressable part of the DingTalk P4 remote smoke against a deployed
backend. It creates a disposable table/form, binds two DingTalk group robot
destinations, sets the form to dingtalk_granted, runs group automation, queries
delivery history, and writes evidence.json.

It does not prove real DingTalk client identity switching. The authorized-user,
unauthorized-user, and no-email account checks stay pending until an operator
fills them from manual evidence.

Required inputs:
  --auth-token <token>             Bearer token for an admin/table owner
  --group-a-webhook <url>          DingTalk group A robot webhook; https://oapi.dingtalk.com/robot/send?access_token=...
  --group-b-webhook <url>          DingTalk group B robot webhook; https://oapi.dingtalk.com/robot/send?access_token=...
  --allowed-user <id>              Local user allowed to fill; repeatable
  --allowed-member-group <id>      Allowed local member group; repeatable
                                  Provide at least one allowed user or group.

Options:
  --api-base <url>                 Backend API base, default ${DEFAULT_API_BASE}
  --web-base <url>                 Public app base for evidence notes
  --group-a-secret <secret>        Optional DingTalk group A SEC... secret
  --group-b-secret <secret>        Optional DingTalk group B SEC... secret
  --person-user <id>               Optional local user for person-message smoke; repeatable
  --authorized-user <id>           DingTalk-bound allowed local user for manual submit proof
  --unauthorized-user <id>         DingTalk-bound non-allowlisted local user for denial proof
  --no-email-dingtalk-external-id <id>
                                  Synced DingTalk account without local user/email for admin proof
  --output-dir <dir>               Output directory, default ${DEFAULT_OUTPUT_ROOT}/<run-id>
  --timeout-ms <ms>                Per-request timeout, default 15000
  --skip-health                    Skip GET /health
  --skip-test-send                 Create group destinations but skip group test-send
  --skip-automation-test-run       Create automation rules but skip test-run
  --help                           Show this help

Environment fallbacks:
  DINGTALK_P4_API_BASE, API_BASE
  DINGTALK_P4_WEB_BASE, WEB_BASE, PUBLIC_APP_URL
  DINGTALK_P4_AUTH_TOKEN, ADMIN_TOKEN, AUTH_TOKEN
  DINGTALK_P4_GROUP_A_WEBHOOK, DINGTALK_GROUP_A_WEBHOOK
  DINGTALK_P4_GROUP_B_WEBHOOK, DINGTALK_GROUP_B_WEBHOOK
  DINGTALK_P4_GROUP_A_SECRET, DINGTALK_GROUP_A_SECRET
  DINGTALK_P4_GROUP_B_SECRET, DINGTALK_GROUP_B_SECRET
  DINGTALK_P4_ALLOWED_USER_IDS, DINGTALK_P4_ALLOWED_MEMBER_GROUP_IDS
  DINGTALK_P4_PERSON_USER_IDS, DINGTALK_P4_AUTHORIZED_USER_ID,
  DINGTALK_P4_UNAUTHORIZED_USER_ID, DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID
`)
}

function readRequiredValue(argv, index, flag) {
  const next = argv[index + 1]
  if (!next || next.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return next
}

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function splitList(value) {
  if (!value) return []
  return Array.from(new Set(
    String(value)
      .split(/[\n,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  ))
}

function appendList(list, value) {
  const values = splitList(value)
  for (const item of values) {
    if (!list.includes(item)) list.push(item)
  }
}

function parseArgs(argv) {
  const opts = {
    apiBase: envValue('DINGTALK_P4_API_BASE', 'API_BASE') || DEFAULT_API_BASE,
    webBase: envValue('DINGTALK_P4_WEB_BASE', 'WEB_BASE', 'PUBLIC_APP_URL'),
    authToken: envValue('DINGTALK_P4_AUTH_TOKEN', 'ADMIN_TOKEN', 'AUTH_TOKEN'),
    groupAWebhook: envValue('DINGTALK_P4_GROUP_A_WEBHOOK', 'DINGTALK_GROUP_A_WEBHOOK'),
    groupBWebhook: envValue('DINGTALK_P4_GROUP_B_WEBHOOK', 'DINGTALK_GROUP_B_WEBHOOK'),
    groupASecret: envValue('DINGTALK_P4_GROUP_A_SECRET', 'DINGTALK_GROUP_A_SECRET'),
    groupBSecret: envValue('DINGTALK_P4_GROUP_B_SECRET', 'DINGTALK_GROUP_B_SECRET'),
    allowedUserIds: splitList(envValue('DINGTALK_P4_ALLOWED_USER_IDS', 'DINGTALK_P4_ALLOWED_USER_ID')),
    allowedMemberGroupIds: splitList(envValue('DINGTALK_P4_ALLOWED_MEMBER_GROUP_IDS', 'DINGTALK_P4_ALLOWED_MEMBER_GROUP_ID')),
    personUserIds: splitList(envValue('DINGTALK_P4_PERSON_USER_IDS', 'DINGTALK_P4_PERSON_USER_ID')),
    authorizedUserId: envValue('DINGTALK_P4_AUTHORIZED_USER_ID'),
    unauthorizedUserId: envValue('DINGTALK_P4_UNAUTHORIZED_USER_ID'),
    noEmailDingTalkExternalId: envValue('DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID'),
    outputDir: null,
    timeoutMs: 15_000,
    skipHealth: false,
    skipTestSend: false,
    skipAutomationTestRun: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--api-base':
        opts.apiBase = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--web-base':
        opts.webBase = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--auth-token':
        opts.authToken = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--group-a-webhook':
        opts.groupAWebhook = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--group-b-webhook':
        opts.groupBWebhook = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--group-a-secret':
        opts.groupASecret = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--group-b-secret':
        opts.groupBSecret = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--allowed-user':
        appendList(opts.allowedUserIds, readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--allowed-member-group':
        appendList(opts.allowedMemberGroupIds, readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--person-user':
        appendList(opts.personUserIds, readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--authorized-user':
        opts.authorizedUserId = readRequiredValue(argv, i, arg).trim()
        i += 1
        break
      case '--unauthorized-user':
        opts.unauthorizedUserId = readRequiredValue(argv, i, arg).trim()
        i += 1
        break
      case '--no-email-dingtalk-external-id':
        opts.noEmailDingTalkExternalId = readRequiredValue(argv, i, arg).trim()
        i += 1
        break
      case '--output-dir':
        opts.outputDir = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--timeout-ms':
        opts.timeoutMs = Number.parseInt(readRequiredValue(argv, i, arg), 10)
        i += 1
        break
      case '--skip-health':
        opts.skipHealth = true
        break
      case '--skip-test-send':
        opts.skipTestSend = true
        break
      case '--skip-automation-test-run':
        opts.skipAutomationTestRun = true
        break
      case '--help':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  opts.apiBase = normalizeBaseUrl(opts.apiBase, '--api-base')
  if (opts.webBase) opts.webBase = normalizeBaseUrl(opts.webBase, '--web-base')

  return opts
}

function normalizeBaseUrl(value, label) {
  try {
    const url = new URL(value)
    url.pathname = url.pathname.replace(/\/+$/, '')
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    throw new Error(`${label} must be a valid URL`)
  }
}

function validateWebhookUrl(value, label) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') {
      throw new Error('must use HTTPS')
    }
    if (url.hostname !== 'oapi.dingtalk.com' || url.pathname !== '/robot/send') {
      throw new Error('must be a DingTalk robot URL from https://oapi.dingtalk.com/robot/send')
    }
    if (!url.searchParams.get('access_token')?.trim()) {
      throw new Error('must include access_token')
    }
    return url.toString()
  } catch (error) {
    throw new Error(`${label} must be a valid DingTalk robot webhook URL: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function robotWebhookToken(value) {
  try {
    return new URL(value).searchParams.get('access_token')?.trim() ?? ''
  } catch {
    return ''
  }
}

function validateSecret(value, label) {
  const secret = typeof value === 'string' ? value.trim() : ''
  if (!secret) return ''
  if (!/^SEC[A-Za-z0-9+/=_-]{8,}$/.test(secret)) {
    throw new Error(`${label} must look like a DingTalk SEC... robot secret`)
  }
  return secret
}

function validateOptions(opts) {
  if (!opts.authToken) throw new Error('--auth-token or DINGTALK_P4_AUTH_TOKEN is required')
  opts.groupAWebhook = validateWebhookUrl(opts.groupAWebhook, '--group-a-webhook')
  opts.groupBWebhook = validateWebhookUrl(opts.groupBWebhook, '--group-b-webhook')
  if (robotWebhookToken(opts.groupAWebhook) === robotWebhookToken(opts.groupBWebhook)) {
    throw new Error('--group-a-webhook and --group-b-webhook must use different DingTalk robot access_token values')
  }
  opts.groupASecret = validateSecret(opts.groupASecret, '--group-a-secret')
  opts.groupBSecret = validateSecret(opts.groupBSecret, '--group-b-secret')
  if (opts.allowedUserIds.length === 0 && opts.allowedMemberGroupIds.length === 0) {
    throw new Error('at least one --allowed-user or --allowed-member-group is required for dingtalk_granted')
  }
  const authorizedUserId = opts.authorizedUserId || opts.allowedUserIds[0] || ''
  if (opts.unauthorizedUserId && (opts.unauthorizedUserId === authorizedUserId || opts.allowedUserIds.includes(opts.unauthorizedUserId))) {
    throw new Error('--unauthorized-user must be distinct from --authorized-user and must not be included in --allowed-user')
  }
  if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs < 1_000 || opts.timeoutMs > 120_000) {
    throw new Error('--timeout-ms must be an integer between 1000 and 120000')
  }
}

function nowIso() {
  return new Date().toISOString()
}

function makeRunId() {
  return `dingtalk-p4-api-${new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')}`
}

function redactString(value) {
  return String(value)
    .replace(/(access_token=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/(publicToken=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/([?&](?:sign|timestamp)=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/((?:client_secret|DINGTALK_CLIENT_SECRET|DINGTALK_STATE_SECRET)=)[^\s&]+/gi, '$1<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/\bSEC[A-Za-z0-9+/=_-]{8,}\b/g, 'SEC<redacted>')
    .replace(/\beyJ[A-Za-z0-9._-]{20,}\b/g, '<jwt:redacted>')
}

function shouldFullyRedactKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!normalized) return false
  if (normalized.includes('webhookurl') || normalized === 'url' || normalized.endsWith('link')) return false
  return normalized.includes('secret')
    || normalized.includes('password')
    || normalized.includes('authorization')
    || normalized.includes('bearer')
    || normalized.includes('jwt')
    || normalized.endsWith('token')
    || normalized.includes('accesstoken')
    || normalized.includes('refreshtoken')
}

function sanitizeValue(value, key = '') {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    if (key && shouldFullyRedactKey(key)) return '<redacted>'
    return redactString(value)
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item))
  if (typeof value === 'object') {
    const next = {}
    for (const [entryKey, entryValue] of Object.entries(value)) {
      next[entryKey] = sanitizeValue(entryValue, entryKey)
    }
    return next
  }
  return value
}

function artifactDirForCheck(checkId) {
  return path.join('artifacts', checkId)
}

function manualTargets(opts) {
  return {
    authorizedUserId: opts.authorizedUserId || opts.allowedUserIds[0] || '',
    unauthorizedUserId: opts.unauthorizedUserId || '',
    noEmailDingTalkExternalId: opts.noEmailDingTalkExternalId || '',
  }
}

function makeManualEvidenceSkeleton(checkId, notes, extra = {}) {
  const requirement = MANUAL_EVIDENCE_BY_ID.get(checkId)
  if (!requirement) {
    return {
      notes,
      ...extra,
    }
  }

  const { adminEvidence: extraAdminEvidence, ...restExtra } = extra
  const adminEvidence = checkId === 'no-email-user-create-bind'
    ? {
        emailWasBlank: null,
        createdLocalUserId: '',
        boundDingTalkExternalId: '',
        accountLinkedAfterRefresh: null,
        temporaryPasswordRedacted: true,
        ...(extraAdminEvidence ?? {}),
      }
    : null

  return {
    source: requirement.source,
    operator: '',
    performedAt: '',
    summary: '',
    artifacts: [],
    notes,
    instructions: `Required before strict pass: ${requirement.label}; place evidence files under ${artifactDirForCheck(checkId)}/ and reference them with relative paths.`,
    suggestedArtifacts: requirement.suggestedArtifacts ?? [],
    ...(adminEvidence ? { adminEvidence } : {}),
    ...restExtra,
  }
}

function createEvidence(opts, runId) {
  const checks = REQUIRED_CHECKS.map((check) => ({
    id: check.id,
    label: check.label,
    status: 'pending',
    evidence: makeManualEvidenceSkeleton(check.id, 'Not executed by API runner.'),
  }))

  return {
    runId,
    executedAt: nowIso(),
    runner: {
      tool: 'dingtalk-p4-remote-smoke',
      mode: 'api-only',
      notes: 'API runner output must be completed with manual DingTalk-client evidence before strict release sign-off.',
    },
    environment: {
      apiBase: opts.apiBase,
      webBase: opts.webBase || '',
    },
    manualTargets: manualTargets(opts),
    checks,
    artifacts: [],
  }
}

function setCheck(evidence, id, status, data) {
  const check = evidence.checks.find((entry) => entry.id === id)
  if (!check) throw new Error(`Unknown check id: ${id}`)
  check.status = status
  check.evidence = sanitizeValue(data)
}

function pendingManualChecks(evidence, opts) {
  const targets = manualTargets(opts)
  setCheck(evidence, 'authorized-user-submit', 'pending', makeManualEvidenceSkeleton(
    'authorized-user-submit',
    targets.authorizedUserId
      ? `Manual DingTalk-client validation required: open the group message as allowed local user ${targets.authorizedUserId}, sign in if prompted, submit, and verify a record was inserted.`
      : 'Manual DingTalk-client validation required: open the group message as an allowed DingTalk-bound local user, sign in if prompted, submit, and verify a record was inserted.',
    {
      manualTarget: {
        authorizedUserId: targets.authorizedUserId,
      },
    },
  ))
  setCheck(evidence, 'unauthorized-user-denied', 'pending', makeManualEvidenceSkeleton(
    'unauthorized-user-denied',
    targets.unauthorizedUserId
      ? `Manual DingTalk-client validation required: open the same form as non-allowlisted local user ${targets.unauthorizedUserId} and verify access or submit is blocked with no record insert.`
      : 'Manual DingTalk-client validation required: open the same form as a DingTalk-bound user outside the allowlist and verify access or submit is blocked with no record insert.',
    {
      manualTarget: {
        unauthorizedUserId: targets.unauthorizedUserId,
      },
    },
  ))
  setCheck(evidence, 'no-email-user-create-bind', 'pending', makeManualEvidenceSkeleton(
    'no-email-user-create-bind',
    targets.noEmailDingTalkExternalId
      ? `Manual admin validation required: create and bind synced DingTalk account ${targets.noEmailDingTalkExternalId} without email, confirm the onboarding packet is shown only in the result panel.`
      : 'Manual admin validation required: create and bind a synced DingTalk account without email, confirm the onboarding packet is shown only in the result panel.',
    {
      adminEvidence: {
        targetDingTalkExternalId: targets.noEmailDingTalkExternalId,
      },
    },
  ))
}

function encodePath(value) {
  return encodeURIComponent(String(value))
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function unwrapData(payload) {
  if (isObject(payload) && payload.ok === false) {
    const message = isObject(payload.error) && typeof payload.error.message === 'string'
      ? payload.error.message
      : 'API returned ok:false'
    throw new Error(message)
  }
  return isObject(payload) && Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload
}

function requireEntity(payload, key) {
  const data = unwrapData(payload)
  if (isObject(data) && isObject(data[key])) return data[key]
  if (isObject(data) && typeof data.id === 'string') return data
  throw new Error(`API response did not include ${key}.id`)
}

function requireId(entity, label) {
  if (!isObject(entity) || typeof entity.id !== 'string' || !entity.id.trim()) {
    throw new Error(`${label} response did not include id`)
  }
  return entity.id.trim()
}

function getDeliveries(payload) {
  const data = unwrapData(payload)
  if (isObject(data) && Array.isArray(data.deliveries)) return data.deliveries
  if (Array.isArray(data)) return data
  return []
}

function getExecutionStatus(execution) {
  if (!isObject(execution)) return 'unknown'
  return typeof execution.status === 'string' ? execution.status : 'unknown'
}

function assertSuccessfulExecution(execution, label) {
  const status = getExecutionStatus(execution)
  if (status !== 'success') {
    const error = isObject(execution) && typeof execution.error === 'string' ? `: ${execution.error}` : ''
    throw new Error(`${label} test-run status was ${status}${error}`)
  }
  const failedSteps = Array.isArray(execution.steps)
    ? execution.steps.filter((step) => isObject(step) && step.status !== 'success')
    : []
  if (failedSteps.length > 0) {
    throw new Error(`${label} test-run had failed steps: ${JSON.stringify(sanitizeValue(failedSteps))}`)
  }
}

function compactError(error) {
  return redactString(error instanceof Error ? error.message : String(error))
}

async function requestJson(opts, route, options = {}) {
  const method = options.method ?? 'GET'
  const expected = options.expected ?? [200]
  const url = new URL(route, opts.apiBase)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs)

  try {
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        Authorization: `Bearer ${opts.authToken}`,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    })
    const text = await response.text()
    const parsed = text ? JSON.parse(text) : null
    if (!expected.includes(response.status)) {
      throw new Error(`${method} ${url.pathname} failed with ${response.status}: ${JSON.stringify(sanitizeValue(parsed ?? text)).slice(0, 600)}`)
    }
    return parsed
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${method} ${url.pathname} returned non-JSON response`)
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`${method} ${url.pathname} timed out after ${opts.timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function markdownCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>')
}

function renderManualTargets(evidence) {
  const targets = evidence.manualTargets ?? {}
  const rows = [
    ['authorized-user-submit', 'allowed DingTalk-bound local user', targets.authorizedUserId || '<missing>'],
    ['unauthorized-user-denied', 'non-allowlisted DingTalk-bound local user', targets.unauthorizedUserId || '<missing>'],
    ['no-email-user-create-bind', 'synced DingTalk external account without local user/email', targets.noEmailDingTalkExternalId || '<missing>'],
  ]
  return rows
    .map(([checkId, role, target]) => `| \`${checkId}\` | ${markdownCell(role)} | \`${markdownCell(target)}\` |`)
    .join('\n')
}

function renderManualEvidenceChecklist(evidence) {
  const rows = MANUAL_EVIDENCE_REQUIREMENTS.map((requirement) => {
    const suggested = Array.isArray(requirement.suggestedArtifacts) && requirement.suggestedArtifacts.length
      ? requirement.suggestedArtifacts.map((artifact) => `\`${artifact}\``).join('<br>')
      : `\`${artifactDirForCheck(requirement.id)}/\``
    return `| \`${requirement.id}\` | \`${requirement.source}\` | ${requirement.label} | ${suggested} |`
  })

  return `# DingTalk P4 Manual Evidence Checklist

This workspace was generated by \`scripts/ops/dingtalk-p4-remote-smoke.mjs\`.
The API runner has prepared backend resources and bootstrap evidence. Fill the
manual checks below from real DingTalk-client or administrator actions before
running strict compile.

| Check ID | Required Source | What It Proves | Suggested Artifacts |
| --- | --- | --- | --- |
${rows.join('\n')}

## Manual Targets

| Check ID | Target Role | Target ID |
| --- | --- | --- |
${renderManualTargets(evidence)}

## No-email Admin Evidence

- Use the admin directory sync page to create a local user from a synced DingTalk account with the email field left blank.
- Capture the create-and-bind result panel without exposing the temporary password.
- Capture the refreshed account row showing the local user link.
- Record \`evidence.adminEvidence.emailWasBlank: true\`, \`createdLocalUserId\`, \`boundDingTalkExternalId\`, and \`accountLinkedAfterRefresh: true\` when updating \`evidence.json\`.

## Fill Rules

- Keep \`status: "pending"\` until the real client/admin action has been performed.
- To mark a manual check \`pass\`, fill \`evidence.operator\`, \`evidence.performedAt\`, \`evidence.summary\`, and \`evidence.artifacts\`.
- Store screenshots, exported logs, or notes under the matching \`artifacts/<check-id>/\` folder.
- Use relative artifact refs such as \`artifacts/authorized-user-submit/submit-ok.png\`.
- Do not paste DingTalk robot full webhook URLs, \`SEC...\` secrets, bearer tokens, admin tokens, public form tokens, temporary passwords, or raw cookies.

## Strict Compile

\`\`\`bash
node scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs \\
  --input evidence.json \\
  --output-dir compiled \\
  --strict
\`\`\`
`
}

function writeEvidenceWorkspace(outputDir, evidence) {
  mkdirSync(outputDir, { recursive: true })
  const evidencePath = path.join(outputDir, 'evidence.json')
  const checklistPath = path.join(outputDir, 'manual-evidence-checklist.md')
  for (const requirement of MANUAL_EVIDENCE_REQUIREMENTS) {
    mkdirSync(path.join(outputDir, artifactDirForCheck(requirement.id)), { recursive: true })
  }
  writeFileSync(evidencePath, `${JSON.stringify(sanitizeValue(evidence), null, 2)}\n`, 'utf8')
  writeFileSync(checklistPath, renderManualEvidenceChecklist(evidence), 'utf8')
  return evidencePath
}

async function runSmoke(opts, evidence) {
  if (!opts.skipHealth) {
    await requestJson(opts, '/health', { expected: [200, 204] })
    evidence.artifacts.push({ kind: 'api-health', status: 'pass', path: '/health' })
  }

  const stamp = evidence.runId.replace(/[^A-Za-z0-9_-]/g, '-')
  const base = requireEntity(await requestJson(opts, '/api/multitable/bases', {
    method: 'POST',
    expected: [200, 201],
    body: {
      name: `DingTalk P4 Remote Smoke ${stamp}`,
      icon: 'ding',
      color: '#0EA5E9',
    },
  }), 'base')
  const baseId = requireId(base, 'base')

  const sheet = requireEntity(await requestJson(opts, '/api/multitable/sheets', {
    method: 'POST',
    expected: [200, 201],
    body: {
      baseId,
      name: `DingTalk P4 Smoke ${stamp}`,
      description: 'Disposable sheet created by scripts/ops/dingtalk-p4-remote-smoke.mjs',
      seed: true,
    },
  }), 'sheet')
  const sheetId = requireId(sheet, 'sheet')

  const field = requireEntity(await requestJson(opts, '/api/multitable/fields', {
    method: 'POST',
    expected: [200, 201],
    body: {
      sheetId,
      name: `P4 Smoke Notes ${stamp.slice(-8)}`,
      type: 'string',
    },
  }), 'field')
  const fieldId = requireId(field, 'field')

  const formView = requireEntity(await requestJson(opts, '/api/multitable/views', {
    method: 'POST',
    expected: [200, 201],
    body: {
      sheetId,
      name: 'DingTalk P4 Protected Form',
      type: 'form',
      config: {
        publicForm: {
          enabled: true,
          accessMode: 'dingtalk_granted',
        },
      },
    },
  }), 'view')
  const formViewId = requireId(formView, 'form view')

  setCheck(evidence, 'create-table-form', 'pass', {
    notes: 'Created disposable base, sheet, field, and form view through API.',
    baseId,
    sheetId,
    fieldId,
    formViewId,
  })

  const formShare = unwrapData(await requestJson(
    opts,
    `/api/multitable/sheets/${encodePath(sheetId)}/views/${encodePath(formViewId)}/form-share`,
    {
      method: 'PATCH',
      expected: [200],
      body: {
        enabled: true,
        accessMode: 'dingtalk_granted',
        allowedUserIds: opts.allowedUserIds,
        allowedMemberGroupIds: opts.allowedMemberGroupIds,
      },
    },
  ))
  const accessMode = isObject(formShare) && typeof formShare.accessMode === 'string'
    ? formShare.accessMode
    : 'unknown'
  if (accessMode !== 'dingtalk_granted') {
    throw new Error(`form share accessMode was ${accessMode}, expected dingtalk_granted`)
  }
  setCheck(evidence, 'set-form-dingtalk-granted', 'pass', {
    notes: 'Form share was enabled with local allowlist-based DingTalk access.',
    sheetId,
    formViewId,
    accessMode,
    formShareStatus: isObject(formShare) ? formShare.status : undefined,
    allowedUserCount: opts.allowedUserIds.length,
    allowedMemberGroupCount: opts.allowedMemberGroupIds.length,
  })

  const destinations = []
  for (const group of [
    { key: 'A', webhookUrl: opts.groupAWebhook, secret: opts.groupASecret },
    { key: 'B', webhookUrl: opts.groupBWebhook, secret: opts.groupBSecret },
  ]) {
    const body = {
      name: `P4 Smoke Group ${group.key} ${stamp.slice(-8)}`,
      webhookUrl: group.webhookUrl,
      enabled: true,
      sheetId,
    }
    if (group.secret) body.secret = group.secret
    const destination = requireEntity(await requestJson(opts, '/api/multitable/dingtalk-groups', {
      method: 'POST',
      expected: [200, 201],
      body,
    }), 'destination')
    destinations.push({
      key: group.key,
      id: requireId(destination, `DingTalk group ${group.key}`),
      name: isObject(destination) && typeof destination.name === 'string' ? destination.name : `P4 Smoke Group ${group.key}`,
    })
  }

  const manualDeliveryCounts = {}
  if (!opts.skipTestSend) {
    for (const destination of destinations) {
      await requestJson(
        opts,
        `/api/multitable/dingtalk-groups/${encodePath(destination.id)}/test-send?sheetId=${encodeURIComponent(sheetId)}`,
        {
          method: 'POST',
          expected: [200, 204],
          body: {
            subject: `P4 smoke ${destination.key}`,
            content: `P4 DingTalk group destination test-send for ${sheetId}.`,
          },
        },
      )
      const deliveries = getDeliveries(await requestJson(
        opts,
        `/api/multitable/dingtalk-groups/${encodePath(destination.id)}/deliveries?sheetId=${encodeURIComponent(sheetId)}&limit=20`,
      ))
      manualDeliveryCounts[destination.id] = deliveries.length
      if (deliveries.length === 0) {
        throw new Error(`DingTalk group ${destination.key} test-send produced no delivery rows`)
      }
    }
  }

  setCheck(evidence, 'bind-two-dingtalk-groups', opts.skipTestSend ? 'pending' : 'pass', {
    notes: opts.skipTestSend
      ? 'Created two DingTalk group destinations, but --skip-test-send left smoke evidence pending.'
      : 'Created two DingTalk group destinations and verified test-send delivery rows.',
    sheetId,
    destinationIds: destinations.map((destination) => destination.id),
    manualTestDeliveryCounts: manualDeliveryCounts,
  })

  const groupRule = requireEntity(await requestJson(
    opts,
    `/api/multitable/sheets/${encodePath(sheetId)}/automations`,
    {
      method: 'POST',
      expected: [200, 201],
      body: {
        name: 'DingTalk P4 group form-link smoke',
        enabled: true,
        triggerType: 'record.created',
        triggerConfig: {},
        actionType: 'send_dingtalk_group_message',
        actionConfig: {
          destinationIds: destinations.map((destination) => destination.id),
          titleTemplate: 'DingTalk P4 protected form smoke',
          bodyTemplate: 'Open the protected form link from DingTalk. Only allowlisted local users or member groups should be able to submit.',
          publicFormViewId: formViewId,
        },
      },
    },
  ), 'rule')
  const groupRuleId = requireId(groupRule, 'group automation rule')

  let groupRuleDeliveryCount = 0
  if (!opts.skipAutomationTestRun) {
    const execution = await requestJson(
      opts,
      `/api/multitable/sheets/${encodePath(sheetId)}/automations/${encodePath(groupRuleId)}/test`,
      { method: 'POST', expected: [200] },
    )
    assertSuccessfulExecution(execution, 'group automation')
    const ruleDeliveries = getDeliveries(await requestJson(
      opts,
      `/api/multitable/sheets/${encodePath(sheetId)}/automations/${encodePath(groupRuleId)}/dingtalk-group-deliveries?limit=20`,
    ))
    groupRuleDeliveryCount = ruleDeliveries.length
    if (ruleDeliveries.length < destinations.length) {
      throw new Error(`group automation delivery rows ${ruleDeliveries.length} < destination count ${destinations.length}`)
    }
  }

  setCheck(evidence, 'send-group-message-form-link', 'pending', makeManualEvidenceSkeleton(
    'send-group-message-form-link',
    opts.skipAutomationTestRun
      ? 'Created the DingTalk group automation rule, but --skip-automation-test-run left actual send evidence pending.'
      : 'API test-run produced group delivery rows, but real DingTalk group message visibility and link/access-copy screenshots are still manual-client evidence.',
    {
      apiBootstrap: {
        sheetId,
        formViewId,
        groupRuleId,
        destinationIds: destinations.map((destination) => destination.id),
        groupRuleDeliveryCount,
      },
    },
  ))

  let personRuleId = ''
  let personRuleDeliveryCount = 0
  if (opts.personUserIds.length > 0) {
    const personRule = requireEntity(await requestJson(
      opts,
      `/api/multitable/sheets/${encodePath(sheetId)}/automations`,
      {
        method: 'POST',
        expected: [200, 201],
        body: {
          name: 'DingTalk P4 person delivery smoke',
          enabled: true,
          triggerType: 'record.created',
          triggerConfig: {},
          actionType: 'send_dingtalk_person_message',
          actionConfig: {
            userIds: opts.personUserIds,
            titleTemplate: 'DingTalk P4 person delivery smoke',
            bodyTemplate: 'Person delivery smoke for P4 evidence. This validates delivery history rows for bound or skipped recipients.',
            publicFormViewId: formViewId,
          },
        },
      },
    ), 'rule')
    personRuleId = requireId(personRule, 'person automation rule')

    if (!opts.skipAutomationTestRun) {
      const execution = await requestJson(
        opts,
        `/api/multitable/sheets/${encodePath(sheetId)}/automations/${encodePath(personRuleId)}/test`,
        { method: 'POST', expected: [200] },
      )
      assertSuccessfulExecution(execution, 'person automation')
      const personDeliveries = getDeliveries(await requestJson(
        opts,
        `/api/multitable/sheets/${encodePath(sheetId)}/automations/${encodePath(personRuleId)}/dingtalk-person-deliveries?limit=20`,
      ))
      personRuleDeliveryCount = personDeliveries.length
      if (personDeliveries.length === 0) {
        throw new Error('person automation test-run produced no delivery rows')
      }
    }
  }

  const hasPersonEvidence = opts.personUserIds.length > 0 && !opts.skipAutomationTestRun && personRuleDeliveryCount > 0
  const hasGroupEvidence = !opts.skipAutomationTestRun && groupRuleDeliveryCount >= destinations.length
  setCheck(evidence, 'delivery-history-group-person', hasGroupEvidence && hasPersonEvidence ? 'pass' : 'pending', {
    notes: hasGroupEvidence && hasPersonEvidence
      ? 'Verified rule-level group and person delivery rows from API test-runs.'
      : 'Group delivery was queried by the API runner; person delivery remains pending unless --person-user is provided and automation test-run is enabled.',
    sheetId,
    groupRuleId,
    groupRuleDeliveryCount,
    personRuleId: personRuleId || undefined,
    personRuleDeliveryCount,
    personUserCount: opts.personUserIds.length,
  })

  pendingManualChecks(evidence, opts)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  validateOptions(opts)
  const runId = makeRunId()
  const outputDir = opts.outputDir ?? path.resolve(process.cwd(), DEFAULT_OUTPUT_ROOT, runId)
  const evidence = createEvidence(opts, runId)

  let exitCode = 0
  try {
    await runSmoke(opts, evidence)
  } catch (error) {
    exitCode = 1
    evidence.error = compactError(error)
    console.error(`[dingtalk-p4-remote-smoke] ERROR: ${evidence.error}`)
    const firstPending = evidence.checks.find((check) => check.status === 'pending')
    if (firstPending) {
      setCheck(evidence, firstPending.id, 'fail', {
        notes: 'API runner stopped at this check.',
        error: compactError(error),
      })
    }
  } finally {
    const evidencePath = writeEvidenceWorkspace(outputDir, evidence)
    const relativeEvidencePath = path.relative(process.cwd(), evidencePath).replaceAll('\\', '/')
    console.log(`Wrote ${relativeEvidencePath}`)
    console.log(`Wrote ${path.relative(process.cwd(), path.join(outputDir, 'manual-evidence-checklist.md')).replaceAll('\\', '/')}`)
    console.log(`Compile after manual updates: node scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs --input ${relativeEvidencePath} --output-dir ${path.relative(process.cwd(), outputDir).replaceAll('\\', '/')} --strict`)
  }

  if (exitCode !== 0) process.exit(exitCode)
}

try {
  await main()
} catch (error) {
  console.error(`[dingtalk-p4-remote-smoke] ERROR: ${compactError(error)}`)
  process.exit(1)
}

#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_API_BASE = 'http://127.0.0.1:8900'
const DEFAULT_OUTPUT_ROOT = 'output/dingtalk-group-failure-alert-probe'
const DEFAULT_ALERT_SUBJECT = 'MetaSheet DingTalk group delivery failed'

function printHelp() {
  console.log(`Usage: node scripts/ops/dingtalk-group-failure-alert-probe.mjs [options]

Checks a deployed MetaSheet backend for the DingTalk group robot failure-alert
chain. It reads automation config plus recent group/person delivery history.
It does not send DingTalk messages, does not trigger automations, and does not
write secrets.

Required:
  --sheet-id <id>             Multitable sheet id that owns the automation rule

Authentication:
  --auth-token <token>        Bearer token, never printed or written
  --auth-token-file <file>    File containing the bearer token

Rule selection:
  --rule-id <id>              Automation rule id. If omitted, exactly one
                              DingTalk group rule must exist on the sheet.
  --record-id <id>            Optional record id to scope delivery evidence.
                              Use this after triggering a known test record so
                              old delivery rows do not affect the result.

Checks:
  --expect-alert <mode>       enabled, disabled, or any. Default: enabled
  --expect-person-status <s>  success, skipped, failed, none, or any. Default: any
  --require-group-failure     Require at least one failed group delivery
  --require-person-alert      Require a creator person-alert delivery
  --acceptance                Shortcut for --require-group-failure
                              --require-person-alert --expect-alert enabled
  --alert-subject <text>      Creator alert subject matcher, default "${DEFAULT_ALERT_SUBJECT}"

Output:
  --api-base <url>            Backend base URL, default ${DEFAULT_API_BASE}
  --output-dir <dir>          Output directory, default ${DEFAULT_OUTPUT_ROOT}/<run-id>
                              Argument and runtime failures still write
                              redaction-safe blocked summaries here.
  --limit <n>                 Delivery history limit, default 20, max 200
  --timeout-ms <ms>           HTTP timeout, default 10000
  --skip-auth-me              Skip GET /api/auth/me
  --help                      Show this help

Environment fallbacks:
  DINGTALK_GROUP_FAILURE_ALERT_API_BASE, DINGTALK_GROUP_FAILURE_ALERT_AUTH_TOKEN,
  DINGTALK_GROUP_FAILURE_ALERT_AUTH_TOKEN_FILE, DINGTALK_GROUP_FAILURE_ALERT_SHEET_ID,
  DINGTALK_GROUP_FAILURE_ALERT_RULE_ID, DINGTALK_GROUP_FAILURE_ALERT_RECORD_ID,
  DINGTALK_GROUP_FAILURE_ALERT_SUBJECT
`)
}

function requireValue(argv, index, flag) {
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

function makeDefaultOptions() {
  return {
    apiBase: envValue('DINGTALK_GROUP_FAILURE_ALERT_API_BASE', 'API_BASE') || DEFAULT_API_BASE,
    authToken: envValue('DINGTALK_GROUP_FAILURE_ALERT_AUTH_TOKEN', 'ADMIN_TOKEN', 'AUTH_TOKEN'),
    authTokenFile: envValue('DINGTALK_GROUP_FAILURE_ALERT_AUTH_TOKEN_FILE', 'ADMIN_TOKEN_FILE', 'AUTH_TOKEN_FILE'),
    sheetId: envValue('DINGTALK_GROUP_FAILURE_ALERT_SHEET_ID', 'SHEET_ID'),
    ruleId: envValue('DINGTALK_GROUP_FAILURE_ALERT_RULE_ID', 'RULE_ID'),
    recordId: envValue('DINGTALK_GROUP_FAILURE_ALERT_RECORD_ID', 'RECORD_ID'),
    alertSubject: envValue('DINGTALK_GROUP_FAILURE_ALERT_SUBJECT', 'ALERT_SUBJECT') || DEFAULT_ALERT_SUBJECT,
    expectAlert: 'enabled',
    expectPersonStatus: 'any',
    requireGroupFailure: false,
    requirePersonAlert: false,
    outputDir: '',
    limit: 20,
    timeoutMs: 10_000,
    skipAuthMe: false,
  }
}

function parseArgs(argv) {
  const opts = makeDefaultOptions()

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--api-base':
        opts.apiBase = requireValue(argv, index, arg)
        index += 1
        break
      case '--auth-token':
        opts.authToken = requireValue(argv, index, arg)
        index += 1
        break
      case '--auth-token-file':
        opts.authTokenFile = path.resolve(process.cwd(), requireValue(argv, index, arg))
        index += 1
        break
      case '--sheet-id':
        opts.sheetId = requireValue(argv, index, arg)
        index += 1
        break
      case '--rule-id':
        opts.ruleId = requireValue(argv, index, arg)
        index += 1
        break
      case '--record-id':
        opts.recordId = requireValue(argv, index, arg)
        index += 1
        break
      case '--expect-alert':
        opts.expectAlert = requireValue(argv, index, arg)
        index += 1
        break
      case '--expect-person-status':
        opts.expectPersonStatus = requireValue(argv, index, arg)
        index += 1
        break
      case '--alert-subject':
        opts.alertSubject = requireValue(argv, index, arg)
        index += 1
        break
      case '--require-group-failure':
        opts.requireGroupFailure = true
        break
      case '--require-person-alert':
        opts.requirePersonAlert = true
        break
      case '--acceptance':
        opts.expectAlert = 'enabled'
        opts.requireGroupFailure = true
        opts.requirePersonAlert = true
        break
      case '--output-dir':
        opts.outputDir = path.resolve(process.cwd(), requireValue(argv, index, arg))
        index += 1
        break
      case '--limit':
        opts.limit = parseBoundedInteger(requireValue(argv, index, arg), arg, 1, 200)
        index += 1
        break
      case '--timeout-ms':
        opts.timeoutMs = parseBoundedInteger(requireValue(argv, index, arg), arg, 100, 120_000)
        index += 1
        break
      case '--skip-auth-me':
        opts.skipAuthMe = true
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!opts.sheetId) throw new Error('--sheet-id is required')
  if (!['enabled', 'disabled', 'any'].includes(opts.expectAlert)) {
    throw new Error('--expect-alert must be one of: enabled, disabled, any')
  }
  if (!['success', 'skipped', 'failed', 'none', 'any'].includes(opts.expectPersonStatus)) {
    throw new Error('--expect-person-status must be one of: success, skipped, failed, none, any')
  }
  if (opts.expectPersonStatus === 'none' && opts.requirePersonAlert) {
    throw new Error('--expect-person-status none conflicts with --require-person-alert')
  }
  opts.alertSubject = opts.alertSubject.trim() || DEFAULT_ALERT_SUBJECT
  if (!opts.authToken && opts.authTokenFile) {
    opts.authToken = readTokenFile(opts.authTokenFile)
  }
  if (!opts.authToken) throw new Error('--auth-token or --auth-token-file is required')
  if (!opts.outputDir) {
    opts.outputDir = path.resolve(process.cwd(), DEFAULT_OUTPUT_ROOT, makeRunId())
  }
  opts.apiBase = normalizeApiBase(opts.apiBase)
  return opts
}

function makeFallbackOptions(argv) {
  const opts = makeDefaultOptions()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]
    const hasValue = typeof next === 'string' && !next.startsWith('--')
    switch (arg) {
      case '--api-base':
        if (hasValue) opts.apiBase = next
        index += hasValue ? 1 : 0
        break
      case '--auth-token':
        if (hasValue) opts.authToken = next
        index += hasValue ? 1 : 0
        break
      case '--auth-token-file':
        if (hasValue) opts.authTokenFile = path.resolve(process.cwd(), next)
        index += hasValue ? 1 : 0
        break
      case '--sheet-id':
        if (hasValue) opts.sheetId = next
        index += hasValue ? 1 : 0
        break
      case '--rule-id':
        if (hasValue) opts.ruleId = next
        index += hasValue ? 1 : 0
        break
      case '--record-id':
        if (hasValue) opts.recordId = next
        index += hasValue ? 1 : 0
        break
      case '--expect-alert':
        if (hasValue) opts.expectAlert = next
        index += hasValue ? 1 : 0
        break
      case '--expect-person-status':
        if (hasValue) opts.expectPersonStatus = next
        index += hasValue ? 1 : 0
        break
      case '--alert-subject':
        if (hasValue) opts.alertSubject = next
        index += hasValue ? 1 : 0
        break
      case '--require-group-failure':
        opts.requireGroupFailure = true
        break
      case '--require-person-alert':
        opts.requirePersonAlert = true
        break
      case '--acceptance':
        opts.expectAlert = 'enabled'
        opts.requireGroupFailure = true
        opts.requirePersonAlert = true
        break
      case '--output-dir':
        if (hasValue) opts.outputDir = path.resolve(process.cwd(), next)
        index += hasValue ? 1 : 0
        break
      case '--limit':
        if (hasValue) {
          const parsed = Number.parseInt(next, 10)
          if (Number.isFinite(parsed)) opts.limit = parsed
        }
        index += hasValue ? 1 : 0
        break
      case '--timeout-ms':
        if (hasValue) {
          const parsed = Number.parseInt(next, 10)
          if (Number.isFinite(parsed)) opts.timeoutMs = parsed
        }
        index += hasValue ? 1 : 0
        break
      case '--skip-auth-me':
        opts.skipAuthMe = true
        break
      default:
        break
    }
  }
  opts.alertSubject = opts.alertSubject.trim() || DEFAULT_ALERT_SUBJECT
  if (!opts.outputDir) {
    opts.outputDir = path.resolve(process.cwd(), DEFAULT_OUTPUT_ROOT, makeRunId())
  }
  try {
    opts.apiBase = normalizeApiBase(opts.apiBase)
  } catch {
    opts.apiBase = DEFAULT_API_BASE
  }
  return opts
}

function parseBoundedInteger(value, flag, min, max) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}`)
  }
  return parsed
}

function readTokenFile(file) {
  if (!existsSync(file)) throw new Error(`auth token file does not exist: ${file}`)
  return readFileSync(file, 'utf8').trim()
}

function makeRunId() {
  return `dingtalk-group-failure-alert-${new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')}`
}

function normalizeApiBase(value) {
  const url = new URL(value)
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function redactString(value) {
  return String(value ?? '')
    .replace(/(access_token=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/(publicToken=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/([?&](?:sign|timestamp)=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/\bSEC[A-Za-z0-9+/=_-]{8,}\b/g, 'SEC<redacted>')
    .replace(/\beyJ[A-Za-z0-9._-]{20,}\.[A-Za-z0-9._-]{20,}\.[A-Za-z0-9._-]{10,}\b/g, '<jwt:redacted>')
}

function redactDeep(value) {
  if (value == null) return value
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map(redactDeep)
  if (typeof value === 'object') {
    const output = {}
    for (const [key, entry] of Object.entries(value)) {
      if (/token|secret|webhook|authorization/i.test(key)) {
        output[key] = entry ? '<redacted>' : entry
      } else {
        output[key] = redactDeep(entry)
      }
    }
    return output
  }
  return value
}

async function fetchJson(opts, pathname) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, opts.timeoutMs)
  let response = null
  let text = ''
  try {
    response = await fetch(`${opts.apiBase}${pathname}`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${opts.authToken}`,
      },
      signal: controller.signal,
    })
    text = await response.text()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (timedOut || /aborted|abort|timeout/i.test(message)) {
      throw makeProbeError(`request timed out after ${opts.timeoutMs}ms`, {
        pathname,
        timeoutMs: opts.timeoutMs,
      })
    }
    throw makeProbeError(`network request failed: ${message}`, {
      pathname,
      originalMessage: message,
    })
  } finally {
    clearTimeout(timer)
  }

  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: redactString(text) }
  }
  if (!response.ok) {
    const message = body?.error?.message || body?.message || response.statusText || 'request failed'
    throw makeHttpError(response.status, message, {
      pathname,
      response: body,
    })
  }
  return body
}

function isDingTalkGroupAction(actionType, config) {
  return actionType === 'send_dingtalk_group_message'
    && config
    && typeof config === 'object'
}

function getRuleGroupActions(rule) {
  const actions = []
  if (isDingTalkGroupAction(rule.actionType, rule.actionConfig)) {
    actions.push({ source: 'actionConfig', config: rule.actionConfig })
  }
  if (Array.isArray(rule.actions)) {
    for (const [index, action] of rule.actions.entries()) {
      if (isDingTalkGroupAction(action?.type, action?.config)) {
        actions.push({ source: `actions[${index}]`, config: action.config })
      }
    }
  }
  return actions
}

function summarizeRule(rule) {
  return {
    id: rule.id,
    name: rule.name || '',
    enabled: rule.enabled,
    actionType: rule.actionType || '',
    groupActionCount: getRuleGroupActions(rule).length,
  }
}

function makeProbeError(message, detail = {}) {
  const error = new Error(message)
  error.detail = detail
  return error
}

function makeHttpError(status, message, detail = {}) {
  return makeProbeError(`${status} ${message}`, {
    status,
    ...detail,
  })
}

function chooseRule(rules, requestedRuleId) {
  const candidates = rules.filter((rule) => getRuleGroupActions(rule).length > 0)
  if (requestedRuleId) {
    const rule = rules.find((entry) => entry.id === requestedRuleId)
    if (!rule) {
      throw makeProbeError(`automation rule not found: ${requestedRuleId}`, {
        requestedRuleId,
        totalRuleCount: rules.length,
        availableGroupRules: candidates.map(summarizeRule),
      })
    }
    return rule
  }
  if (candidates.length === 0) {
    throw makeProbeError('no DingTalk group automation rule found; pass --rule-id after creating one', {
      totalRuleCount: rules.length,
      availableRules: rules.map(summarizeRule),
    })
  }
  if (candidates.length > 1) {
    throw makeProbeError(`multiple DingTalk group automation rules found (${candidates.length}); pass --rule-id`, {
      candidateRules: candidates.map(summarizeRule),
    })
  }
  return candidates[0]
}

function matchesRecordFilter(delivery, recordId) {
  if (!recordId) return true
  return delivery?.recordId === recordId
}

function latestGroupFailure(deliveries, recordId = '') {
  return deliveries.find((delivery) => {
    return delivery && delivery.success === false && matchesRecordFilter(delivery, recordId)
  }) || null
}

function latestCreatorAlert(deliveries, recordId = '', alertSubject = DEFAULT_ALERT_SUBJECT) {
  return deliveries.find((delivery) => {
    if (!delivery || delivery.sourceType !== 'automation') return false
    if (!matchesRecordFilter(delivery, recordId)) return false
    return typeof delivery.subject === 'string' && delivery.subject.includes(alertSubject)
  }) || null
}

function countGroupFailures(deliveries, recordId = '') {
  return deliveries.filter((delivery) => {
    return delivery?.success === false && matchesRecordFilter(delivery, recordId)
  }).length
}

function countCreatorAlerts(deliveries, recordId = '', alertSubject = DEFAULT_ALERT_SUBJECT) {
  return deliveries.filter((delivery) => {
    if (!delivery || delivery.sourceType !== 'automation') return false
    if (!matchesRecordFilter(delivery, recordId)) return false
    return typeof delivery.subject === 'string' && delivery.subject.includes(alertSubject)
  }).length
}

function makeDeliveryQuery(opts) {
  const params = new URLSearchParams({ limit: String(opts.limit) })
  if (opts.recordId) params.set('recordId', opts.recordId)
  return params.toString()
}

function makeSafeDelivery(delivery, fields) {
  if (!delivery) return null
  const output = {}
  for (const field of fields) {
    if (delivery[field] !== undefined) output[field] = delivery[field]
  }
  return redactDeep(output)
}

function addFailure(failures, code, message, detail = {}) {
  failures.push({ code, message, detail: redactDeep(detail) })
}

async function runProbe(opts) {
  const failures = []
  const authMe = opts.skipAuthMe ? null : await fetchJson(opts, '/api/auth/me')
  const rulesBody = await fetchJson(opts, `/api/multitable/sheets/${encodeURIComponent(opts.sheetId)}/automations`)
  const rules = Array.isArray(rulesBody?.data?.rules) ? rulesBody.data.rules : []
  const rule = chooseRule(rules, opts.ruleId)
  const groupActions = getRuleGroupActions(rule)
  if (rule.enabled !== true) {
    addFailure(failures, 'RULE_DISABLED', 'Selected automation rule is disabled', { enabled: rule.enabled })
  }
  if (groupActions.length === 0) {
    addFailure(failures, 'RULE_NOT_GROUP_ACTION', 'Selected rule is not a DingTalk group automation rule')
  }

  const alertValues = groupActions.map((action) => action.config.notifyRuleCreatorOnFailure)
  const alertEnabled = alertValues.some((value) => value === true)
  const alertExplicitlyDisabled = alertValues.length > 0 && alertValues.every((value) => value === false)
  if (opts.expectAlert === 'enabled' && !alertEnabled) {
    addFailure(failures, 'ALERT_NOT_ENABLED', 'Expected creator failure alert to be enabled', { alertValues })
  }
  if (opts.expectAlert === 'disabled' && !alertExplicitlyDisabled) {
    addFailure(failures, 'ALERT_NOT_DISABLED', 'Expected creator failure alert to be explicitly disabled', { alertValues })
  }

  const encodedSheetId = encodeURIComponent(opts.sheetId)
  const encodedRuleId = encodeURIComponent(rule.id)
  const deliveryQuery = makeDeliveryQuery(opts)
  const groupBody = await fetchJson(opts, `/api/multitable/sheets/${encodedSheetId}/automations/${encodedRuleId}/dingtalk-group-deliveries?${deliveryQuery}`)
  const personBody = await fetchJson(opts, `/api/multitable/sheets/${encodedSheetId}/automations/${encodedRuleId}/dingtalk-person-deliveries?${deliveryQuery}`)
  const groupDeliveries = Array.isArray(groupBody?.data?.deliveries) ? groupBody.data.deliveries : []
  const personDeliveries = Array.isArray(personBody?.data?.deliveries) ? personBody.data.deliveries : []
  const groupFailure = latestGroupFailure(groupDeliveries, opts.recordId)
  const creatorAlert = latestCreatorAlert(personDeliveries, opts.recordId, opts.alertSubject)

  if (opts.requireGroupFailure && !groupFailure) {
    addFailure(failures, 'GROUP_FAILURE_NOT_FOUND', 'No failed DingTalk group delivery was found for this rule')
  }
  if (opts.requirePersonAlert && !creatorAlert) {
    addFailure(failures, 'CREATOR_ALERT_NOT_FOUND', 'No creator DingTalk person alert was found for this rule')
  }
  if (opts.expectPersonStatus === 'none' && creatorAlert) {
    addFailure(failures, 'CREATOR_ALERT_UNEXPECTED', 'Expected no creator DingTalk person alert, but one was found', { status: creatorAlert.status })
  }
  if (
    creatorAlert
    && opts.expectPersonStatus !== 'any'
    && opts.expectPersonStatus !== 'none'
    && creatorAlert.status !== opts.expectPersonStatus
  ) {
    addFailure(failures, 'CREATOR_ALERT_STATUS_MISMATCH', 'Creator alert status did not match expectation', {
      expected: opts.expectPersonStatus,
      actual: creatorAlert.status,
    })
  }

  return {
    tool: 'dingtalk-group-failure-alert-probe',
    status: failures.length === 0 ? 'PASS' : 'BLOCKED',
    checkedAt: new Date().toISOString(),
    apiBase: opts.apiBase,
    sheetId: opts.sheetId,
    ruleId: rule.id,
    auth: opts.skipAuthMe
      ? { checked: false }
      : {
          checked: true,
          ok: authMe?.success === true || authMe?.ok === true,
          role: authMe?.user?.role || authMe?.role || '',
          userId: authMe?.user?.id || authMe?.id || '',
        },
    expectations: {
      alert: opts.expectAlert,
      personStatus: opts.expectPersonStatus,
      requireGroupFailure: opts.requireGroupFailure,
      requirePersonAlert: opts.requirePersonAlert,
      recordId: opts.recordId || '',
      alertSubject: opts.alertSubject,
    },
    rule: {
      id: rule.id,
      name: rule.name || '',
      enabled: rule.enabled,
      actionType: rule.actionType,
      groupActionCount: groupActions.length,
      notifyRuleCreatorOnFailure: alertValues,
    },
    groupDeliveries: {
      count: groupDeliveries.length,
      failedCount: countGroupFailures(groupDeliveries),
      matchingFailedCount: countGroupFailures(groupDeliveries, opts.recordId),
      latestFailure: makeSafeDelivery(groupFailure, [
        'id',
        'destinationId',
        'destinationName',
        'sourceType',
        'subject',
        'success',
        'httpStatus',
        'errorMessage',
        'automationRuleId',
        'recordId',
        'createdAt',
        'deliveredAt',
      ]),
    },
    personDeliveries: {
      count: personDeliveries.length,
      creatorAlertCount: countCreatorAlerts(personDeliveries, '', opts.alertSubject),
      matchingCreatorAlertCount: countCreatorAlerts(personDeliveries, opts.recordId, opts.alertSubject),
      latestCreatorAlert: makeSafeDelivery(creatorAlert, [
        'id',
        'localUserId',
        'dingtalkUserId',
        'sourceType',
        'subject',
        'success',
        'status',
        'httpStatus',
        'errorMessage',
        'automationRuleId',
        'recordId',
        'createdAt',
        'deliveredAt',
      ]),
    },
    failures,
    nextActions: makeNextActions(failures, opts, { groupFailure, creatorAlert }),
  }
}

function makeNextActions(failures, opts, state) {
  if (failures.length === 0) {
    if (!opts.requireGroupFailure || !opts.requirePersonAlert) {
      return ['For full acceptance, rerun with --acceptance after triggering a known failed group robot delivery.']
    }
    return ['Attach summary.md to the deployment acceptance packet.']
  }
  return failures.map((failure) => {
    switch (failure.code) {
      case 'ALERT_NOT_ENABLED':
        return 'Open the automation rule and enable "Notify me if DingTalk group delivery fails", then save and rerun.'
      case 'ALERT_NOT_DISABLED':
        return 'Open the automation rule, explicitly uncheck the creator failure alert option, then save and rerun.'
      case 'RULE_DISABLED':
        return 'Enable the selected automation rule or choose an enabled rule, then rerun the probe.'
      case 'GROUP_FAILURE_NOT_FOUND':
        return 'Trigger the rule with a test-only invalid group robot keyword/signature, then rerun this probe.'
      case 'CREATOR_ALERT_NOT_FOUND':
        return state.groupFailure
          ? 'Check the rule creator DingTalk binding and app-message envs, then rerun after another failed group delivery.'
          : 'First produce a failed group delivery, then check whether a creator alert is recorded.'
      case 'CREATOR_ALERT_STATUS_MISMATCH':
        return 'Inspect dingtalk_person_deliveries for the rule and compare the expected linked/skipped creator scenario.'
      default:
        return failure.message
    }
  })
}

function writeOutputs(outputDir, summary) {
  mkdirSync(outputDir, { recursive: true })
  const safeSummary = redactDeep(summary)
  const jsonPath = path.join(outputDir, 'summary.json')
  const mdPath = path.join(outputDir, 'summary.md')
  writeFileSync(jsonPath, `${JSON.stringify(safeSummary, null, 2)}\n`, 'utf8')
  writeFileSync(mdPath, renderMarkdown(safeSummary), 'utf8')
  return { jsonPath, mdPath }
}

function classifyFatalError(message) {
  if (/auth token file does not exist/i.test(message)) return 'AUTH_TOKEN_FILE_NOT_FOUND'
  if (/--auth-token or --auth-token-file is required/i.test(message)) return 'AUTH_TOKEN_REQUIRED'
  if (/--sheet-id is required/i.test(message)) return 'SHEET_ID_REQUIRED'
  if (/Unknown argument|requires a value|must be one of|must be an integer/i.test(message)) return 'INVALID_ARGUMENTS'
  if (/^401\b/.test(message)) return 'AUTH_FAILED'
  if (/^403\b/.test(message)) return 'FORBIDDEN'
  if (/^404\b/.test(message)) return 'API_NOT_FOUND'
  if (/This operation was aborted|aborted|timed out|timeout/i.test(message)) return 'API_TIMEOUT'
  if (/network request failed/i.test(message)) return 'API_NETWORK_ERROR'
  if (/automation rule not found/i.test(message)) return 'RULE_NOT_FOUND'
  if (/multiple DingTalk group automation rules found/i.test(message)) return 'MULTIPLE_GROUP_RULES'
  if (/no DingTalk group automation rule found/i.test(message)) return 'NO_GROUP_RULE'
  return 'PROBE_FATAL_ERROR'
}

function makeFatalNextAction(code) {
  switch (code) {
    case 'AUTH_TOKEN_FILE_NOT_FOUND':
      return 'Confirm the token file path exists and is readable, then rerun the probe.'
    case 'AUTH_TOKEN_REQUIRED':
      return 'Pass --auth-token-file or --auth-token with an admin token, then rerun the probe.'
    case 'SHEET_ID_REQUIRED':
      return 'Pass --sheet-id for the multitable sheet that owns the automation rule, then rerun the probe.'
    case 'INVALID_ARGUMENTS':
      return 'Fix the probe arguments shown in the failure message, then rerun the probe.'
    case 'AUTH_FAILED':
      return 'Refresh the admin token file, verify /api/auth/me, then rerun the probe.'
    case 'FORBIDDEN':
      return 'Use an admin or sheet automation manager account, then rerun the probe.'
    case 'API_NOT_FOUND':
      return 'Confirm the backend base URL and deployed route version, then rerun the probe.'
    case 'API_TIMEOUT':
      return 'Check backend reachability from this machine and rerun with a larger --timeout-ms if needed.'
    case 'API_NETWORK_ERROR':
      return 'Confirm the backend host and port are reachable from this machine, then rerun the probe.'
    case 'RULE_NOT_FOUND':
      return 'Confirm the automation rule id belongs to the selected sheet, then rerun the probe.'
    case 'MULTIPLE_GROUP_RULES':
      return 'Pass --rule-id to choose the DingTalk group automation rule under test.'
    case 'NO_GROUP_RULE':
      return 'Create or select a DingTalk group automation rule, then rerun the probe.'
    default:
      return 'Inspect the failure message, fix the environment or selected rule, then rerun the probe.'
  }
}

function makeFatalSummary(opts, error) {
  const message = redactString(error instanceof Error ? error.message : String(error))
  const code = classifyFatalError(message)
  const detail = error && typeof error === 'object' && 'detail' in error ? error.detail : {}
  return {
    tool: 'dingtalk-group-failure-alert-probe',
    status: 'BLOCKED',
    checkedAt: new Date().toISOString(),
    apiBase: opts.apiBase,
    sheetId: opts.sheetId,
    ruleId: opts.ruleId || '',
    auth: {
      checked: !opts.skipAuthMe,
    },
    expectations: {
      alert: opts.expectAlert,
      personStatus: opts.expectPersonStatus,
      requireGroupFailure: opts.requireGroupFailure,
      requirePersonAlert: opts.requirePersonAlert,
      recordId: opts.recordId || '',
      alertSubject: opts.alertSubject,
    },
    rule: {
      id: opts.ruleId || '',
      name: '',
      enabled: null,
      actionType: '',
      groupActionCount: 0,
      notifyRuleCreatorOnFailure: [],
    },
    groupDeliveries: {
      count: 0,
      failedCount: 0,
      matchingFailedCount: 0,
      latestFailure: null,
    },
    personDeliveries: {
      count: 0,
      creatorAlertCount: 0,
      matchingCreatorAlertCount: 0,
      latestCreatorAlert: null,
    },
    failures: [{
      code,
      message,
      detail,
    }],
    nextActions: [makeFatalNextAction(code)],
  }
}

function renderMarkdown(summary) {
  const lines = [
    '# DingTalk Group Failure Alert Probe',
    '',
    `- status: ${summary.status}`,
    `- checkedAt: ${summary.checkedAt}`,
    `- apiBase: ${summary.apiBase}`,
    `- sheetId: ${summary.sheetId}`,
    `- ruleId: ${summary.ruleId}`,
    `- recordIdFilter: ${summary.expectations.recordId || 'none'}`,
    `- alertSubject: ${summary.expectations.alertSubject || DEFAULT_ALERT_SUBJECT}`,
    `- authChecked: ${summary.auth.checked}`,
    `- ruleName: ${summary.rule.name || ''}`,
    `- ruleEnabled: ${summary.rule.enabled}`,
    `- groupActionCount: ${summary.rule.groupActionCount}`,
    `- notifyRuleCreatorOnFailure: ${JSON.stringify(summary.rule.notifyRuleCreatorOnFailure)}`,
    '',
    '## Delivery Snapshot',
    '',
    `- groupDeliveryCount: ${summary.groupDeliveries.count}`,
    `- groupFailureCount: ${summary.groupDeliveries.failedCount}`,
    `- matchingGroupFailureCount: ${summary.groupDeliveries.matchingFailedCount}`,
    `- latestGroupFailure: ${summary.groupDeliveries.latestFailure ? summary.groupDeliveries.latestFailure.status || summary.groupDeliveries.latestFailure.id : 'none'}`,
    `- personDeliveryCount: ${summary.personDeliveries.count}`,
    `- creatorAlertCount: ${summary.personDeliveries.creatorAlertCount}`,
    `- matchingCreatorAlertCount: ${summary.personDeliveries.matchingCreatorAlertCount}`,
    `- latestCreatorAlertStatus: ${summary.personDeliveries.latestCreatorAlert?.status || 'none'}`,
    '',
    '## Failures',
    '',
  ]

  if (summary.failures.length === 0) {
    lines.push('- none')
  } else {
    for (const failure of summary.failures) {
      lines.push(`- ${failure.code}: ${failure.message}`)
      if (failure.detail && Object.keys(failure.detail).length > 0) {
        lines.push(`  detail: ${JSON.stringify(failure.detail)}`)
      }
    }
  }

  lines.push('', '## Next Actions', '')
  for (const action of summary.nextActions) {
    lines.push(`- ${action}`)
  }
  lines.push('')
  return lines.join('\n')
}

async function main() {
  let opts = null
  try {
    opts = parseArgs(process.argv.slice(2))
    const summary = await runProbe(opts)
    const outputs = writeOutputs(opts.outputDir, summary)
    console.log(JSON.stringify({
      status: summary.status,
      outputDir: opts.outputDir,
      summaryJson: outputs.jsonPath,
      summaryMd: outputs.mdPath,
      failures: summary.failures.map((failure) => failure.code),
    }, null, 2))
    if (summary.status !== 'PASS') process.exitCode = 1
  } catch (err) {
    const message = redactString(err instanceof Error ? err.message : String(err))
    const fatalOpts = opts || makeFallbackOptions(process.argv.slice(2))
    if (fatalOpts?.outputDir) {
      try {
        const summary = makeFatalSummary(fatalOpts, err)
        const outputs = writeOutputs(fatalOpts.outputDir, summary)
        console.log(JSON.stringify({
          status: summary.status,
          outputDir: fatalOpts.outputDir,
          summaryJson: outputs.jsonPath,
          summaryMd: outputs.mdPath,
          failures: summary.failures.map((failure) => failure.code),
        }, null, 2))
      } catch (writeError) {
        console.error(`${message}; failed to write summary: ${redactString(writeError instanceof Error ? writeError.message : String(writeError))}`)
      }
    } else {
      console.error(message)
    }
    process.exitCode = 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}

export {
  getRuleGroupActions,
  latestCreatorAlert,
  latestGroupFailure,
  parseArgs,
  redactString,
  runProbe,
}

#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_OUTPUT_ROOT = 'output/dingtalk-p4-remote-smoke-status'

const REQUIRED_CHECKS = [
  {
    id: 'create-table-form',
    label: 'Create a table and form view',
    todo: 'Remote smoke: create a table and form view',
    manual: false,
    docSection: 'Smoke 1',
    topLevelLabel: 'Create table and form view',
  },
  {
    id: 'bind-two-dingtalk-groups',
    label: 'Bind at least two DingTalk groups',
    todo: 'Remote smoke: bind at least two DingTalk groups to the table',
    manual: false,
    docSection: 'Smoke 2',
    topLevelLabel: 'Bind two DingTalk groups',
  },
  {
    id: 'set-form-dingtalk-granted',
    label: 'Set the form to dingtalk_granted',
    todo: 'Remote smoke: set the form to `dingtalk_granted`',
    manual: false,
    docSection: 'Smoke 1',
    topLevelLabel: 'Set dingtalk_granted access',
  },
  {
    id: 'send-group-message-form-link',
    label: 'Send a DingTalk group message with a form link',
    todo: 'Remote smoke: send a group message with a form link',
    manual: true,
    docSection: 'Smoke 3',
    topLevelLabel: 'Send group message with form link',
  },
  {
    id: 'authorized-user-submit',
    label: 'Verify an authorized user can open and submit',
    todo: 'Remote smoke: verify an authorized user can open and submit',
    manual: true,
    docSection: 'Smoke 4',
    topLevelLabel: 'Authorized user submit',
  },
  {
    id: 'unauthorized-user-denied',
    label: 'Verify an unauthorized user cannot submit and no record is inserted',
    todo: 'Remote smoke: verify an unauthorized user cannot submit and no record is inserted',
    manual: true,
    docSection: 'Smoke 5',
    topLevelLabel: 'Unauthorized user denied',
  },
  {
    id: 'delivery-history-group-person',
    label: 'Verify group and person delivery history',
    todo: 'Remote smoke: verify delivery history records group and person sends',
    manual: false,
    docSection: 'Smoke 6',
    topLevelLabel: 'Delivery history',
  },
  {
    id: 'no-email-user-create-bind',
    label: 'Create and bind a no-email DingTalk-synced local user',
    todo: 'Checklist: no-email account creation and binding',
    manual: true,
    docSection: 'Smoke 7',
    topLevelLabel: 'No-email account create/bind',
  },
]

const REQUIRED_CHECK_BY_ID = new Map(REQUIRED_CHECKS.map((check) => [check.id, check]))
const VALID_STATUSES = new Set(['pass', 'fail', 'skipped', 'pending', 'missing'])
const REMOTE_SMOKE_PHASES = [
  {
    id: 'bootstrap',
    label: 'Bootstrap remote smoke workspace',
    summary: 'Create the disposable table/form workspace, bind DingTalk groups, and enable dingtalk_granted access.',
    checkIds: [
      'create-table-form',
      'bind-two-dingtalk-groups',
      'set-form-dingtalk-granted',
    ],
  },
  {
    id: 'group-message',
    label: 'Capture DingTalk group message evidence',
    summary: 'Prove the real DingTalk group message is visible and the protected form link is usable from the client.',
    checkIds: [
      'send-group-message-form-link',
    ],
  },
  {
    id: 'client-access',
    label: 'Validate protected form access',
    summary: 'Prove the authorized user can submit and the unauthorized user is blocked with zero record insert.',
    checkIds: [
      'authorized-user-submit',
      'unauthorized-user-denied',
    ],
  },
  {
    id: 'delivery-admin',
    label: 'Validate delivery history and no-email admin flow',
    summary: 'Confirm group/person delivery history and the admin-side no-email DingTalk account bind flow.',
    checkIds: [
      'delivery-history-group-person',
      'no-email-user-create-bind',
    ],
  },
]

function printHelp() {
  console.log(`Usage: node scripts/ops/dingtalk-p4-smoke-status.mjs [options]

Reads DingTalk P4 smoke session/evidence/handoff files and writes a redacted
status report with remaining gaps and next commands. It does not call DingTalk
or staging.

Options:
  --session-dir <dir>           DingTalk P4 smoke session directory
  --session-summary <file>      Optional session-summary.json path
  --evidence <file>             Optional workspace evidence.json path
  --compiled-summary <file>     Optional compiled summary.json path
  --handoff-summary <file>      Optional final handoff-summary.json path
  --publish-check-json <file>   Optional publish-check.json path
  --output-json <file>          Output status JSON, default <session-dir>/smoke-status.json
  --output-md <file>            Output status Markdown, default <session-dir>/smoke-status.md
  --output-todo-md <file>       Output executable TODO Markdown, default <session-dir>/smoke-todo.md
  --require-release-ready       Exit non-zero unless overallStatus is release_ready
  --help                        Show this help
`)
}

function readRequiredValue(argv, index, flag) {
  const next = argv[index + 1]
  if (!next || next.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return next
}

function makeRunId() {
  return `dingtalk-p4-status-${new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')}`
}

function parseArgs(argv) {
  const opts = {
    sessionDir: '',
    sessionSummary: '',
    evidence: '',
    compiledSummary: '',
    handoffSummary: '',
    publishCheckJson: '',
    outputJson: '',
    outputMd: '',
    outputTodoMd: '',
    requireReleaseReady: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--session-dir':
        opts.sessionDir = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--session-summary':
        opts.sessionSummary = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--evidence':
        opts.evidence = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--compiled-summary':
        opts.compiledSummary = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--handoff-summary':
        opts.handoffSummary = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--publish-check-json':
        opts.publishCheckJson = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--output-json':
        opts.outputJson = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--output-md':
        opts.outputMd = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--output-todo-md':
        opts.outputTodoMd = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--require-release-ready':
        opts.requireReleaseReady = true
        break
      case '--help':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (opts.sessionDir) {
    opts.sessionSummary ||= path.join(opts.sessionDir, 'session-summary.json')
    opts.evidence ||= path.join(opts.sessionDir, 'workspace', 'evidence.json')
    opts.compiledSummary ||= path.join(opts.sessionDir, 'compiled', 'summary.json')
    opts.outputJson ||= path.join(opts.sessionDir, 'smoke-status.json')
    opts.outputMd ||= path.join(opts.sessionDir, 'smoke-status.md')
    opts.outputTodoMd ||= path.join(opts.sessionDir, 'smoke-todo.md')
  } else {
    const outputRoot = path.resolve(process.cwd(), DEFAULT_OUTPUT_ROOT, makeRunId())
    opts.outputJson ||= path.join(outputRoot, 'smoke-status.json')
    opts.outputMd ||= path.join(outputRoot, 'smoke-status.md')
    opts.outputTodoMd ||= path.join(outputRoot, 'smoke-todo.md')
  }

  if (!opts.sessionDir && !opts.sessionSummary && !opts.evidence && !opts.compiledSummary && !opts.handoffSummary && !opts.publishCheckJson) {
    throw new Error('provide --session-dir or at least one input file')
  }

  return opts
}

function relativePath(file) {
  if (!file) return ''
  return path.relative(process.cwd(), file).replaceAll('\\', '/')
}

function redactString(value) {
  return String(value ?? '')
    .replace(/(access_token=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/(publicToken=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/([?&](?:sign|timestamp)=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/((?:client_secret|DINGTALK_CLIENT_SECRET|DINGTALK_STATE_SECRET)=)[^\s&]+/gi, '$1<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/\bSEC[A-Za-z0-9+/=_-]{8,}\b/g, 'SEC<redacted>')
    .replace(/\beyJ[A-Za-z0-9._-]{20,}\b/g, '<jwt:redacted>')
}

function sanitizeValue(value) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry))
  if (typeof value === 'object') {
    const next = {}
    for (const [key, entryValue] of Object.entries(value)) {
      next[key] = sanitizeValue(entryValue)
    }
    return next
  }
  return value
}

function readJsonIfExists(file, label) {
  if (!file || !existsSync(file)) return null
  if (!statSync(file).isFile()) {
    throw new Error(`${label} must be a file: ${relativePath(file)}`)
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function normalizeStatus(value) {
  const status = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return VALID_STATUSES.has(status) ? status : 'pending'
}

function checksFromEvidence(evidence) {
  if (!Array.isArray(evidence?.checks)) return new Map()
  return new Map(evidence.checks
    .filter((check) => check && typeof check === 'object' && typeof check.id === 'string')
    .map((check) => [check.id.trim(), check]))
}

function checksFromCompiled(compiledSummary) {
  if (!Array.isArray(compiledSummary?.requiredChecks)) return new Map()
  return new Map(compiledSummary.requiredChecks
    .filter((check) => check && typeof check === 'object' && typeof check.id === 'string')
    .map((check) => [check.id.trim(), check]))
}

function manualIssuesById(compiledSummary) {
  const issues = new Map()
  if (!Array.isArray(compiledSummary?.manualEvidenceIssues)) return issues
  for (const issue of compiledSummary.manualEvidenceIssues) {
    const id = typeof issue?.id === 'string' ? issue.id.trim() : ''
    if (!id) continue
    const list = issues.get(id) ?? []
    list.push({
      code: redactString(issue.code ?? 'manual_evidence_issue'),
      message: redactString(issue.message ?? issue.code ?? 'manual evidence issue'),
      artifactRef: issue.artifactRef ? redactString(issue.artifactRef) : undefined,
    })
    issues.set(id, list)
  }
  return issues
}

function compactSnapshot(value) {
  if (value === null || value === undefined || value === '') return null
  if (Array.isArray(value)) {
    const entries = value
      .map((entry) => compactSnapshot(entry))
      .filter((entry) => entry !== null)
    return entries.length > 0 ? entries : null
  }
  if (typeof value === 'object') {
    const next = {}
    for (const [key, entry] of Object.entries(value)) {
      const compacted = compactSnapshot(entry)
      if (compacted !== null) next[key] = compacted
    }
    return Object.keys(next).length > 0 ? next : null
  }
  return value
}

function evidenceSnapshotForCheck(checkId, evidence) {
  if (!evidence || typeof evidence !== 'object') return null
  switch (checkId) {
    case 'create-table-form':
      return compactSnapshot({
        baseId: evidence.baseId,
        sheetId: evidence.sheetId,
        fieldId: evidence.fieldId,
        formViewId: evidence.formViewId,
      })
    case 'bind-two-dingtalk-groups':
      return compactSnapshot({
        destinationIds: evidence.destinationIds,
        manualTestDeliveryCounts: evidence.manualTestDeliveryCounts,
      })
    case 'set-form-dingtalk-granted':
      return compactSnapshot({
        accessMode: evidence.accessMode,
        formShareStatus: evidence.formShareStatus,
        allowedUserCount: evidence.allowedUserCount,
        allowedMemberGroupCount: evidence.allowedMemberGroupCount,
      })
    case 'send-group-message-form-link':
      return compactSnapshot({
        groupRuleId: evidence.apiBootstrap?.groupRuleId,
        destinationIds: evidence.apiBootstrap?.destinationIds,
        groupRuleDeliveryCount: evidence.apiBootstrap?.groupRuleDeliveryCount,
      })
    case 'authorized-user-submit':
      return compactSnapshot({
        authorizedUserId: evidence.manualTarget?.authorizedUserId,
      })
    case 'unauthorized-user-denied':
      return compactSnapshot({
        unauthorizedUserId: evidence.manualTarget?.unauthorizedUserId,
        submitBlocked: evidence.submitBlocked,
        recordInsertDelta: evidence.recordInsertDelta,
        blockedReason: evidence.blockedReason,
      })
    case 'delivery-history-group-person':
      return compactSnapshot({
        groupRuleDeliveryCount: evidence.groupRuleDeliveryCount,
        personRuleDeliveryCount: evidence.personRuleDeliveryCount,
        personUserCount: evidence.personUserCount,
      })
    case 'no-email-user-create-bind':
      return compactSnapshot({
        targetDingTalkExternalId: evidence.adminEvidence?.targetDingTalkExternalId,
        createdLocalUserId: evidence.adminEvidence?.createdLocalUserId,
        boundDingTalkExternalId: evidence.adminEvidence?.boundDingTalkExternalId,
        accountLinkedAfterRefresh: evidence.adminEvidence?.accountLinkedAfterRefresh,
      })
    default:
      return null
  }
}

function buildRequiredChecks(evidence, compiledSummary) {
  const evidenceChecks = checksFromEvidence(evidence)
  const compiledChecks = checksFromCompiled(compiledSummary)
  const issueMap = manualIssuesById(compiledSummary)

  return REQUIRED_CHECKS.map((required) => {
    const evidenceCheck = evidenceChecks.get(required.id)
    const compiledCheck = compiledChecks.get(required.id)
    const status = normalizeStatus(evidenceCheck?.status ?? compiledCheck?.status ?? 'missing')
    const source = typeof evidenceCheck?.evidence?.source === 'string'
      ? redactString(evidenceCheck.evidence.source)
      : typeof compiledCheck?.evidence?.source === 'string'
        ? redactString(compiledCheck.evidence.source)
        : ''
    const issues = issueMap.get(required.id) ?? []
    const preferredEvidence = evidenceCheck?.evidence ?? compiledCheck?.evidence ?? null
    return {
      id: required.id,
      label: required.label,
      todo: required.todo,
      manual: required.manual,
      docSection: required.docSection,
      topLevelLabel: required.topLevelLabel,
      status,
      source,
      evidenceSnapshot: evidenceSnapshotForCheck(required.id, preferredEvidence),
      manualEvidenceIssueCount: issues.length,
      firstIssueMessage: issues[0]?.message ?? '',
      issues,
    }
  })
}

function buildGaps(requiredChecks) {
  const gaps = []
  for (const check of requiredChecks) {
    if (check.status !== 'pass') {
      gaps.push({
        id: check.id,
        severity: check.status === 'fail' ? 'error' : 'required',
        status: check.status,
        nextAction: check.manual
          ? `complete real DingTalk-client/admin evidence for ${check.id}`
          : `complete API/bootstrap smoke check ${check.id}`,
      })
    }
    for (const issue of check.issues) {
      gaps.push({
        id: check.id,
        severity: 'required',
        status: 'manual_evidence_issue',
        code: issue.code,
        nextAction: issue.message,
      })
    }
  }
  return gaps
}

function hasFailedSessionStep(sessionSummary) {
  if (!Array.isArray(sessionSummary?.steps)) return false
  return sessionSummary.steps.some((step) => {
    if (!step || step.status !== 'fail') return false
    return step.id !== 'strict-compile'
  })
}

function hasFailedEvidence(requiredChecks, compiledSummary) {
  if (requiredChecks.some((check) => check.status === 'fail')) return true
  return Array.isArray(compiledSummary?.failedChecks) && compiledSummary.failedChecks.length > 0
}

function summarizeHandoff(handoffSummary, publishCheck) {
  const handoffStatus = handoffSummary?.status ?? 'not_available'
  const publishStatus = handoffSummary?.publishCheck?.status ?? publishCheck?.status ?? 'not_available'
  const secretFindingCount = Array.isArray(handoffSummary?.publishCheck?.secretFindings)
    ? handoffSummary.publishCheck.secretFindings.length
    : Array.isArray(publishCheck?.secretFindings)
      ? publishCheck.secretFindings.length
      : 0
  const failures = [
    ...(Array.isArray(handoffSummary?.failures) ? handoffSummary.failures : []),
    ...(Array.isArray(publishCheck?.failures) ? publishCheck.failures : []),
  ].map((failure) => redactString(failure))

  return {
    status: handoffStatus,
    publishStatus,
    secretFindingCount,
    failures,
  }
}

function computeOverallStatus({ sessionSummary, compiledSummary, requiredChecks, gaps, handoff }) {
  if (hasFailedSessionStep(sessionSummary) || hasFailedEvidence(requiredChecks, compiledSummary)) return 'fail'
  if (gaps.length > 0) return 'manual_pending'
  if (!sessionSummary || sessionSummary.sessionPhase !== 'finalize' || sessionSummary.finalStrictStatus !== 'pass') {
    return 'finalize_pending'
  }
  if (handoff.status === 'not_available' && handoff.publishStatus === 'not_available') return 'handoff_pending'
  if (handoff.status !== 'pass' || handoff.publishStatus !== 'pass') return 'fail'
  return 'release_ready'
}

function sessionCommand(opts, command) {
  if (!opts.sessionDir) return ''
  return command.replaceAll('<session-dir>', relativePath(opts.sessionDir))
}

function sanitizeName(value) {
  return path
    .basename(value)
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '') || 'session'
}

function packetOutputDirForStatus(opts) {
  if (opts.handoffSummary) return path.dirname(opts.handoffSummary)
  if (opts.publishCheckJson) return path.dirname(opts.publishCheckJson)
  if (opts.sessionDir) {
    return path.resolve(process.cwd(), 'artifacts/dingtalk-staging-evidence-packet', `${sanitizeName(opts.sessionDir)}-final`)
  }
  return path.resolve(process.cwd(), 'artifacts/dingtalk-staging-evidence-packet/<session-name>-final')
}

function finalCloseoutCommand(opts) {
  return sessionCommand(opts, [
    'node scripts/ops/dingtalk-p4-final-closeout.mjs',
    '--session-dir',
    '<session-dir>',
    '--packet-output-dir',
    relativePath(packetOutputDirForStatus(opts)),
    '--docs-output-dir',
    'docs/development',
  ].join(' '))
}

function evidenceRecordCommand(opts) {
  return sessionCommand(opts, [
    'node scripts/ops/dingtalk-p4-evidence-record.mjs',
    '--session-dir',
    '<session-dir>',
    '--check-id',
    '<check-id>',
    '--status',
    'pass',
    '--source',
    '<manual-client|manual-admin>',
    '--operator',
    '<operator>',
    '--summary',
    '"<summary>"',
    '--artifact',
    'artifacts/<check-id>/<file>',
  ].join(' '))
}

function manualSourceForCheck(check) {
  return check.id === 'no-email-user-create-bind' ? 'manual-admin' : 'manual-client'
}

function artifactDirForCheck(checkId) {
  return `workspace/artifacts/${checkId}/`
}

function evidenceRecordCommandForCheck(opts, check) {
  if (!opts.sessionDir || !check.manual) return ''
  const artifactRef = check.id === 'no-email-user-create-bind'
    ? 'artifacts/no-email-user-create-bind/admin-create-bind-result.png'
    : `artifacts/${check.id}/<file>`
  const summary = check.id === 'no-email-user-create-bind'
    ? '"Admin created and bound a no-email DingTalk-synced local user; temporary password is redacted."'
    : '"<summary>"'
  const args = [
    'node scripts/ops/dingtalk-p4-evidence-record.mjs',
    '--session-dir',
    '<session-dir>',
    '--check-id',
    check.id,
    '--status',
    'pass',
    '--source',
    manualSourceForCheck(check),
    '--operator',
    '<operator>',
    '--summary',
    summary,
    '--artifact',
    artifactRef,
  ]
  if (check.id === 'unauthorized-user-denied') {
    args.push(
      '--submit-blocked',
      '--record-insert-delta',
      '0',
      '--blocked-reason',
      '"<visible denial reason>"',
    )
  }
  if (check.id === 'no-email-user-create-bind') {
    args.push(
      '--artifact',
      'artifacts/no-email-user-create-bind/account-linked-after-refresh.png',
      '--admin-email-was-blank',
      '--admin-created-local-user-id',
      '<local-user-id>',
      '--admin-bound-dingtalk-external-id',
      '<dingtalk-external-id>',
      '--admin-account-linked-after-refresh',
    )
  }
  return sessionCommand(opts, args.join(' '))
}

function buildRemoteSmokeTodos(requiredChecks, opts) {
  const items = requiredChecks.map((check) => {
    const completed = check.status === 'pass' && check.manualEvidenceIssueCount === 0
    const firstIssue = check.issues[0]
    const nextAction = completed
      ? 'done'
      : firstIssue?.message
        ? firstIssue.message
        : check.manual
          ? `capture real DingTalk evidence and record ${check.id}`
          : `rerun or inspect API/bootstrap evidence for ${check.id}`
    return {
      id: check.id,
      label: check.label,
      todo: check.todo,
      status: check.status,
      manual: check.manual,
      completed,
      issueCount: check.manualEvidenceIssueCount,
      nextAction,
      artifactDir: check.manual ? artifactDirForCheck(check.id) : '',
      evidenceRecordCommand: completed ? '' : evidenceRecordCommandForCheck(opts, check),
    }
  })

  return {
    total: items.length,
    completed: items.filter((item) => item.completed).length,
    remaining: items.filter((item) => !item.completed).length,
    items,
  }
}

function buildExecutionPlan(remoteSmokeTodos) {
  const itemsById = new Map(remoteSmokeTodos.items.map((item) => [item.id, item]))
  let activePhaseAssigned = false

  const phases = REMOTE_SMOKE_PHASES.map((phase, index) => {
    const steps = phase.checkIds.map((checkId) => {
      const item = itemsById.get(checkId) ?? {
        id: checkId,
        label: REQUIRED_CHECK_BY_ID.get(checkId)?.label ?? checkId,
        todo: REQUIRED_CHECK_BY_ID.get(checkId)?.todo ?? checkId,
        status: 'missing',
        manual: REQUIRED_CHECK_BY_ID.get(checkId)?.manual ?? false,
        completed: false,
        nextAction: 'inspect smoke evidence',
        artifactDir: '',
        evidenceRecordCommand: '',
      }
      return {
        id: item.id,
        label: item.label,
        todo: item.todo,
        status: item.status,
        manual: item.manual,
        completed: item.completed,
        nextAction: item.nextAction,
        artifactDir: item.artifactDir,
        evidenceRecordCommand: item.evidenceRecordCommand,
      }
    })
    const completedChecks = steps.filter((step) => step.completed).length
    const remainingChecks = steps.length - completedChecks
    let status = 'pending'
    if (remainingChecks === 0) {
      status = 'done'
    } else if (!activePhaseAssigned) {
      status = 'in_progress'
      activePhaseAssigned = true
    }
    return {
      id: phase.id,
      label: phase.label,
      summary: phase.summary,
      order: index + 1,
      status,
      totalChecks: steps.length,
      completedChecks,
      remainingChecks,
      steps,
    }
  })

  const currentPhase = phases.find((phase) => phase.status === 'in_progress') ?? null
  const currentStep = currentPhase?.steps.find((step) => !step.completed) ?? null

  return {
    totalPhases: phases.length,
    completedPhases: phases.filter((phase) => phase.status === 'done').length,
    remainingPhases: phases.filter((phase) => phase.status !== 'done').length,
    activePhaseId: currentPhase?.id ?? '',
    phases,
    currentFocus: currentPhase && currentStep
      ? {
          phaseId: currentPhase.id,
          phaseLabel: currentPhase.label,
          checkId: currentStep.id,
          label: currentStep.label,
          todo: currentStep.todo,
          status: currentStep.status,
          manual: currentStep.manual,
          nextAction: currentStep.nextAction,
          artifactDir: currentStep.artifactDir,
          evidenceRecordCommand: currentStep.evidenceRecordCommand,
        }
      : null,
  }
}

function buildNextCommands(overallStatus, opts) {
  const commands = []
  if (!opts.sessionDir) {
    commands.push('node scripts/ops/dingtalk-p4-smoke-session.mjs --env-file <env-file> --output-dir <session-dir>')
    return commands
  }

  if (overallStatus === 'manual_pending') {
    commands.push(evidenceRecordCommand(opts))
  }
  if (overallStatus === 'finalize_pending') {
    commands.push(finalCloseoutCommand(opts))
  }
  if (overallStatus === 'manual_pending' || overallStatus === 'finalize_pending') {
    commands.push(sessionCommand(opts, 'node scripts/ops/dingtalk-p4-smoke-session.mjs --finalize <session-dir>'))
  }
  if (overallStatus === 'handoff_pending' || overallStatus === 'finalize_pending') {
    commands.push(finalCloseoutCommand(opts))
    commands.push(sessionCommand(opts, 'node scripts/ops/dingtalk-p4-final-handoff.mjs --session-dir <session-dir>'))
  }
  if (overallStatus === 'fail') {
    commands.push('inspect failed steps/checks in this status report before rerunning the relevant command')
  }
  if (overallStatus === 'release_ready') {
    commands.push('review the final packet artifacts manually before sharing outside the release team')
  }
  return Array.from(new Set(commands.filter(Boolean)))
}

function buildSummary(opts) {
  const sessionSummary = readJsonIfExists(opts.sessionSummary, 'session summary')
  const evidence = readJsonIfExists(opts.evidence, 'evidence')
  const compiledSummary = readJsonIfExists(opts.compiledSummary, 'compiled summary')
  const handoffSummary = readJsonIfExists(opts.handoffSummary, 'handoff summary')
  const publishCheck = readJsonIfExists(opts.publishCheckJson, 'publish check')

  if (!sessionSummary && !evidence && !compiledSummary && !handoffSummary && !publishCheck) {
    throw new Error('none of the provided input files exist')
  }

  const requiredChecks = buildRequiredChecks(evidence, compiledSummary)
  const gaps = buildGaps(requiredChecks)
  const handoff = summarizeHandoff(handoffSummary, publishCheck)
  const remoteSmokeTodos = buildRemoteSmokeTodos(requiredChecks, opts)
  const executionPlan = buildExecutionPlan(remoteSmokeTodos)
  const overallStatus = computeOverallStatus({
    sessionSummary,
    compiledSummary,
    requiredChecks,
    gaps,
    handoff,
  })

  return {
    tool: 'dingtalk-p4-smoke-status',
    generatedAt: new Date().toISOString(),
    overallStatus,
    sessionPhase: sessionSummary?.sessionPhase ?? 'not_available',
    finalStrictStatus: sessionSummary?.finalStrictStatus ?? 'not_available',
    apiBootstrapStatus: compiledSummary?.apiBootstrapStatus ?? 'not_available',
    remoteClientStatus: compiledSummary?.remoteClientStatus ?? 'not_available',
    inputs: {
      sessionDir: relativePath(opts.sessionDir),
      sessionSummary: opts.sessionSummary && existsSync(opts.sessionSummary) ? relativePath(opts.sessionSummary) : '',
      evidence: opts.evidence && existsSync(opts.evidence) ? relativePath(opts.evidence) : '',
      compiledSummary: opts.compiledSummary && existsSync(opts.compiledSummary) ? relativePath(opts.compiledSummary) : '',
      handoffSummary: opts.handoffSummary && existsSync(opts.handoffSummary) ? relativePath(opts.handoffSummary) : '',
      publishCheckJson: opts.publishCheckJson && existsSync(opts.publishCheckJson) ? relativePath(opts.publishCheckJson) : '',
    },
    totals: {
      requiredChecks: REQUIRED_CHECKS.length,
      passedChecks: requiredChecks.filter((check) => check.status === 'pass').length,
      failedChecks: requiredChecks.filter((check) => check.status === 'fail').length,
      pendingOrMissingChecks: requiredChecks.filter((check) => check.status !== 'pass' && check.status !== 'fail').length,
      manualEvidenceIssues: requiredChecks.reduce((total, check) => total + check.manualEvidenceIssueCount, 0),
      gaps: gaps.length,
    },
    requiredChecks,
    gaps,
    remoteSmokeTodos,
    executionPlan,
    handoff,
    nextCommands: [],
  }
}

function markdownEscape(value) {
  return redactString(value).replaceAll('|', '\\|').replaceAll('\n', '<br>')
}

function renderMarkdown(summary) {
  const checkRows = summary.requiredChecks.map((check) => {
    const issue = check.issues.length ? check.issues.map((entry) => entry.code).join(', ') : ''
    return `| \`${markdownEscape(check.id)}\` | ${markdownEscape(check.status)} | ${check.manual ? 'yes' : 'no'} | ${markdownEscape(check.source)} | ${markdownEscape(issue)} |`
  })
  const todoRows = summary.remoteSmokeTodos.items.map((item) => {
    return `| ${item.completed ? 'done' : 'todo'} | \`${markdownEscape(item.id)}\` | ${markdownEscape(item.status)} | ${item.manual ? 'yes' : 'no'} | ${markdownEscape(item.todo)} |`
  })
  const todoById = new Map(summary.remoteSmokeTodos.items.map((item) => [item.id, item]))
  const phaseRows = summary.executionPlan.phases.map((phase) => {
    return `| ${phase.order}. ${markdownEscape(phase.label)} | ${markdownEscape(phase.status)} | ${phase.completedChecks}/${phase.totalChecks} | ${markdownEscape(phase.summary)} |`
  })
  const topLevelRows = summary.requiredChecks.map((check) => {
    const todo = todoById.get(check.id)
    const snapshot = check.evidenceSnapshot ? JSON.stringify(sanitizeValue(check.evidenceSnapshot)) : ''
    return `| ${markdownEscape(check.docSection)} | \`${markdownEscape(check.id)}\` | ${markdownEscape(check.status)} | ${markdownEscape(snapshot)} | ${markdownEscape(todo?.nextAction ?? check.firstIssueMessage ?? '')} |`
  })
  const gaps = summary.gaps.length
    ? summary.gaps.map((gap) => `- \`${gap.id}\`: ${markdownEscape(gap.nextAction)} (${gap.status})`).join('\n')
    : '- None'
  const commands = summary.nextCommands.length
    ? summary.nextCommands.map((command) => `- \`${markdownEscape(command)}\``).join('\n')
    : '- None'
  const currentFocus = summary.executionPlan.currentFocus
    ? [
        `- Phase: **${markdownEscape(summary.executionPlan.currentFocus.phaseLabel)}**`,
        `- Check: \`${markdownEscape(summary.executionPlan.currentFocus.checkId)}\` - ${markdownEscape(summary.executionPlan.currentFocus.todo)}`,
        `- Next: ${markdownEscape(summary.executionPlan.currentFocus.nextAction)}`,
        ...(summary.executionPlan.currentFocus.artifactDir
          ? [`- Artifacts: \`${markdownEscape(summary.executionPlan.currentFocus.artifactDir)}\``]
          : []),
      ].join('\n')
    : '- None'

  return `# DingTalk P4 Smoke Status

Generated at: ${summary.generatedAt}

Overall status: **${summary.overallStatus}**

Session phase: **${summary.sessionPhase}**

Final strict status: **${summary.finalStrictStatus}**

API bootstrap status: **${summary.apiBootstrapStatus}**

Remote client status: **${summary.remoteClientStatus}**

Handoff status: **${summary.handoff.status}**

Publish status: **${summary.handoff.publishStatus}**

## Required Checks

| Check | Status | Manual | Evidence Source | Issues |
| --- | --- | --- | --- | --- |
${checkRows.join('\n')}

## Remote Smoke TODO

Progress: **${summary.remoteSmokeTodos.completed}/${summary.remoteSmokeTodos.total}** complete, **${summary.remoteSmokeTodos.remaining}** remaining.

| State | Check | Status | Manual | TODO |
| --- | --- | --- | --- | --- |
${todoRows.join('\n')}

## Ordered Execution Plan

Current focus:

${currentFocus}

| Phase | Status | Progress | Scope |
| --- | --- | --- | --- |
${phaseRows.join('\n')}

## Top-level Remote Smoke Steps

| Doc | Check | Status | Evidence Snapshot | Next |
| --- | --- | --- | --- | --- |
${topLevelRows.join('\n')}

## Gaps

${gaps}

## Next Commands

${commands}

## Secret Handling

- This report stores statuses, issue codes, and next actions only; it does not copy raw evidence payloads.
- DingTalk webhook access tokens, SEC secrets, bearer tokens, JWTs, passwords, and public form tokens are redacted from strings before output.
`
}

function renderTodoMarkdown(summary) {
  const phaseSections = summary.executionPlan.phases.map((phase) => {
    const checklist = phase.steps.map((item) => {
      const marker = item.completed ? 'x' : ' '
      const artifactLine = item.artifactDir ? ` Artifacts: \`${markdownEscape(item.artifactDir)}\`.` : ''
      return `- [${marker}] \`${markdownEscape(item.id)}\` - ${markdownEscape(item.todo)}. Status: ${markdownEscape(item.status)}. Next: ${markdownEscape(item.nextAction)}.${artifactLine}`
    })
    return `### ${phase.order}. ${markdownEscape(phase.label)}

Status: **${markdownEscape(phase.status)}**. Progress: **${phase.completedChecks}/${phase.totalChecks}**.

${markdownEscape(phase.summary)}

${checklist.join('\n')}`
  })
  const commands = summary.remoteSmokeTodos.items
    .filter((item) => !item.completed && item.evidenceRecordCommand)
    .map((item) => `- \`${markdownEscape(item.evidenceRecordCommand)}\``)
  const nextCommands = summary.nextCommands.length
    ? summary.nextCommands.map((command) => `- \`${markdownEscape(command)}\``)
    : ['- None']
  const currentFocus = summary.executionPlan.currentFocus
    ? [
        `- Phase: **${markdownEscape(summary.executionPlan.currentFocus.phaseLabel)}**`,
        `- Check: \`${markdownEscape(summary.executionPlan.currentFocus.checkId)}\` - ${markdownEscape(summary.executionPlan.currentFocus.todo)}`,
        `- Next: ${markdownEscape(summary.executionPlan.currentFocus.nextAction)}`,
        ...(summary.executionPlan.currentFocus.artifactDir
          ? [`- Artifacts: \`${markdownEscape(summary.executionPlan.currentFocus.artifactDir)}\``]
          : []),
        ...(summary.executionPlan.currentFocus.evidenceRecordCommand
          ? [`- Recorder: \`${markdownEscape(summary.executionPlan.currentFocus.evidenceRecordCommand)}\``]
          : []),
      ].join('\n')
    : '- None'

  return `# DingTalk P4 Remote Smoke TODO

Generated at: ${summary.generatedAt}

Overall status: **${summary.overallStatus}**

Progress: **${summary.remoteSmokeTodos.completed}/${summary.remoteSmokeTodos.total}** complete, **${summary.remoteSmokeTodos.remaining}** remaining.

## Current Focus

${currentFocus}

## Ordered Phase Plan

${phaseSections.join('\n\n')}

## Evidence Recorder Commands

${commands.length ? commands.join('\n') : '- None'}

## Next Session Commands

${nextCommands.join('\n')}

## Notes

- This TODO file is generated from \`smoke-status.json\` inputs and contains redacted command templates only.
- Put manual artifacts under \`workspace/artifacts/<check-id>/\` before running an evidence recorder command.
- When you use \`dingtalk-p4-evidence-record.mjs\` with \`--session-dir\`, smoke status and TODO files refresh automatically after a successful write.
- Re-run \`dingtalk-p4-smoke-status.mjs\` only for a manual refresh or after direct \`evidence.json\` edits.
`
}

function writeSummary(summary, opts) {
  mkdirSync(path.dirname(opts.outputJson), { recursive: true })
  mkdirSync(path.dirname(opts.outputMd), { recursive: true })
  mkdirSync(path.dirname(opts.outputTodoMd), { recursive: true })
  writeFileSync(opts.outputJson, `${JSON.stringify(sanitizeValue(summary), null, 2)}\n`, 'utf8')
  writeFileSync(opts.outputMd, renderMarkdown(summary), 'utf8')
  writeFileSync(opts.outputTodoMd, renderTodoMarkdown(summary), 'utf8')
  console.log(`Wrote ${relativePath(opts.outputJson)}`)
  console.log(`Wrote ${relativePath(opts.outputMd)}`)
  console.log(`Wrote ${relativePath(opts.outputTodoMd)}`)
}

try {
  const opts = parseArgs(process.argv.slice(2))
  const summary = buildSummary(opts)
  summary.nextCommands = buildNextCommands(summary.overallStatus, opts)
  writeSummary(summary, opts)
  if (opts.requireReleaseReady && summary.overallStatus !== 'release_ready') {
    process.exit(1)
  }
} catch (error) {
  console.error(`[dingtalk-p4-smoke-status] ERROR: ${redactString(error instanceof Error ? error.message : String(error))}`)
  process.exit(1)
}

#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_OUTPUT_ROOT = 'output/dingtalk-p4-remote-smoke'

const REQUIRED_CHECKS = [
  {
    id: 'create-table-form',
    label: 'Create a table and form view',
    todo: 'Remote smoke: create a table and form view',
  },
  {
    id: 'bind-two-dingtalk-groups',
    label: 'Bind at least two DingTalk groups',
    todo: 'Remote smoke: bind at least two DingTalk groups to the table',
  },
  {
    id: 'set-form-dingtalk-granted',
    label: 'Set the form to dingtalk_granted',
    todo: 'Remote smoke: set the form to `dingtalk_granted`',
  },
  {
    id: 'send-group-message-form-link',
    label: 'Send a DingTalk group message with a form link',
    todo: 'Remote smoke: send a group message with a form link',
  },
  {
    id: 'authorized-user-submit',
    label: 'Verify an authorized user can open and submit',
    todo: 'Remote smoke: verify an authorized user can open and submit',
  },
  {
    id: 'unauthorized-user-denied',
    label: 'Verify an unauthorized user cannot submit and no record is inserted',
    todo: 'Remote smoke: verify an unauthorized user cannot submit and no record is inserted',
  },
  {
    id: 'delivery-history-group-person',
    label: 'Verify group and person delivery history',
    todo: 'Remote smoke: verify delivery history records group and person sends',
  },
  {
    id: 'no-email-user-create-bind',
    label: 'Create and bind a no-email DingTalk-synced local user',
    todo: 'Checklist: no-email account creation and binding',
  },
]

const CHECK_ID_SET = new Set(REQUIRED_CHECKS.map((check) => check.id))
const VALID_STATUSES = new Set(['pass', 'fail', 'skipped', 'pending'])
const MAX_SECRET_SCAN_BYTES = 2 * 1024 * 1024
const SECRET_PATTERNS = [
  {
    name: 'dingtalk_robot_webhook',
    regex: /https:\/\/oapi\.dingtalk\.com\/robot\/send\?[^\s"'`<>]*access_token=(?!<redacted>|\$|%24|\(\?)[^\s&"'`<>]{8,}/i,
  },
  {
    name: 'access_token_param',
    regex: /(?:^|[?&])access_token=(?!<redacted>|\$|%24|replace-me|\(\?)[A-Za-z0-9._~+/=-]{16,}/i,
  },
  {
    name: 'bearer_token',
    regex: /\bBearer\s+(?!<redacted>|\$|\{)[A-Za-z0-9._~+/=-]{20,}/i,
  },
  {
    name: 'dingtalk_sec_secret',
    regex: /\bSEC(?=[A-Za-z0-9+/=-]{12,}\b)(?=[A-Za-z0-9+/=-]*\d)[A-Za-z0-9+/=-]{12,}\b/,
  },
  {
    name: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    name: 'dingtalk_secret_assignment',
    regex: /\b(?:DINGTALK_CLIENT_SECRET|DINGTALK_STATE_SECRET|client_secret)\s*=\s*(?!<redacted>|replace-me|\$|\s|$)[^\s&"'`<>]{8,}/i,
  },
  {
    name: 'public_form_token',
    regex: /\bpublicToken=(?!<redacted>|\$)[A-Za-z0-9._~+/=-]{12,}/i,
  },
]
const API_BOOTSTRAP_CHECK_IDS = new Set([
  'create-table-form',
  'bind-two-dingtalk-groups',
  'set-form-dingtalk-granted',
  'delivery-history-group-person',
])
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
  console.log(`Usage: node scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs [options]

Compiles a manually executed DingTalk P4 remote-smoke evidence JSON file into
redacted summary artifacts. It does not call DingTalk or staging.

Options:
  --input <file>           Evidence JSON to compile
  --output-dir <dir>       Output directory, default ${DEFAULT_OUTPUT_ROOT}/<run-id>
  --init-template <file>   Write an editable evidence template and exit
  --init-kit <dir>         Write evidence.json plus manual evidence folders/checklist and exit
  --allow-external-artifact-refs
                           Allow URL artifact refs for manual evidence instead of requiring local files
  --strict                 Exit non-zero unless all required checks pass
  --help                   Show this help

Examples:
  node scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs \\
    --init-template output/dingtalk-p4-remote-smoke/evidence.json

  node scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs \\
    --init-kit output/dingtalk-p4-remote-smoke/142-manual-kit

  node scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs \\
    --input output/dingtalk-p4-remote-smoke/evidence.json \\
    --output-dir output/dingtalk-p4-remote-smoke/20260422 \\
    --strict
`)
}

function readRequiredValue(argv, index, flag) {
  const next = argv[index + 1]
  if (!next || next.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return next
}

function parseArgs(argv) {
  const opts = {
    input: null,
    outputDir: null,
    initTemplate: null,
    initKit: null,
    allowExternalArtifactRefs: false,
    strict: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--input':
        opts.input = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--output-dir':
        opts.outputDir = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--init-template':
        opts.initTemplate = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--init-kit':
        opts.initKit = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--strict':
        opts.strict = true
        break
      case '--allow-external-artifact-refs':
        opts.allowExternalArtifactRefs = true
        break
      case '--help':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  const initModes = [opts.initTemplate, opts.initKit].filter(Boolean).length
  if (initModes > 1 || (initModes > 0 && opts.input)) {
    throw new Error('--init-template, --init-kit, and --input are mutually exclusive')
  }

  return opts
}

function nowIso() {
  return new Date().toISOString()
}

function makeRunId() {
  return `dingtalk-p4-${new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')}`
}

function makeTemplateEvidence(checkId) {
  const manualRequirement = MANUAL_EVIDENCE_BY_ID.get(checkId)
  if (manualRequirement) {
    return {
      source: manualRequirement.source,
      operator: '',
      performedAt: '',
      summary: '',
      artifacts: [],
      instructions: `Required when status is pass: ${manualRequirement.label}; include real DingTalk-client/admin evidence, not API bootstrap output.`,
      suggestedArtifacts: manualRequirement.suggestedArtifacts ?? [],
      ...(checkId === 'no-email-user-create-bind'
        ? {
            adminEvidence: {
              emailWasBlank: null,
              createdLocalUserId: '',
              boundDingTalkExternalId: '',
              accountLinkedAfterRefresh: null,
              temporaryPasswordRedacted: true,
            },
          }
        : {}),
    }
  }

  return {
    source: API_BOOTSTRAP_CHECK_IDS.has(checkId) ? 'api-bootstrap' : '',
    notes: '',
  }
}

function makeTemplate() {
  return {
    runId: makeRunId(),
    executedAt: null,
    environment: {
      apiBase: '',
      webBase: '',
      branch: '',
      commit: '',
      operator: '',
    },
    notes: 'Fill this file after executing docs/dingtalk-remote-smoke-checklist-20260422.md. Do not paste DingTalk webhook tokens, SEC secrets, bearer tokens, passwords, or admin tokens.',
    checks: REQUIRED_CHECKS.map((check) => ({
      id: check.id,
      label: check.label,
      status: 'pending',
      evidence: makeTemplateEvidence(check.id),
    })),
    artifacts: [],
  }
}

function writeTemplate(file) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(makeTemplate(), null, 2)}\n`, 'utf8')
  console.log(`Wrote ${path.relative(process.cwd(), file)}`)
}

function artifactDirForCheck(checkId) {
  return path.join('artifacts', checkId)
}

function renderManualEvidenceChecklist() {
  const rows = MANUAL_EVIDENCE_REQUIREMENTS.map((requirement) => {
    const suggested = Array.isArray(requirement.suggestedArtifacts) && requirement.suggestedArtifacts.length
      ? requirement.suggestedArtifacts.map((artifact) => `\`${artifact}\``).join('<br>')
      : `\`${artifactDirForCheck(requirement.id)}/\``
    return `| \`${requirement.id}\` | \`${requirement.source}\` | ${requirement.label} | ${suggested} |`
  })

  return `# DingTalk P4 Manual Evidence Kit

Use this kit after running \`scripts/ops/dingtalk-p4-remote-smoke.mjs\` or after manually executing \`docs/dingtalk-remote-smoke-checklist-20260422.md\`.

## Required Manual Evidence

| Check ID | Required Source | What It Proves | Suggested Artifacts |
| --- | --- | --- | --- |
${rows.join('\n')}

## No-email Admin Evidence

- Create a local user from a synced DingTalk account while leaving email empty.
- Capture the create-and-bind result panel without exposing the temporary password.
- Capture the refreshed account row showing the local user link.
- Record \`evidence.adminEvidence.emailWasBlank: true\`, \`createdLocalUserId\`, \`boundDingTalkExternalId\`, and \`accountLinkedAfterRefresh: true\` when updating \`evidence.json\`.

## Fill Rules

- Keep \`status: "pending"\` until the real DingTalk-client or admin action has been performed.
- When setting one of the checks above to \`pass\`, fill \`evidence.operator\`, \`evidence.performedAt\`, \`evidence.summary\`, and \`evidence.artifacts\`.
- Artifact refs should point to non-empty files captured during the real smoke run. Put them under \`artifacts/<check-id>/\` next to \`evidence.json\`.
- External URL artifact refs are rejected by default in strict mode. Use \`--allow-external-artifact-refs\` only when the artifact store is controlled and durable.
- Do not paste DingTalk robot full webhook URLs, \`SEC...\` secrets, bearer tokens, admin tokens, public form tokens, temporary passwords, or raw cookies.

## Compile

\`\`\`bash
node scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs \\
  --input evidence.json \\
  --output-dir compiled \\
  --strict
\`\`\`
`
}

function writeManualEvidenceKit(dir) {
  mkdirSync(dir, { recursive: true })
  const evidencePath = path.join(dir, 'evidence.json')
  const checklistPath = path.join(dir, 'manual-evidence-checklist.md')
  writeFileSync(evidencePath, `${JSON.stringify(makeTemplate(), null, 2)}\n`, 'utf8')
  writeFileSync(checklistPath, renderManualEvidenceChecklist(), 'utf8')
  for (const requirement of MANUAL_EVIDENCE_REQUIREMENTS) {
    mkdirSync(path.join(dir, artifactDirForCheck(requirement.id)), { recursive: true })
  }
  console.log(`Wrote ${path.relative(process.cwd(), evidencePath)}`)
  console.log(`Wrote ${path.relative(process.cwd(), checklistPath)}`)
}

function parseEvidence(file) {
  if (!existsSync(file)) {
    throw new Error(`input evidence file does not exist: ${file}`)
  }

  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`failed to parse evidence JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function sanitizeName(value) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : makeRunId()
  return raw.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || makeRunId()
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

function redactString(value) {
  return value
    .replace(/(access_token=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/(publicToken=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/([?&](?:sign|timestamp)=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/((?:client_secret|DINGTALK_CLIENT_SECRET|DINGTALK_STATE_SECRET)=)[^\s&]+/gi, '$1<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/\bSEC[A-Za-z0-9+/=_-]{8,}\b/g, 'SEC<redacted>')
    .replace(/\beyJ[A-Za-z0-9._-]{20,}\b/g, '<jwt:redacted>')
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

function normalizeStatus(value) {
  const status = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return VALID_STATUSES.has(status) ? status : 'pending'
}

function normalizeChecks(evidence) {
  if (!Array.isArray(evidence?.checks)) {
    throw new Error('evidence.checks must be an array')
  }

  const seen = new Set()
  const duplicates = []
  const checks = evidence.checks.map((check, index) => {
    if (!check || typeof check !== 'object' || Array.isArray(check)) {
      throw new Error(`evidence.checks[${index}] must be an object`)
    }
    const id = typeof check.id === 'string' ? check.id.trim() : ''
    if (!id) throw new Error(`evidence.checks[${index}].id is required`)
    if (seen.has(id)) duplicates.push(id)
    seen.add(id)
    return {
      ...check,
      id,
      status: normalizeStatus(check.status),
      required: CHECK_ID_SET.has(id),
    }
  })

  if (duplicates.length > 0) {
    throw new Error(`duplicate check ids: ${Array.from(new Set(duplicates)).join(', ')}`)
  }

  return checks
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isDateLikeString(value) {
  if (!isNonEmptyString(value)) return false
  const time = Date.parse(value)
  return Number.isFinite(time)
}

function normalizeEvidenceSource(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return ''
  const source = evidence.source ?? evidence.evidenceSource ?? evidence.kind
  return isNonEmptyString(source) ? source.trim() : ''
}

function normalizeArtifactRefsFromValue(value) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeArtifactRefsFromValue(entry))
  }
  if (value === null || value === undefined) return []
  if (typeof value === 'string') return [value]
  if (value && typeof value === 'object') {
    for (const key of ['path', 'file', 'url', 'href']) {
      if (Object.hasOwn(value, key)) return [value[key]]
    }
  }
  return [value]
}

function collectArtifactRefs(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return []
  const artifactCandidates = [
    evidence.artifacts,
    evidence.artifactRefs,
    evidence.screenshots,
    evidence.files,
  ]
  return artifactCandidates.flatMap((candidate) => normalizeArtifactRefsFromValue(candidate))
}

function hasArtifactRefs(evidence) {
  return collectArtifactRefs(evidence).length > 0
}

function hasSummary(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return false
  return isNonEmptyString(evidence.summary)
    || isNonEmptyString(evidence.notes)
    || isNonEmptyString(evidence.resultSummary)
}

function isExternalArtifactRef(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
}

function artifactIssue(id, code, message, artifactRef) {
  return {
    id,
    code,
    message,
    ...(typeof artifactRef === 'string' && artifactRef ? { artifactRef: redactString(artifactRef) } : {}),
  }
}

function isAbsoluteArtifactPath(value) {
  return path.isAbsolute(value) || path.win32.isAbsolute(value) || value.replaceAll('\\', '/').startsWith('//')
}

function isLikelyText(buffer) {
  return !buffer.includes(0)
}

function scanArtifactFileForSecrets(checkId, artifactRef, file) {
  const stats = statSync(file)
  if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_SECRET_SCAN_BYTES) return []
  const buffer = readFileSync(file)
  if (!isLikelyText(buffer)) return []
  const content = buffer.toString('utf8')
  const issues = []
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.regex.test(content)) {
      issues.push(artifactIssue(
        checkId,
        'artifact_secret_detected',
        `${checkId} artifact file contains secret-like value (${pattern.name})`,
        artifactRef,
      ))
    }
  }
  return issues
}

function validateManualArtifactRefs(checkId, evidence, evidenceDir, opts) {
  const issues = []
  const refs = collectArtifactRefs(evidence)
  const expectedPrefix = `artifacts/${checkId}/`
  const evidenceRoot = path.resolve(evidenceDir)
  for (const ref of refs) {
    if (!isNonEmptyString(ref)) {
      issues.push(artifactIssue(checkId, 'artifact_ref_invalid', `${checkId} has an empty artifact reference`))
      continue
    }

    const trimmed = ref.trim()
    if (isExternalArtifactRef(trimmed)) {
      if (!opts.allowExternalArtifactRefs) {
        issues.push(artifactIssue(checkId, 'artifact_ref_external_disallowed', `${checkId} external artifact refs require --allow-external-artifact-refs`, trimmed))
      }
      continue
    }

    if (isAbsoluteArtifactPath(trimmed)) {
      issues.push(artifactIssue(checkId, 'artifact_ref_not_relative', `${checkId} artifact refs must be relative paths`, trimmed))
      continue
    }

    const normalizedInput = trimmed.replaceAll('\\', '/')
    const rawSegments = normalizedInput.split('/').filter(Boolean)
    const normalizedRef = path.posix.normalize(normalizedInput)
    if (rawSegments.includes('..') || normalizedRef.startsWith('../') || normalizedRef === '..') {
      issues.push(artifactIssue(checkId, 'artifact_ref_path_traversal', `${checkId} artifact refs cannot traverse outside the evidence directory`, trimmed))
      continue
    }
    if (!normalizedRef.startsWith(expectedPrefix)) {
      issues.push(artifactIssue(checkId, 'artifact_ref_wrong_folder', `${checkId} artifact refs must live under ${expectedPrefix}`, trimmed))
      continue
    }

    const fullPath = path.resolve(evidenceDir, normalizedRef)
    if (fullPath !== evidenceRoot && !fullPath.startsWith(`${evidenceRoot}${path.sep}`)) {
      issues.push(artifactIssue(checkId, 'artifact_ref_path_traversal', `${checkId} artifact refs cannot traverse outside the evidence directory`, trimmed))
      continue
    }
    if (!existsSync(fullPath)) {
      issues.push(artifactIssue(checkId, 'artifact_ref_missing', `${checkId} artifact file does not exist`, trimmed))
      continue
    }
    const stat = statSync(fullPath)
    if (!stat.isFile()) {
      issues.push(artifactIssue(checkId, 'artifact_ref_not_file', `${checkId} artifact ref must point to a file`, trimmed))
      continue
    }
    if (stat.size <= 0) {
      issues.push(artifactIssue(checkId, 'artifact_ref_empty', `${checkId} artifact file is empty`, trimmed))
      continue
    }
    issues.push(...scanArtifactFileForSecrets(checkId, normalizedRef, fullPath))
  }
  return issues
}

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function nonNegativeInteger(value) {
  const number = finiteNumber(value)
  return number !== null && Number.isInteger(number) && number >= 0 ? number : null
}

function hasZeroRecordInsertDelta(evidence) {
  const delta = nonNegativeInteger(evidence.recordInsertDelta)
  if (delta !== null) return delta === 0
  const before = nonNegativeInteger(evidence.beforeRecordCount)
  const after = nonNegativeInteger(evidence.afterRecordCount)
  return before !== null && after !== null && before === after
}

function validateUnauthorizedDeniedEvidence(evidence) {
  const issues = []
  if (evidence.submitBlocked !== true) {
    issues.push({
      id: 'unauthorized-user-denied',
      code: 'submit_blocked_required',
      message: 'unauthorized-user-denied pass evidence requires evidence.submitBlocked=true',
    })
  }
  const countValues = [
    ['recordInsertDelta', evidence.recordInsertDelta],
    ['beforeRecordCount', evidence.beforeRecordCount],
    ['afterRecordCount', evidence.afterRecordCount],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '')
  if (countValues.some(([, value]) => nonNegativeInteger(value) === null)) {
    issues.push({
      id: 'unauthorized-user-denied',
      code: 'record_count_non_negative_integer_required',
      message: 'unauthorized-user-denied record counts must be non-negative integers',
    })
  }
  if (!hasZeroRecordInsertDelta(evidence)) {
    issues.push({
      id: 'unauthorized-user-denied',
      code: 'record_insert_delta_zero_required',
      message: 'unauthorized-user-denied pass evidence requires evidence.recordInsertDelta=0 or equal beforeRecordCount/afterRecordCount',
    })
  }
  if (!isNonEmptyString(evidence.blockedReason) && !isNonEmptyString(evidence.errorSummary) && !isNonEmptyString(evidence.visibleErrorSummary)) {
    issues.push({
      id: 'unauthorized-user-denied',
      code: 'blocked_reason_required',
      message: 'unauthorized-user-denied pass evidence requires evidence.blockedReason, evidence.errorSummary, or evidence.visibleErrorSummary',
    })
  }
  return issues
}

function validateNoEmailAdminEvidence(evidence) {
  const issues = []
  const adminEvidence = evidence?.adminEvidence
  if (!adminEvidence || typeof adminEvidence !== 'object' || Array.isArray(adminEvidence)) {
    return [{
      id: 'no-email-user-create-bind',
      code: 'admin_evidence_object_required',
      message: 'no-email-user-create-bind pass evidence requires evidence.adminEvidence',
    }]
  }
  if (adminEvidence.emailWasBlank !== true) {
    issues.push({
      id: 'no-email-user-create-bind',
      code: 'email_was_blank_required',
      message: 'no-email-user-create-bind pass evidence requires evidence.adminEvidence.emailWasBlank=true',
    })
  }
  if (!isNonEmptyString(adminEvidence.createdLocalUserId)) {
    issues.push({
      id: 'no-email-user-create-bind',
      code: 'created_local_user_id_required',
      message: 'no-email-user-create-bind pass evidence requires evidence.adminEvidence.createdLocalUserId',
    })
  }
  if (!isNonEmptyString(adminEvidence.boundDingTalkExternalId)) {
    issues.push({
      id: 'no-email-user-create-bind',
      code: 'bound_dingtalk_external_id_required',
      message: 'no-email-user-create-bind pass evidence requires evidence.adminEvidence.boundDingTalkExternalId',
    })
  }
  if (adminEvidence.accountLinkedAfterRefresh !== true) {
    issues.push({
      id: 'no-email-user-create-bind',
      code: 'account_linked_after_refresh_required',
      message: 'no-email-user-create-bind pass evidence requires evidence.adminEvidence.accountLinkedAfterRefresh=true',
    })
  }
  if (adminEvidence.temporaryPasswordRedacted !== true) {
    issues.push({
      id: 'no-email-user-create-bind',
      code: 'temporary_password_redacted_required',
      message: 'no-email-user-create-bind pass evidence requires evidence.adminEvidence.temporaryPasswordRedacted=true',
    })
  }
  return issues
}

function validateManualEvidenceRequirements(checksById, evidenceDir, opts) {
  const issues = []
  for (const requirement of MANUAL_EVIDENCE_REQUIREMENTS) {
    const check = checksById.get(requirement.id)
    if (!check || normalizeStatus(check.status) !== 'pass') continue

    const evidence = check.evidence
    const source = normalizeEvidenceSource(evidence)
    if (source !== requirement.source) {
      issues.push({
        id: requirement.id,
        code: 'manual_source_required',
        message: `${requirement.id} requires evidence.source="${requirement.source}" for ${requirement.label}`,
      })
    }
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
      issues.push({
        id: requirement.id,
        code: 'manual_evidence_object_required',
        message: `${requirement.id} requires an evidence object`,
      })
      continue
    }
    if (!isNonEmptyString(evidence.operator) && !isNonEmptyString(evidence.performedBy)) {
      issues.push({
        id: requirement.id,
        code: 'operator_required',
        message: `${requirement.id} requires evidence.operator or evidence.performedBy`,
      })
    }
    const performedAt = evidence.performedAt ?? evidence.executedAt ?? evidence.timestamp
    if (!isDateLikeString(performedAt)) {
      issues.push({
        id: requirement.id,
        code: 'performed_at_required',
        message: `${requirement.id} requires evidence.performedAt, evidence.executedAt, or evidence.timestamp as a valid date`,
      })
    }
    if (!hasArtifactRefs(evidence)) {
      issues.push({
        id: requirement.id,
        code: 'artifact_refs_required',
        message: `${requirement.id} requires per-check evidence.artifacts, evidence.artifactRefs, evidence.screenshots, or evidence.files`,
      })
    } else {
      issues.push(...validateManualArtifactRefs(requirement.id, evidence, evidenceDir, opts))
    }
    if (!hasSummary(evidence)) {
      issues.push({
        id: requirement.id,
        code: 'summary_required',
        message: `${requirement.id} requires evidence.summary, evidence.notes, or evidence.resultSummary`,
      })
    }
    if (requirement.id === 'unauthorized-user-denied') {
      issues.push(...validateUnauthorizedDeniedEvidence(evidence))
    }
    if (requirement.id === 'no-email-user-create-bind') {
      issues.push(...validateNoEmailAdminEvidence(evidence))
    }
  }
  return issues
}

function buildSummary(evidence, inputFile, outputDir, opts = {}) {
  const checks = normalizeChecks(evidence)
  const byId = new Map(checks.map((check) => [check.id, check]))
  const requiredRows = REQUIRED_CHECKS.map((required) => {
    const check = byId.get(required.id)
    const status = check ? normalizeStatus(check.status) : 'missing'
    return {
      ...required,
      status,
      evidence: check?.evidence ?? null,
      notes: check?.notes ?? null,
    }
  })
  const missingRequiredChecks = requiredRows.filter((check) => check.status === 'missing').map((check) => check.id)
  const requiredChecksNotPassed = requiredRows
    .filter((check) => check.status !== 'pass')
    .map((check) => ({ id: check.id, status: check.status }))
  const failedChecks = checks.filter((check) => check.status === 'fail').map((check) => check.id)
  const unknownChecks = checks.filter((check) => !CHECK_ID_SET.has(check.id)).map((check) => check.id)
  const manualEvidenceIssues = validateManualEvidenceRequirements(byId, path.dirname(inputFile), opts)
  const apiBootstrapRequired = requiredRows.filter((check) => API_BOOTSTRAP_CHECK_IDS.has(check.id))
  const apiBootstrapStatus = apiBootstrapRequired.every((check) => check.status === 'pass') ? 'pass' : 'fail'
  const remoteClientStatus = requiredChecksNotPassed.length === 0 && manualEvidenceIssues.length === 0 ? 'pass' : 'fail'
  const overallStatus = requiredChecksNotPassed.length === 0 && failedChecks.length === 0 && manualEvidenceIssues.length === 0 ? 'pass' : 'fail'
  const sanitizedEvidence = sanitizeValue(evidence)

  return {
    tool: 'compile-dingtalk-p4-smoke-evidence',
    generatedAt: nowIso(),
    source: path.relative(process.cwd(), inputFile).replaceAll('\\', '/'),
    outputDir: path.relative(process.cwd(), outputDir).replaceAll('\\', '/'),
    overallStatus,
    apiBootstrapStatus,
    remoteClientStatus,
    totals: {
      totalChecks: checks.length,
      requiredChecks: REQUIRED_CHECKS.length,
      passedChecks: checks.filter((check) => check.status === 'pass').length,
      failedChecks: checks.filter((check) => check.status === 'fail').length,
      skippedChecks: checks.filter((check) => check.status === 'skipped').length,
      pendingChecks: checks.filter((check) => check.status === 'pending').length,
      missingRequiredChecks: missingRequiredChecks.length,
      unknownChecks: unknownChecks.length,
    },
    requiredChecks: sanitizeValue(requiredRows),
    missingRequiredChecks,
    requiredChecksNotPassed,
    failedChecks,
    unknownChecks,
    manualEvidenceIssues: sanitizeValue(manualEvidenceIssues),
    sanitizedEvidence,
  }
}

function markdownEscape(value) {
  return String(value ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\n', '<br>')
}

function compactEvidence(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'object') {
    const preferred = value.summary ?? value.notes ?? value.path ?? value.url
    if (typeof preferred === 'string') return redactString(preferred)
    const json = JSON.stringify(sanitizeValue(value))
    return json.length > 180 ? `${json.slice(0, 177)}...` : json
  }
  return String(value)
}

function renderMarkdown(summary) {
  const requiredLines = summary.requiredChecks.map((check) => {
    const evidence = compactEvidence(check.evidence ?? check.notes)
    return `| \`${markdownEscape(check.id)}\` | ${markdownEscape(check.label)} | ${markdownEscape(check.status)} | ${markdownEscape(evidence)} |`
  })
  const unknownLines = summary.unknownChecks.length
    ? summary.unknownChecks.map((id) => `- \`${id}\``).join('\n')
    : '- None'
  const failures = summary.requiredChecksNotPassed.length
    ? summary.requiredChecksNotPassed.map((check) => `- \`${check.id}\`: ${check.status}`).join('\n')
    : '- None'
  const manualIssues = summary.manualEvidenceIssues.length
    ? summary.manualEvidenceIssues.map((issue) => `- \`${issue.id}\`: ${issue.message}`).join('\n')
    : '- None'

  return `# DingTalk P4 Remote Smoke Evidence Summary

Generated at: ${summary.generatedAt}

Source: \`${summary.source}\`

Overall status: **${summary.overallStatus}**

API bootstrap status: **${summary.apiBootstrapStatus}**

Remote client status: **${summary.remoteClientStatus}**

## Required Checks

| ID | Required Check | Status | Evidence |
| --- | --- | --- | --- |
${requiredLines.join('\n')}

## Required Checks Not Passed

${failures}

## Manual Evidence Issues

${manualIssues}

## Unknown Optional Checks

${unknownLines}

## Notes

- This summary is generated from operator-provided evidence after executing \`docs/dingtalk-remote-smoke-checklist-20260422.md\`.
- DingTalk webhook access tokens, SEC secrets, bearer tokens, JWTs, passwords, and public form tokens are redacted before writing artifacts.
- A \`pass\` summary means all required checks passed and real DingTalk-client/admin checks include per-check manual evidence metadata. It does not independently call DingTalk or staging.
`
}

function compileEvidence(opts) {
  if (!opts.input) {
    throw new Error('--input is required unless --init-template is used')
  }

  const evidence = parseEvidence(opts.input)
  const runId = sanitizeName(evidence?.runId)
  const outputDir = opts.outputDir ?? path.resolve(process.cwd(), DEFAULT_OUTPUT_ROOT, runId)
  mkdirSync(outputDir, { recursive: true })

  const summary = buildSummary(evidence, opts.input, outputDir, {
    allowExternalArtifactRefs: opts.allowExternalArtifactRefs,
  })
  const summaryJsonPath = path.join(outputDir, 'summary.json')
  const summaryMdPath = path.join(outputDir, 'summary.md')
  const redactedEvidencePath = path.join(outputDir, 'evidence.redacted.json')

  writeFileSync(redactedEvidencePath, `${JSON.stringify(summary.sanitizedEvidence, null, 2)}\n`, 'utf8')
  writeFileSync(summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  writeFileSync(summaryMdPath, renderMarkdown(summary), 'utf8')

  console.log(`Wrote ${path.relative(process.cwd(), redactedEvidencePath)}`)
  console.log(`Wrote ${path.relative(process.cwd(), summaryJsonPath)}`)
  console.log(`Wrote ${path.relative(process.cwd(), summaryMdPath)}`)

  if (opts.strict && summary.overallStatus !== 'pass') {
    const notPassed = summary.requiredChecksNotPassed.map((check) => `${check.id}:${check.status}`)
    const manualIssues = summary.manualEvidenceIssues.map((issue) => `${issue.id}:${issue.code}`)
    throw new Error(`DingTalk P4 smoke evidence did not pass: ${[...notPassed, ...manualIssues].join(', ')}`)
  }

  return summary
}

try {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.initTemplate) {
    writeTemplate(opts.initTemplate)
  } else if (opts.initKit) {
    writeManualEvidenceKit(opts.initKit)
  } else {
    compileEvidence(opts)
  }
} catch (error) {
  console.error(`[compile-dingtalk-p4-smoke-evidence] ERROR: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

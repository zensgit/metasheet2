#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_BASE_URL = process.env.METASHEET_BASE_URL || process.env.PUBLIC_APP_URL || 'http://127.0.0.1:8081'
const DEFAULT_OUTPUT_ROOT = 'output/integration-issue1542-seed-workbench-systems'
const DEFAULT_TENANT_ID = process.env.METASHEET_TENANT_ID || process.env.TENANT_ID || 'default'
const DEFAULT_PROJECT_ID = process.env.METASHEET_PROJECT_ID || process.env.PROJECT_ID || 'default'
const DEFAULT_K3_BASE_URL = 'http://127.0.0.1/K3API/'
const SECRET_QUERY_PARAM_PATTERN = /^(access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?id|api[_-]?key|token|password|passwd|pwd|secret|signature|sign|auth|authorization)$/i
const TOKEN_PATTERN = /\b(?:Bearer\s+)?[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g
const REQUIRED_STANDARD_MATERIAL_FIELDS = ['code', 'name', 'uom']

class Issue1542SeedError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'Issue1542SeedError'
    this.details = details
  }
}

function printHelp() {
  console.log(`Usage: node scripts/ops/integration-issue1542-seed-workbench-systems.mjs [options]

Seeds the minimum Data Factory external-system metadata required by the
postdeploy --issue1542-workbench-smoke check. It writes metadata only:
no real K3 credentials, no dry-run, no Save-only, no Submit, no Audit.

Options:
  --base-url <url>                     MetaSheet base URL, default ${DEFAULT_BASE_URL}
  --auth-token <token>                 Bearer token. Prefer --token-file.
  --token-file <path>                  File containing bearer token.
  --tenant-id <id>                     Tenant scope, default ${DEFAULT_TENANT_ID}
  --workspace-id <id>                  Optional workspace scope.
  --project-id <id>                    Project scope/staging suffix, default ${DEFAULT_PROJECT_ID}
  --base-id <id>                       Optional multitable base id.
  --install-staging                    Call /api/integration/staging/install first and use its standard_materials sheet.
  --standard-materials-sheet-id <id>   Existing standard_materials sheet id when --install-staging is not used.
  --standard-materials-view-id <id>    Optional view id for the existing standard_materials sheet.
  --standard-materials-open-link <url> Optional open link for the existing standard_materials sheet.
  --staging-source-id <id>             Source system id, default metasheet_staging_<projectId>
  --k3-target-id <id>                  Target system id, default issue1542_k3wise_webapi_metadata_target
  --k3-base-url <url>                  Metadata-only K3 base URL, default ${DEFAULT_K3_BASE_URL}
  --out-dir <dir>                      Artifact directory, default ${DEFAULT_OUTPUT_ROOT}/<timestamp>
  --timeout-ms <ms>                    Per-request timeout, default 10000
  --help                               Show this help

Recommended 142 flow:
  node scripts/ops/integration-issue1542-seed-workbench-systems.mjs \\
    --base-url http://127.0.0.1:8081 \\
    --token-file /tmp/metasheet-admin.jwt \\
    --tenant-id default \\
    --project-id default \\
    --install-staging
`)
}

function readRequiredValue(argv, index, flag) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Issue1542SeedError(`${flag} requires a value`, { flag })
  }
  return value
}

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    baseUrl: DEFAULT_BASE_URL,
    authToken: process.env.METASHEET_AUTH_TOKEN || process.env.ADMIN_TOKEN || process.env.AUTH_TOKEN || '',
    tokenFile: process.env.METASHEET_AUTH_TOKEN_FILE || process.env.AUTH_TOKEN_FILE || '',
    tenantId: DEFAULT_TENANT_ID,
    workspaceId: process.env.METASHEET_WORKSPACE_ID || process.env.WORKSPACE_ID || '',
    projectId: DEFAULT_PROJECT_ID,
    baseId: '',
    installStaging: false,
    standardMaterialsSheetId: '',
    standardMaterialsViewId: '',
    standardMaterialsOpenLink: '',
    stagingSourceId: '',
    k3TargetId: 'issue1542_k3wise_webapi_metadata_target',
    k3BaseUrl: DEFAULT_K3_BASE_URL,
    outDir: '',
    timeoutMs: 10_000,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--base-url':
        opts.baseUrl = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--auth-token':
        opts.authToken = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--token-file':
        opts.tokenFile = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--tenant-id':
        opts.tenantId = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--workspace-id':
        opts.workspaceId = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--project-id':
        opts.projectId = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--base-id':
        opts.baseId = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--install-staging':
        opts.installStaging = true
        break
      case '--standard-materials-sheet-id':
        opts.standardMaterialsSheetId = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--standard-materials-view-id':
        opts.standardMaterialsViewId = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--standard-materials-open-link':
        opts.standardMaterialsOpenLink = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--staging-source-id':
        opts.stagingSourceId = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--k3-target-id':
        opts.k3TargetId = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--k3-base-url':
        opts.k3BaseUrl = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--out-dir':
        opts.outDir = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--timeout-ms':
        opts.timeoutMs = Number(readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--help':
      case '-h':
        opts.help = true
        break
      default:
        throw new Issue1542SeedError(`unknown option: ${arg}`, { arg })
    }
  }

  return normalizeOptions(opts)
}

function normalizeOptions(opts) {
  const normalized = { ...opts }
  normalized.baseUrl = normalizeBaseUrl(normalized.baseUrl)
  normalized.k3BaseUrl = normalizeBaseUrl(normalized.k3BaseUrl)
  normalized.tenantId = requiredString(normalized.tenantId, 'tenantId')
  normalized.workspaceId = optionalString(normalized.workspaceId)
  normalized.projectId = requiredString(normalized.projectId, 'projectId')
  normalized.baseId = optionalString(normalized.baseId)
  normalized.standardMaterialsSheetId = optionalString(normalized.standardMaterialsSheetId)
  normalized.standardMaterialsViewId = optionalString(normalized.standardMaterialsViewId)
  normalized.standardMaterialsOpenLink = optionalString(normalized.standardMaterialsOpenLink)
  normalized.stagingSourceId = optionalString(normalized.stagingSourceId) || stagingSourceSystemId(normalized.projectId)
  normalized.k3TargetId = requiredString(normalized.k3TargetId, 'k3TargetId')
  if (!Number.isFinite(normalized.timeoutMs) || normalized.timeoutMs <= 0) {
    throw new Issue1542SeedError('timeoutMs must be a positive number', { field: 'timeoutMs' })
  }
  if (!normalized.installStaging && !normalized.standardMaterialsSheetId) {
    throw new Issue1542SeedError('--standard-materials-sheet-id is required unless --install-staging is supplied', {
      field: 'standardMaterialsSheetId',
    })
  }
  return normalized
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Issue1542SeedError(`${field} is required`, { field })
  }
  return value.trim()
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeBaseUrl(value) {
  const raw = requiredString(value, 'baseUrl')
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Issue1542SeedError('baseUrl must be http or https', { field: 'baseUrl' })
  }
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

function stagingSourceSystemId(projectId) {
  const suffix = (projectId || 'default').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'default'
  return `metasheet_staging_${suffix}`
}

async function loadToken(opts) {
  if (opts.authToken) return opts.authToken.trim()
  if (!opts.tokenFile) {
    throw new Issue1542SeedError('auth token is required; use --token-file or METASHEET_AUTH_TOKEN_FILE', {
      field: 'tokenFile',
    })
  }
  const token = (await readFile(opts.tokenFile, 'utf8')).trim()
  if (!token) {
    throw new Issue1542SeedError('token file is empty', { field: 'tokenFile' })
  }
  return token
}

function withQuery(pathname, query = {}) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const suffix = search.toString()
  return suffix ? `${pathname}?${suffix}` : pathname
}

async function requestJson(baseUrl, pathname, { token, method = 'GET', body, timeoutMs, acceptStatuses = [200, 201] } = {}) {
  const url = new URL(pathname, `${baseUrl}/`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        Authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    let parsed = null
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
    }
    if (!acceptStatuses.includes(response.status)) {
      throw new Issue1542SeedError(`HTTP ${response.status} ${method} ${url.pathname} failed`, {
        status: response.status,
        body: sanitizeBody(parsed),
      })
    }
    return { status: response.status, body: parsed }
  } finally {
    clearTimeout(timer)
  }
}

function responseData(body) {
  return body && Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : body
}

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Issue1542SeedError(`${label} must be an array`, { received: typeof value })
  }
  return value
}

function standardMaterialsDescriptor(descriptors) {
  const descriptor = assertArray(descriptors, 'staging descriptors').find((item) => item && item.id === 'standard_materials')
  if (!descriptor) {
    throw new Issue1542SeedError('standard_materials staging descriptor is missing', {
      descriptorIds: descriptors.filter(Boolean).map((item) => item.id).filter(Boolean),
    })
  }
  const fields = Array.isArray(descriptor.fieldDetails) && descriptor.fieldDetails.length > 0
    ? descriptor.fieldDetails.map((field) => field.id || field.name).filter(Boolean)
    : (Array.isArray(descriptor.fields) ? descriptor.fields : [])
  const missingFields = REQUIRED_STANDARD_MATERIAL_FIELDS.filter((field) => !fields.includes(field))
  if (missingFields.length > 0) {
    throw new Issue1542SeedError('standard_materials descriptor is missing required fields', {
      missingFields,
      fields,
    })
  }
  return descriptor
}

function sheetTargetFromInstallResult(result) {
  const data = responseData(result)
  const sheetId = data?.sheetIds?.standard_materials
  if (!sheetId) {
    throw new Issue1542SeedError('staging install did not return sheetIds.standard_materials', {
      sheetIds: data?.sheetIds || {},
    })
  }
  const target = Array.isArray(data.targets)
    ? data.targets.find((item) => item && item.id === 'standard_materials')
    : null
  return {
    sheetId,
    viewId: target?.viewId || data?.viewIds?.standard_materials || null,
    baseId: target?.baseId || null,
    openLink: target?.openLink || data?.openLinks?.standard_materials || null,
    warnings: Array.isArray(data.warnings) ? data.warnings : [],
  }
}

function directSheetTarget(opts) {
  return {
    sheetId: opts.standardMaterialsSheetId,
    viewId: opts.standardMaterialsViewId,
    baseId: opts.baseId,
    openLink: opts.standardMaterialsOpenLink,
    warnings: [],
  }
}

function buildScope(opts) {
  return {
    tenantId: opts.tenantId,
    workspaceId: opts.workspaceId,
  }
}

function buildStagingPayload(opts, descriptor, target) {
  return {
    ...buildScope(opts),
    id: opts.stagingSourceId,
    projectId: opts.projectId,
    name: 'MetaSheet staging source (issue #1542 smoke)',
    kind: 'metasheet:staging',
    role: 'source',
    status: 'active',
    config: {
      projectId: opts.projectId,
      baseId: target.baseId || opts.baseId || null,
      objects: {
        standard_materials: {
          name: descriptor.name || 'standard_materials',
          sheetId: target.sheetId,
          viewId: target.viewId || null,
          baseId: target.baseId || opts.baseId || null,
          openLink: target.openLink || null,
          fields: Array.isArray(descriptor.fields) ? descriptor.fields : [],
          fieldDetails: Array.isArray(descriptor.fieldDetails) ? descriptor.fieldDetails : [],
        },
      },
    },
    capabilities: {
      read: true,
      stagingSource: true,
      dryRunFriendly: true,
      issue1542Smoke: true,
    },
  }
}

function buildK3Payload(opts) {
  return {
    ...buildScope(opts),
    id: opts.k3TargetId,
    projectId: opts.projectId,
    name: 'K3 WISE WebAPI target (metadata-only issue #1542 smoke)',
    kind: 'erp:k3-wise-webapi',
    role: 'target',
    status: 'active',
    config: {
      baseUrl: opts.k3BaseUrl,
      loginPath: '/K3API/Login',
      tokenPath: '/K3API/Token/Create',
      tokenQueryParam: 'Token',
      autoSubmit: false,
      autoAudit: false,
      objects: {},
      metadataOnly: true,
    },
    capabilities: {
      write: true,
      dryRunFriendly: true,
      k3TemplatePreview: true,
      metadataOnly: true,
      saveOnlyRequiresRealCredentials: true,
    },
  }
}

async function upsertExternalSystem(opts, token, payload) {
  const response = await requestJson(opts.baseUrl, '/api/integration/external-systems', {
    token,
    method: 'POST',
    body: payload,
    timeoutMs: opts.timeoutMs,
  })
  return responseData(response.body)
}

function sanitizeUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  try {
    const url = new URL(value)
    if (url.username) url.username = '<redacted>'
    if (url.password) url.password = '<redacted>'
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_QUERY_PARAM_PATTERN.test(key)) {
        url.searchParams.set(key, '<redacted>')
      }
    }
    return url.toString()
  } catch {
    return value.replace(/([?&](?:access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?id|api[_-]?key|token|password|passwd|pwd|secret|signature|sign|auth|authorization)=)([^&#\s]+)/ig, '$1<redacted>')
  }
}

function sanitizeBody(value) {
  if (typeof value === 'string') return value.replace(TOKEN_PATTERN, '<redacted>')
  if (Array.isArray(value)) return value.map(sanitizeBody)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_QUERY_PARAM_PATTERN.test(key)) {
      out[key] = '<redacted>'
    } else if (typeof item === 'string' && /^https?:\/\//i.test(item)) {
      out[key] = sanitizeUrl(item)
    } else {
      out[key] = sanitizeBody(item)
    }
  }
  return out
}

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function outputDir(opts) {
  return opts.outDir || path.join(DEFAULT_OUTPUT_ROOT, timestampForPath())
}

function buildSummary({ opts, source, target, sheetTarget, descriptor, installed }) {
  return sanitizeBody({
    ok: true,
    decision: 'PASS',
    mode: installed ? 'install-staging-and-seed' : 'seed-existing-sheet',
    scope: {
      tenantId: opts.tenantId,
      workspaceId: opts.workspaceId,
      projectId: opts.projectId,
      baseId: sheetTarget.baseId || opts.baseId || null,
    },
    systems: {
      stagingSource: {
        id: source.id || opts.stagingSourceId,
        kind: source.kind || 'metasheet:staging',
        role: source.role || 'source',
        status: source.status || 'active',
        object: 'standard_materials',
        sheetId: sheetTarget.sheetId,
        viewId: sheetTarget.viewId || null,
        openLink: sheetTarget.openLink || null,
      },
      k3Target: {
        id: target.id || opts.k3TargetId,
        kind: target.kind || 'erp:k3-wise-webapi',
        role: target.role || 'target',
        status: target.status || 'active',
        baseUrl: opts.k3BaseUrl,
        credentials: 'not written by this tool',
        autoSubmit: false,
        autoAudit: false,
      },
    },
    descriptor: {
      id: descriptor.id,
      name: descriptor.name || null,
      fields: Array.isArray(descriptor.fields) ? descriptor.fields.length : 0,
      fieldDetails: Array.isArray(descriptor.fieldDetails) ? descriptor.fieldDetails.length : 0,
      requiredSmokeFields: REQUIRED_STANDARD_MATERIAL_FIELDS,
    },
    next: [
      'Run integration-k3wise-postdeploy-smoke.mjs --issue1542-workbench-smoke with the same tenant/workspace scope.',
      'Use real K3 credentials only in the K3 setup page before Save-only/live testing.',
    ],
    warnings: sheetTarget.warnings,
  })
}

function renderMarkdown(summary) {
  const lines = [
    '# Issue #1542 Data Factory Seed Result',
    '',
    `- Decision: ${summary.decision}`,
    `- Mode: ${summary.mode}`,
    `- Tenant: ${summary.scope.tenantId}`,
    `- Workspace: ${summary.scope.workspaceId || '(none)'}`,
    `- Project: ${summary.scope.projectId}`,
    `- Staging source: ${summary.systems.stagingSource.id}`,
    `- K3 target: ${summary.systems.k3Target.id}`,
    `- Staging object: ${summary.systems.stagingSource.object}`,
    `- Staging sheet: ${summary.systems.stagingSource.sheetId}`,
    `- K3 credentials: ${summary.systems.k3Target.credentials}`,
    `- Auto Submit: ${summary.systems.k3Target.autoSubmit}`,
    `- Auto Audit: ${summary.systems.k3Target.autoAudit}`,
    '',
    '## Next Command',
    '',
    'Run the postdeploy smoke with `--issue1542-workbench-smoke` using the same tenant/workspace scope.',
    '',
    'This tool does not write real K3 secrets and does not call K3 Save / Submit / Audit.',
  ]
  if (summary.warnings.length > 0) {
    lines.push('', '## Warnings', '', ...summary.warnings.map((item) => `- ${item}`))
  }
  return `${lines.join('\n')}\n`
}

async function writeOutputs(opts, summary) {
  const dir = outputDir(opts)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const jsonPath = path.join(dir, 'integration-issue1542-seed-workbench-systems.json')
  const mdPath = path.join(dir, 'integration-issue1542-seed-workbench-systems.md')
  await writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 })
  await writeFile(mdPath, renderMarkdown(summary), { mode: 0o600 })
  return { dir, jsonPath, mdPath }
}

async function seed(opts, token) {
  const descriptorsResponse = await requestJson(opts.baseUrl, withQuery('/api/integration/staging/descriptors', buildScope(opts)), {
    token,
    timeoutMs: opts.timeoutMs,
  })
  const descriptor = standardMaterialsDescriptor(responseData(descriptorsResponse.body))

  let installed = false
  let sheetTarget = directSheetTarget(opts)
  if (opts.installStaging) {
    const installResponse = await requestJson(opts.baseUrl, '/api/integration/staging/install', {
      token,
      method: 'POST',
      timeoutMs: opts.timeoutMs,
      body: {
        ...buildScope(opts),
        projectId: opts.projectId,
        baseId: opts.baseId,
      },
    })
    sheetTarget = sheetTargetFromInstallResult(installResponse.body)
    installed = true
  }

  const sourcePayload = buildStagingPayload(opts, descriptor, sheetTarget)
  const targetPayload = buildK3Payload(opts)
  const source = await upsertExternalSystem(opts, token, sourcePayload)
  const target = await upsertExternalSystem(opts, token, targetPayload)

  return buildSummary({ opts, source, target, sheetTarget, descriptor, installed })
}

async function main() {
  const opts = parseArgs()
  if (opts.help) {
    printHelp()
    return
  }
  const token = await loadToken(opts)
  const summary = await seed(opts, token)
  const outputs = await writeOutputs(opts, summary)
  console.log(`Issue #1542 Data Factory seed: ${summary.decision}`)
  console.log(`Mode: ${summary.mode}`)
  console.log(`Staging source: ${summary.systems.stagingSource.id}`)
  console.log(`K3 target: ${summary.systems.k3Target.id}`)
  console.log(`Artifacts: ${outputs.dir}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const details = error && error.details ? ` ${JSON.stringify(sanitizeBody(error.details))}` : ''
    console.error(`[issue1542-seed] ${error && error.message ? error.message : String(error)}${details}`)
    process.exitCode = 1
  })
}

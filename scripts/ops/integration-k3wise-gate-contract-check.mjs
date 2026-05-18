#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_OUTPUT_ROOT = 'output/integration-k3wise-gate-contract-check'
const READ_ANSWER_IDS = [
  'O1-MAT',
  'O1-MAT-M',
  'O1-BOM',
  'O1-BOM-M',
  'O2-P',
  'O2-T',
  'O2-C',
  'O3-F',
  'O3-M',
  'O4-MAT',
  'O4-BOM',
  'O6',
]
const READ_METHOD_IDS = ['O1-MAT-M', 'O1-BOM-M']
const READ_PATH_IDS = ['O1-MAT', 'O1-BOM']
const READ_SAMPLES = {
  materialList: {
    label: 'Material list sample',
    validator: assertMaterialSample,
  },
  materialDetail: {
    label: 'Material detail sample',
    validator: assertMaterialSample,
  },
  bomList: {
    label: 'BOM list sample',
    validator: assertBomSample,
  },
  bomDetail: {
    label: 'BOM detail sample',
    validator: assertBomSample,
  },
}
const RELATIONSHIP_ANSWER_IDS = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7']
const RELATIONSHIP_SAMPLES = {
  flatBomLines: {
    label: 'Flat PLM BOM lines sample',
    validator: assertFlatBomLinesSample,
  },
  treeBom: {
    label: 'Tree PLM BOM sample',
    validator: assertTreeBomSample,
  },
  unresolvedChild: {
    label: 'Unresolved child material sample',
    validator: assertUnresolvedChildSample,
  },
  k3BomSaveShape: {
    label: 'K3 BOM Save body shape sample',
    validator: assertK3BomSaveShape,
  },
}
const PLACEHOLDER_PATTERN = /^(|<fill>|<fill-outside-git>|todo|tbd|\?|待填写|待确认)$/i
const JWT_PATTERN = /[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._-]{16,}/i
const CONNECTION_STRING_PATTERN = /\b(postgres|postgresql|mysql|mssql|sqlserver|jdbc):\/\/[^/\s:]+:[^@\s]+@/i
const SECRET_QUERY_PATTERN = /[?&](access[_-]?token|api[_-]?key|auth|authorization|credential|jwt|password|secret|session[_-]?id|sign|signature|token)=([^&#\s]+)/i
const SECRET_KEY_PATTERN = /(access[_-]?token|api[_-]?key|auth|authorization|credential|jwt|password|secret|session[_-]?id|sign|signature|token)/i
const REDACTED_VALUE_PATTERN = /^(<redacted>|<fill-outside-git>|\*\*\*|redacted)$/i

class GateContractCheckError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'GateContractCheckError'
    this.details = details
  }
}

function printHelp() {
  console.log(`Usage: node scripts/ops/integration-k3wise-gate-contract-check.mjs --input <packet.json> [options]

Validates the customer GATE-front packet for #1526 before any K3 WISE read/list,
SQL sample, or relationship runtime work starts. The checker is read-only and
does not contact MetaSheet or K3.

Options:
  --input <path>      JSON packet with WebAPI read/list and relationship answers
  --out-dir <dir>    Evidence output directory, default ${DEFAULT_OUTPUT_ROOT}/<timestamp>
  --help             Show this help

Packet shape:
{
  "webapiReadList": {
    "answers": { "O1-MAT": "/K3API/...", "O1-MAT-M": "POST", ... },
    "samples": {
      "materialList": "sample-material-list.redacted.json",
      "materialDetail": "sample-material-detail.redacted.json",
      "bomList": "sample-bom-list.redacted.json",
      "bomDetail": "sample-bom-detail.redacted.json"
    }
  },
  "relationshipMapping": {
    "answers": { "R1": "flat lines", ... },
    "samples": {
      "flatBomLines": "relationship-flat-bom-lines.redacted.json",
      "treeBom": "relationship-tree-bom.redacted.json",
      "unresolvedChild": "relationship-unresolved-child.redacted.json",
      "k3BomSaveShape": "relationship-k3-bom-save-shape.redacted.json"
    }
  }
}`)
}

function readRequiredValue(argv, index, flag) {
  const next = argv[index + 1]
  if (!next || next.startsWith('--')) {
    throw new GateContractCheckError(`${flag} requires a value`, { flag })
  }
  return next
}

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    input: '',
    outDir: '',
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--input':
        opts.input = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--out-dir':
        opts.outDir = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--help':
      case '-h':
        opts.help = true
        break
      default:
        throw new GateContractCheckError(`unknown option: ${arg}`, { arg })
    }
  }
  if (!opts.help && !opts.input) {
    throw new GateContractCheckError('--input is required')
  }
  return opts
}

function nowStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

function isFilled(value) {
  if (value === null || value === undefined) return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return !PLACEHOLDER_PATTERN.test(String(value).trim())
}

function decisionFromIssues(issues) {
  if (issues.some((issue) => issue.status === 'fail')) return { decision: 'FAIL', exitCode: 1 }
  if (issues.some((issue) => issue.status === 'blocked')) return { decision: 'GATE_BLOCKED', exitCode: 2 }
  return { decision: 'PASS', exitCode: 0 }
}

function addIssue(issues, status, id, message, details = {}) {
  issues.push({ id, status, message, ...details })
}

function valueAtPath(value, pathName) {
  return pathName.split('.').reduce((current, segment) => {
    if (!current || typeof current !== 'object') return undefined
    return current[segment]
  }, value)
}

function getObject(value, pathName) {
  const object = valueAtPath(value, pathName)
  return object && typeof object === 'object' && !Array.isArray(object) ? object : {}
}

function validateRequiredAnswers({ answers, ids, sectionId, issues }) {
  for (const id of ids) {
    if (!isFilled(answers[id])) {
      addIssue(issues, 'blocked', `${sectionId}.${id}`, `${id} is required before runtime work starts`)
    }
  }
}

function validateReadAnswerSemantics(answers, issues) {
  for (const id of READ_METHOD_IDS) {
    const method = String(answers[id] || '').trim().toUpperCase()
    if (!method) continue
    if (method !== 'GET' && method !== 'POST') {
      addIssue(issues, 'blocked', `webapiReadList.${id}`, `${id} must be GET or POST`, { value: method })
    }
  }
  for (const id of READ_PATH_IDS) {
    const endpoint = String(answers[id] || '').trim()
    if (!endpoint) continue
    if (/^https?:\/\//i.test(endpoint)) {
      addIssue(issues, 'fail', `webapiReadList.${id}`, `${id} must be a relative endpoint path, not an absolute URL`)
    } else if (!endpoint.startsWith('/')) {
      addIssue(issues, 'blocked', `webapiReadList.${id}`, `${id} should start with /`)
    }
    if (SECRET_QUERY_PATTERN.test(endpoint)) {
      addIssue(issues, 'fail', `webapiReadList.${id}`, `${id} contains a secret-looking query parameter`)
    }
  }
}

function scanSecrets(value, issues, context) {
  const visit = (current, pathName) => {
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${pathName}[${index}]`))
      return
    }
    if (current && typeof current === 'object') {
      for (const [key, child] of Object.entries(current)) {
        const childPath = pathName ? `${pathName}.${key}` : key
        if (SECRET_KEY_PATTERN.test(key) && typeof child === 'string' && child && !REDACTED_VALUE_PATTERN.test(child.trim())) {
          addIssue(issues, 'fail', `${context}.secret.${childPath}`, 'secret-looking key has a non-redacted value')
        }
        visit(child, childPath)
      }
      return
    }
    if (typeof current !== 'string') return
    if (JWT_PATTERN.test(current) || BEARER_PATTERN.test(current)) {
      addIssue(issues, 'fail', `${context}.secret.${pathName}`, 'JWT/Bearer-shaped value is not allowed in GATE samples')
    }
    if (CONNECTION_STRING_PATTERN.test(current)) {
      addIssue(issues, 'fail', `${context}.secret.${pathName}`, 'database connection string with credentials is not allowed in GATE samples')
    }
    if (SECRET_QUERY_PATTERN.test(current)) {
      addIssue(issues, 'fail', `${context}.secret.${pathName}`, 'URL query secret is not allowed in GATE samples')
    }
  }
  visit(value, '')
}

function firstObjectMatching(value, predicate) {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = firstObjectMatching(child, predicate)
      if (found) return found
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  if (predicate(value)) return value
  for (const child of Object.values(value)) {
    const found = firstObjectMatching(child, predicate)
    if (found) return found
  }
  return null
}

function hasAnyKey(object, keys) {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(object, key))
}

function assertMaterialSample(sample) {
  const material = firstObjectMatching(sample, (object) => hasAnyKey(object, ['FNumber', 'Number', 'MaterialNumber']) && hasAnyKey(object, ['FName', 'Name', 'MaterialName']))
  if (!material) {
    throw new GateContractCheckError('Material sample must include at least one material-like row with number and name fields')
  }
}

function assertBomSample(sample) {
  const bom = firstObjectMatching(sample, (object) => {
    const hasParent = hasAnyKey(object, ['FParentItemNumber', 'parentCode', 'ParentNumber'])
    const childRows = Array.isArray(object.FChildItems) ? object.FChildItems : []
    const hasChildArray = childRows.some((child) => child && typeof child === 'object' && hasAnyKey(child, ['FItemNumber', 'FChildItemNumber', 'childCode']) && hasAnyKey(child, ['FQty', 'quantity', 'Qty']))
    const hasChild = hasAnyKey(object, ['FChildItemNumber', 'childCode', 'FItemNumber']) || hasChildArray
    const hasQty = hasAnyKey(object, ['FQty', 'quantity', 'Qty']) || hasChildArray
    return hasParent && hasChild && hasQty
  })
  if (!bom) {
    throw new GateContractCheckError('BOM sample must include parent, child, and quantity fields')
  }
}

function assertFlatBomLinesSample(sample) {
  const records = Array.isArray(sample.records) ? sample.records : null
  if (!records || records.length === 0) {
    throw new GateContractCheckError('flat BOM sample must contain records[]')
  }
  const invalid = records.find((record) => !record || !record.parentCode || !record.childCode || record.quantity === undefined)
  if (invalid) {
    throw new GateContractCheckError('flat BOM records must include parentCode, childCode, and quantity')
  }
}

function assertTreeBomSample(sample) {
  const root = sample && sample.root
  if (!root || typeof root !== 'object' || !Array.isArray(root.children) || root.children.length === 0) {
    throw new GateContractCheckError('tree BOM sample must contain root.children[]')
  }
}

function assertUnresolvedChildSample(sample) {
  if (!sample || typeof sample !== 'object' || !sample.record || !sample.expectedCustomerPolicy) {
    throw new GateContractCheckError('unresolved child sample must contain record and expectedCustomerPolicy')
  }
  if (!sample.record.parentCode || !sample.record.childCode) {
    throw new GateContractCheckError('unresolved child record must include parentCode and childCode')
  }
}

function assertK3BomSaveShape(sample) {
  const data = sample && sample.Data
  if (!data || typeof data !== 'object') {
    throw new GateContractCheckError('K3 BOM Save shape must contain Data')
  }
  const flat = data.FParentItemNumber && data.FChildItemNumber && data.FQty !== undefined
  const childArray = data.FParentItemNumber && Array.isArray(data.FChildItems) && data.FChildItems.length > 0
  if (!flat && !childArray) {
    throw new GateContractCheckError('K3 BOM Save shape must be either flat fields or Data.FChildItems[]')
  }
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    throw new GateContractCheckError(`cannot read JSON: ${error.message}`, { file: filePath })
  }
}

async function validateSamples({ samples, sampleSpecs, baseDir, sectionId, issues }) {
  const sampleResults = []
  for (const [key, spec] of Object.entries(sampleSpecs)) {
    const rawPath = samples[key]
    if (!isFilled(rawPath)) {
      addIssue(issues, 'blocked', `${sectionId}.sample.${key}`, `${spec.label} file is required`)
      sampleResults.push({ key, status: 'blocked', label: spec.label })
      continue
    }
    const resolved = path.resolve(baseDir, String(rawPath))
    let sample
    try {
      sample = await readJsonFile(resolved)
    } catch (error) {
      addIssue(issues, 'blocked', `${sectionId}.sample.${key}`, error.message)
      sampleResults.push({ key, status: 'blocked', label: spec.label })
      continue
    }
    scanSecrets(sample, issues, `${sectionId}.sample.${key}`)
    try {
      spec.validator(sample)
      sampleResults.push({ key, status: 'present', label: spec.label })
    } catch (error) {
      addIssue(issues, 'blocked', `${sectionId}.sample.${key}`, error.message)
      sampleResults.push({ key, status: 'blocked', label: spec.label })
    }
  }
  return sampleResults
}

export async function buildGateContractReport(packet, { inputPath = '', generatedAt = new Date().toISOString() } = {}) {
  const issues = []
  const baseDir = inputPath ? path.dirname(path.resolve(inputPath)) : process.cwd()
  const webapiReadList = getObject(packet, 'webapiReadList')
  const relationshipMapping = getObject(packet, 'relationshipMapping')
  const readAnswers = getObject(webapiReadList, 'answers')
  const relationshipAnswers = getObject(relationshipMapping, 'answers')

  validateRequiredAnswers({
    answers: readAnswers,
    ids: READ_ANSWER_IDS,
    sectionId: 'webapiReadList',
    issues,
  })
  validateReadAnswerSemantics(readAnswers, issues)

  validateRequiredAnswers({
    answers: relationshipAnswers,
    ids: RELATIONSHIP_ANSWER_IDS,
    sectionId: 'relationshipMapping',
    issues,
  })

  scanSecrets(readAnswers, issues, 'webapiReadList.answers')
  scanSecrets(relationshipAnswers, issues, 'relationshipMapping.answers')

  const readSamples = await validateSamples({
    samples: getObject(webapiReadList, 'samples'),
    sampleSpecs: READ_SAMPLES,
    baseDir,
    sectionId: 'webapiReadList',
    issues,
  })
  const relationshipSamples = await validateSamples({
    samples: getObject(relationshipMapping, 'samples'),
    sampleSpecs: RELATIONSHIP_SAMPLES,
    baseDir,
    sectionId: 'relationshipMapping',
    issues,
  })

  const decision = decisionFromIssues(issues)
  return {
    ok: decision.exitCode === 0,
    generatedAt,
    inputPath: inputPath ? path.resolve(inputPath) : '',
    decision: decision.decision,
    exitCode: decision.exitCode,
    stage1Lock: {
      status: 'held',
      note: 'This checker validates customer evidence only; it does not touch plugin runtime, DB migrations, routes, or K3.',
    },
    sections: {
      webapiReadList: {
        requiredAnswers: READ_ANSWER_IDS.length,
        answered: READ_ANSWER_IDS.filter((id) => isFilled(readAnswers[id])).length,
        samples: readSamples,
      },
      relationshipMapping: {
        requiredAnswers: RELATIONSHIP_ANSWER_IDS.length,
        answered: RELATIONSHIP_ANSWER_IDS.filter((id) => isFilled(relationshipAnswers[id])).length,
        samples: relationshipSamples,
      },
    },
    issues,
    summary: {
      fail: issues.filter((issue) => issue.status === 'fail').length,
      blocked: issues.filter((issue) => issue.status === 'blocked').length,
      pass: decision.exitCode === 0 ? 1 : 0,
    },
  }
}

function renderMarkdown(report) {
  const lines = [
    '# K3 WISE GATE Contract Check',
    '',
    `- Generated at: \`${report.generatedAt}\``,
    `- Decision: \`${report.decision}\``,
    `- Exit code: \`${report.exitCode}\``,
    `- Stage 1 Lock: \`${report.stage1Lock.status}\``,
    `- Summary: ${report.summary.pass} pass / ${report.summary.blocked} blocked / ${report.summary.fail} fail`,
    '',
    '## Sections',
    '',
    '| Section | Answers | Samples |',
    '| --- | ---: | ---: |',
  ]
  for (const [id, section] of Object.entries(report.sections)) {
    const sampleOk = section.samples.filter((sample) => sample.status === 'present').length
    lines.push(`| \`${id}\` | ${section.answered}/${section.requiredAnswers} | ${sampleOk}/${section.samples.length} |`)
  }
  lines.push('', '## Issues', '')
  if (report.issues.length === 0) {
    lines.push('No issues. Runtime work can start only if the broader customer GATE is also PASS.')
  } else {
    lines.push('| Status | ID | Message |', '| --- | --- | --- |')
    for (const issue of report.issues) {
      lines.push(`| \`${issue.status}\` | \`${issue.id}\` | ${String(issue.message).replace(/\|/g, '\\|')} |`)
    }
  }
  lines.push('', '## Non-Goals', '')
  lines.push('- This check does not contact K3 WISE or MetaSheet.')
  lines.push('- This check does not enable WebAPI read/list, SQL sampling, or relationship runtime.')
  lines.push('- This check does not lift the customer GATE.')
  return `${lines.join('\n')}\n`
}

async function writeOutputs(report, outDir) {
  await mkdir(outDir, { recursive: true })
  const jsonPath = path.join(outDir, 'integration-k3wise-gate-contract-check.json')
  const mdPath = path.join(outDir, 'integration-k3wise-gate-contract-check.md')
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(mdPath, renderMarkdown(report))
  return { jsonPath, mdPath }
}

async function main() {
  const opts = parseArgs()
  if (opts.help) {
    printHelp()
    return 0
  }
  const packet = await readJsonFile(opts.input)
  const report = await buildGateContractReport(packet, { inputPath: opts.input })
  const outDir = opts.outDir || path.join(DEFAULT_OUTPUT_ROOT, nowStamp())
  const outputs = await writeOutputs(report, outDir)
  console.log(JSON.stringify({
    ok: report.ok,
    decision: report.decision,
    exitCode: report.exitCode,
    summary: report.summary,
    jsonPath: outputs.jsonPath,
    mdPath: outputs.mdPath,
  }, null, 2))
  return report.exitCode
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      const details = error && error.details ? ` ${JSON.stringify(error.details)}` : ''
      console.error(`${error.name || 'Error'}: ${error.message}${details}`)
      process.exitCode = 1
    })
}

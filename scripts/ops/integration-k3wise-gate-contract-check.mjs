#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
const TEMPLATE_PACKET_FILE = 'k3wise-gate-contract-packet.template.json'
const TEMPLATE_HANDOFF_README_FILE = 'README-CUSTOMER-HANDOFF.zh.md'
const TEMPLATE_SAMPLE_FILES = {
  materialList: 'sample-material-list.redacted.json',
  materialDetail: 'sample-material-detail.redacted.json',
  bomList: 'sample-bom-list.redacted.json',
  bomDetail: 'sample-bom-detail.redacted.json',
  flatBomLines: 'relationship-flat-bom-lines.redacted.json',
  treeBom: 'relationship-tree-bom.redacted.json',
  unresolvedChild: 'relationship-unresolved-child.redacted.json',
  k3BomSaveShape: 'relationship-k3-bom-save-shape.redacted.json',
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
  console.log(`Usage:
  node scripts/ops/integration-k3wise-gate-contract-check.mjs --input <packet.json> [options]
  node scripts/ops/integration-k3wise-gate-contract-check.mjs --init-template <dir>

Validates the customer GATE-front packet for #1526 before any K3 WISE read/list,
SQL sample, or relationship runtime work starts. The checker is read-only and
does not contact MetaSheet or K3.

Options:
  --input <path>      JSON packet with WebAPI read/list and relationship answers
  --init-template <dir>
                      Create a fillable packet + redacted sample skeleton outside Git
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
    initTemplate: '',
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
      case '--init-template':
        opts.initTemplate = readRequiredValue(argv, i, arg)
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
  if (!opts.help && !opts.input && !opts.initTemplate) {
    throw new GateContractCheckError('--input or --init-template is required')
  }
  if (opts.input && opts.initTemplate) {
    throw new GateContractCheckError('--input and --init-template cannot be used together')
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

function buildTemplatePacket() {
  return {
    _instructions: [
      'Fill this packet outside Git with customer-approved K3 WISE evidence.',
      'Replace every <fill-outside-git> placeholder before requesting runtime work.',
      'Keep tokens, passwords, session IDs, authority codes, and SQL connection strings out of this file.',
      'Run this checker with --input against the filled packet; this template intentionally returns GATE_BLOCKED as-is.',
    ],
    webapiReadList: {
      answers: Object.fromEntries(READ_ANSWER_IDS.map((id) => [id, '<fill-outside-git>'])),
      samples: {
        materialList: TEMPLATE_SAMPLE_FILES.materialList,
        materialDetail: TEMPLATE_SAMPLE_FILES.materialDetail,
        bomList: TEMPLATE_SAMPLE_FILES.bomList,
        bomDetail: TEMPLATE_SAMPLE_FILES.bomDetail,
      },
    },
    relationshipMapping: {
      answers: Object.fromEntries(RELATIONSHIP_ANSWER_IDS.map((id) => [id, '<fill-outside-git>'])),
      samples: {
        flatBomLines: TEMPLATE_SAMPLE_FILES.flatBomLines,
        treeBom: TEMPLATE_SAMPLE_FILES.treeBom,
        unresolvedChild: TEMPLATE_SAMPLE_FILES.unresolvedChild,
        k3BomSaveShape: TEMPLATE_SAMPLE_FILES.k3BomSaveShape,
      },
    },
  }
}

function buildTemplateSamples() {
  return {
    [TEMPLATE_SAMPLE_FILES.materialList]: {
      ResponseStatus: { IsSuccess: true },
      Data: [
        {
          FNumber: 'MAT-EXAMPLE-001',
          FName: 'Example material name',
          FModel: 'Example specification',
          FBaseUnitID: '<redacted>',
        },
      ],
      _customerAction: 'Replace with one redacted customer material list response. Do not include token/session/password values.',
    },
    [TEMPLATE_SAMPLE_FILES.materialDetail]: {
      ResponseStatus: { IsSuccess: true },
      Data: {
        FNumber: 'MAT-EXAMPLE-001',
        FName: 'Example material name',
        FModel: 'Example specification',
        FBaseUnitID: '<redacted>',
      },
      _customerAction: 'Replace with one redacted customer material detail response.',
    },
    [TEMPLATE_SAMPLE_FILES.bomList]: {
      ResponseStatus: { IsSuccess: true },
      Data: [
        {
          FParentItemNumber: 'FG-EXAMPLE-001',
          FChildItemNumber: 'MAT-EXAMPLE-001',
          FQty: 2,
          FUnitID: '<redacted>',
          FEntryID: 1,
        },
      ],
      _customerAction: 'Replace with one redacted customer BOM list response.',
    },
    [TEMPLATE_SAMPLE_FILES.bomDetail]: {
      ResponseStatus: { IsSuccess: true },
      Data: {
        FParentItemNumber: 'FG-EXAMPLE-001',
        FChildItems: [
          {
            FItemNumber: 'MAT-EXAMPLE-001',
            FQty: 2,
            FUnitID: '<redacted>',
            FEntryID: 1,
          },
        ],
      },
      _customerAction: 'Replace with one redacted customer BOM detail response.',
    },
    [TEMPLATE_SAMPLE_FILES.flatBomLines]: {
      case: 'flat-bom-lines',
      records: [
        {
          parentCode: 'FG-EXAMPLE-001',
          childCode: 'MAT-EXAMPLE-001',
          quantity: 2,
          sequence: 1,
        },
      ],
      _customerAction: 'Replace with a redacted PLM flat BOM line sample.',
    },
    [TEMPLATE_SAMPLE_FILES.treeBom]: {
      case: 'tree-bom',
      root: {
        code: 'FG-EXAMPLE-001',
        children: [
          {
            code: 'MAT-EXAMPLE-001',
            quantity: 2,
          },
        ],
      },
      _customerAction: 'Replace with a redacted PLM tree BOM sample if the customer uses tree-shaped BOM data.',
    },
    [TEMPLATE_SAMPLE_FILES.unresolvedChild]: {
      case: 'unresolved-child-material',
      record: {
        parentCode: 'FG-EXAMPLE-001',
        childCode: 'MAT-MISSING-EXAMPLE',
      },
      expectedCustomerPolicy: '<fill-outside-git>',
      _customerAction: 'Replace with a redacted unresolved-child example and the customer-approved policy.',
    },
    [TEMPLATE_SAMPLE_FILES.k3BomSaveShape]: {
      Data: {
        FParentItemNumber: 'FG-EXAMPLE-001',
        FChildItems: [
          {
            FItemNumber: 'MAT-EXAMPLE-001',
            FQty: 2,
            FUnitID: '<redacted>',
            FEntryID: 1,
          },
        ],
      },
      _customerAction: 'Replace with the redacted K3 BOM Save shape the customer accepts for the PoC.',
    },
  }
}

function buildCustomerHandoffReadme() {
  return `# K3 WISE GATE 信息填写说明

这份包用于确认 MetaSheet 下一阶段是否可以开发 K3 WISE WebAPI 读取和关系映射功能。请只填写脱敏后的接口路径、字段说明、样例结构和业务规则，不要填写任何真实密码、Token、Cookie、authorityCode、SQL 连接串或生产数据原文。

## 文件清单

- \`${TEMPLATE_PACKET_FILE}\`：主填写文件。
- \`${TEMPLATE_SAMPLE_FILES.materialList}\`：物料列表接口脱敏样例。
- \`${TEMPLATE_SAMPLE_FILES.materialDetail}\`：物料详情接口脱敏样例。
- \`${TEMPLATE_SAMPLE_FILES.bomList}\`：BOM 列表接口脱敏样例。
- \`${TEMPLATE_SAMPLE_FILES.bomDetail}\`：BOM 详情接口脱敏样例。
- \`${TEMPLATE_SAMPLE_FILES.flatBomLines}\`：平铺 BOM 行样例。
- \`${TEMPLATE_SAMPLE_FILES.treeBom}\`：树形 BOM 样例。
- \`${TEMPLATE_SAMPLE_FILES.unresolvedChild}\`：子件无法匹配时的样例。
- \`${TEMPLATE_SAMPLE_FILES.k3BomSaveShape}\`：K3 BOM Save 请求体结构样例。

## WebAPI read/list 必填项

请在 \`webapiReadList.answers\` 中填写：

- \`O1-MAT\`：物料读取接口相对路径，例如 \`/K3API/...\`。不要填完整域名、Token 或查询密钥。
- \`O1-MAT-M\`：物料读取接口方法，只能是 \`GET\` 或 \`POST\`。
- \`O1-BOM\`：BOM 读取接口相对路径。
- \`O1-BOM-M\`：BOM 读取接口方法，只能是 \`GET\` 或 \`POST\`。
- \`O2-P\`：分页规则，例如页码参数、每页数量参数、最大页数限制。
- \`O2-T\`：总数或下一页判断规则。
- \`O2-C\`：游标或下一页 token 规则；如果没有请写“无，按页码”。
- \`O3-F\`：过滤条件规则，例如物料编码、修改时间、组织范围。
- \`O3-M\`：最小可接受过滤条件；用于避免全量扫生产数据。
- \`O4-MAT\`：物料响应中关键字段含义和路径。
- \`O4-BOM\`：BOM 响应中关键字段含义和路径。
- \`O6\`：错误响应格式，例如认证失败、无数据、参数错误。

## relationship 必填项

请在 \`relationshipMapping.answers\` 中填写：

- \`R1\`：BOM 来源形态，是平铺行、树形结构，还是二者都有。
- \`R2\`：父件、子件、数量、单位分别由哪些字段表示。
- \`R3\`：单位映射规则，例如 PCS/EA/KG 对应 K3 中哪个字段或编码。
- \`R4\`：物料分类映射规则。
- \`R5\`：子件找不到时的期望行为。
- \`R6\`：重复、冲突或多版本 BOM 的处理规则。
- \`R7\`：首轮 PoC 必须支持哪些关系，哪些可以暂缓。

## 脱敏要求

可以保留字段名和结构，但请替换所有敏感值：

- Token / Cookie / session / authorityCode：写成 \`<redacted>\`。
- 密码、密钥、连接串：写成 \`<redacted>\`。
- 真实客户物料编码、名称、供应商、人员等业务数据：用示例值替换，例如 \`MAT-001\`、\`Demo Parent\`。
- URL 里不要包含 \`access_token\`、\`api_key\`、\`password\`、\`secret\`、\`sign\`、\`session_id\` 等查询参数。

## 校验方式

填写完成后，在 MetaSheet 仓库根目录运行：

\`\`\`bash
node scripts/ops/integration-k3wise-gate-contract-check.mjs \\
  --input /path/outside-git/k3wise-gate-contract/k3wise-gate-contract-packet.template.json \\
  --out-dir /path/outside-git/k3wise-gate-contract/check-filled
\`\`\`

只有校验结果为 \`PASS\` 后，MetaSheet 才会开始 #1709 / #1711 的 runtime 开发。若结果是 \`GATE_BLOCKED\`，说明仍有必填项未完成。若结果是 \`FAIL\`，说明存在格式或脱敏问题。

## 明确边界

这份包不会触发 K3 写入。当前阶段不执行 K3 Save、Submit、Audit，也不会修改生产 K3 数据。
`
}

async function writeTemplateJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
}

async function initTemplateDirectory(targetDir) {
  const resolvedDir = path.resolve(targetDir)
  await mkdir(resolvedDir, { recursive: true })
  const packetPath = path.join(resolvedDir, TEMPLATE_PACKET_FILE)
  await writeTemplateJson(packetPath, buildTemplatePacket())
  const readmePath = path.join(resolvedDir, TEMPLATE_HANDOFF_README_FILE)
  await writeFile(readmePath, buildCustomerHandoffReadme(), { flag: 'wx' })
  const samples = buildTemplateSamples()
  for (const [fileName, value] of Object.entries(samples)) {
    await writeTemplateJson(path.join(resolvedDir, fileName), value)
  }
  return {
    templateDir: resolvedDir,
    packetPath,
    readmePath,
    sampleCount: Object.keys(samples).length,
  }
}

async function main() {
  const opts = parseArgs()
  if (opts.help) {
    printHelp()
    return 0
  }
  if (opts.initTemplate) {
    const template = await initTemplateDirectory(opts.initTemplate)
    console.log(JSON.stringify({
      ok: true,
      decision: 'TEMPLATE_CREATED',
      ...template,
    }, null, 2))
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

export function isDirectCliRun(moduleFilePath, entryFilePath, platform = process.platform) {
  if (!entryFilePath) return false
  const pathModule = platform === 'win32' ? path.win32 : path
  const modulePath = pathModule.normalize(moduleFilePath)
  const entryPath = pathModule.resolve(entryFilePath)
  if (platform === 'win32') {
    return modulePath.toLowerCase() === entryPath.toLowerCase()
  }
  return modulePath === entryPath
}

const moduleFilePath = fileURLToPath(import.meta.url)
if (isDirectCliRun(moduleFilePath, process.argv[1])) {
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

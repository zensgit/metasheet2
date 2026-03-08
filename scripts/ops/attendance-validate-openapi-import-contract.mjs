#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

function fail(message) {
  console.error(`[attendance-validate-openapi-import-contract] ERROR: ${message}`)
  process.exitCode = 1
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

const root = process.cwd()
const openapiPath = process.argv[2] || path.join(root, 'packages/openapi/dist/openapi.json')
const sourceAttendancePath = process.argv[3] || path.join(root, 'packages/openapi/src/paths/attendance.yml')

if (!fs.existsSync(openapiPath)) {
  fail(`openapi json not found: ${openapiPath}`)
  process.exit(process.exitCode ?? 1)
}
if (!fs.existsSync(sourceAttendancePath)) {
  fail(`source attendance path not found: ${sourceAttendancePath}`)
  process.exit(process.exitCode ?? 1)
}

let doc
try {
  doc = JSON.parse(fs.readFileSync(openapiPath, 'utf8'))
} catch (error) {
  fail(`failed to parse openapi json: ${String(error?.message || error)}`)
  process.exit(process.exitCode ?? 1)
}

const requiredPaths = [
  '/api/attendance/import/upload',
  '/api/attendance/import/prepare',
  '/api/attendance/import/preview',
  '/api/attendance/import/preview-async',
  '/api/attendance/import/commit',
  '/api/attendance/import/commit-async',
  '/api/attendance/import/jobs/{id}',
]

const paths = doc?.paths && typeof doc.paths === 'object' ? doc.paths : {}
for (const apiPath of requiredPaths) {
  if (!hasOwn(paths, apiPath)) {
    fail(`missing required path in OpenAPI: ${apiPath}`)
  }
}

const schemas = doc?.components?.schemas && typeof doc.components.schemas === 'object'
  ? doc.components.schemas
  : {}

function requireSchema(name) {
  const schema = schemas[name]
  if (!schema || typeof schema !== 'object') {
    fail(`missing required schema: ${name}`)
    return null
  }
  return schema
}

const importResult = requireSchema('AttendanceImportResult')
if (importResult) {
  const props = importResult.properties || {}
  for (const field of ['processedRows', 'failedRows', 'elapsedMs', 'engine', 'recordUpsertStrategy']) {
    if (!hasOwn(props, field)) {
      fail(`AttendanceImportResult missing field: ${field}`)
    }
  }
  const itemProps = props?.items?.items?.properties || {}
  for (const field of ['id', 'userId', 'workDate', 'engine']) {
    if (!hasOwn(itemProps, field)) {
      fail(`AttendanceImportResult.items missing field: ${field}`)
    }
  }
}

const importPreview = requireSchema('AttendanceImportPreviewData')
if (importPreview) {
  const props = importPreview.properties || {}
  for (const field of ['previewLimit', 'asyncSimplified']) {
    if (!hasOwn(props, field)) {
      fail(`AttendanceImportPreviewData missing field: ${field}`)
    }
  }
}

const importPrepare = requireSchema('AttendanceImportPrepareData')
if (importPrepare) {
  const props = importPrepare.properties || {}
  for (const field of ['commitToken', 'expiresAt', 'ttlSeconds']) {
    if (!hasOwn(props, field)) {
      fail(`AttendanceImportPrepareData missing field: ${field}`)
    }
  }
}

const importUpload = requireSchema('AttendanceImportUploadData')
if (importUpload) {
  const props = importUpload.properties || {}
  for (const field of ['fileId', 'rowCount', 'bytes', 'createdAt', 'expiresAt', 'maxBytes']) {
    if (!hasOwn(props, field)) {
      fail(`AttendanceImportUploadData missing field: ${field}`)
    }
  }
}

const importAsync = requireSchema('AttendanceImportAsyncJobData')
if (importAsync) {
  const props = importAsync.properties || {}
  if (!hasOwn(props, 'job')) {
    fail('AttendanceImportAsyncJobData missing field: job')
  } else if (props.job?.$ref !== '#/components/schemas/AttendanceImportJob') {
    fail('AttendanceImportAsyncJobData.job must reference AttendanceImportJob')
  }
  if (!hasOwn(props, 'idempotent')) {
    fail('AttendanceImportAsyncJobData missing field: idempotent')
  }
}

const sourceText = fs.readFileSync(sourceAttendancePath, 'utf8')
for (const apiPath of requiredPaths) {
  if (!sourceText.includes(`${apiPath}:`)) {
    fail(`source attendance path file missing route block: ${apiPath}`)
  }
}

if (process.exitCode) {
  process.exit(process.exitCode)
}

console.log(
  `[attendance-validate-openapi-import-contract] PASS: validated ${requiredPaths.length} import paths and required schemas`
)

#!/usr/bin/env node
/**
 * Content-based OpenAPI/SDK guard for FWB-0 Layer 2 record-link surfaces.
 *
 * Does NOT use mtime as load-bearing proof. Callers in CI must:
 *   1) regenerate (`pnpm --filter @metasheet/openapi generate:sdk`)
 *   2) `git diff --quiet` on dist + dist-sdk
 *   3) run this guard
 *
 * Discriminating checks fail if content is missing or structurally wrong.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const openapiYaml = path.join(root, 'dist', 'openapi.yaml')
const openapiJson = path.join(root, 'dist', 'openapi.json')
const sdkDts = path.join(root, 'dist-sdk', 'index.d.ts')
const baseYml = path.join(root, 'src', 'base.yml')
const pathsYml = path.join(root, 'src', 'paths', 'approvals.yml')

function fail(msg) {
  console.error(`[openapi-guard] FAIL: ${msg}`)
  process.exit(1)
}

function ok(msg) {
  console.log(`[openapi-guard] OK: ${msg}`)
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

if (!fs.existsSync(openapiYaml)) fail(`missing ${openapiYaml} — run pnpm --filter @metasheet/openapi build`)
if (!fs.existsSync(openapiJson)) fail(`missing ${openapiJson}`)
if (!fs.existsSync(sdkDts)) fail(`missing ${sdkDts} — run pnpm --filter @metasheet/openapi generate:sdk`)
if (!fs.existsSync(baseYml) || !fs.existsSync(pathsYml)) fail('missing OpenAPI source files')

const yaml = fs.readFileSync(openapiYaml, 'utf8')
const json = JSON.parse(fs.readFileSync(openapiJson, 'utf8'))
const dts = fs.readFileSync(sdkDts, 'utf8')
const srcBase = fs.readFileSync(baseYml, 'utf8')
const srcPaths = fs.readFileSync(pathsYml, 'utf8')

// Content fingerprint: source needles must appear in generated outputs (not mtime).
const SOURCE_NEEDLES = [
  'record-link',
  'record-link-options',
  'listApprovalRecordLinkOptions',
  'FormFieldDetailLeaf',
  'RecordLinkFieldProps',
]
for (const needle of SOURCE_NEEDLES) {
  if (!srcBase.includes(needle) && !srcPaths.includes(needle)) {
    // record-link-options lives in paths; FormFieldDetailLeaf in base
    if (needle === 'record-link-options' || needle === 'listApprovalRecordLinkOptions') {
      if (!srcPaths.includes(needle)) fail(`source paths missing ${needle}`)
    } else if (!srcBase.includes(needle)) {
      fail(`source base.yml missing ${needle}`)
    }
  }
  if (!yaml.includes(needle) && !JSON.stringify(json).includes(needle)) {
    fail(`generated openapi dist missing content needle: ${needle}`)
  }
}
ok('source needles present in generated dist (content, not mtime)')

if (!yaml.includes('/api/approvals/record-link-options')) {
  fail('dist/openapi.yaml missing /api/approvals/record-link-options')
}
ok('record-link-options path present in dist')

if (!yaml.includes('listApprovalRecordLinkOptions')) {
  fail('dist/openapi.yaml missing operationId listApprovalRecordLinkOptions')
}

// FormField must be a discriminated oneOf (record-link vs generic) — not a single object with
// overlapping props oneOf (invalid: free-form object also matches RecordLinkFieldProps shapes).
const formField = json?.components?.schemas?.FormField
const formOneOf = formField?.oneOf
if (!Array.isArray(formOneOf) || formOneOf.length < 2) {
  fail('FormField must be a oneOf union (FormFieldRecordLink | FormFieldGeneric)')
}
const oneOfRefs = formOneOf.map((e) => String(e?.$ref || ''))
if (!oneOfRefs.some((r) => r.includes('FormFieldRecordLink'))) {
  fail(`FormField.oneOf must include FormFieldRecordLink, got ${JSON.stringify(oneOfRefs)}`)
}
if (!oneOfRefs.some((r) => r.includes('FormFieldGeneric'))) {
  fail(`FormField.oneOf must include FormFieldGeneric, got ${JSON.stringify(oneOfRefs)}`)
}
const disc = formField?.discriminator
if (!disc || disc.propertyName !== 'type') {
  fail('FormField.discriminator.propertyName must be type')
}
if (!String(disc?.mapping?.['record-link'] || '').includes('FormFieldRecordLink')) {
  fail('FormField.discriminator.mapping.record-link must point at FormFieldRecordLink')
}
ok('FormField is discriminated union (record-link vs generic)')

const rlField = json?.components?.schemas?.FormFieldRecordLink
const rlTypeEnum = rlField?.properties?.type?.enum
if (!Array.isArray(rlTypeEnum) || !rlTypeEnum.includes('record-link') || rlTypeEnum.length !== 1) {
  fail('FormFieldRecordLink.type must be enum [record-link] only')
}
const rlPropsRef = rlField?.properties?.props?.$ref || ''
if (!String(rlPropsRef).includes('RecordLinkFieldProps')) {
  fail(`FormFieldRecordLink.props must $ref RecordLinkFieldProps, got ${rlPropsRef}`)
}
if (!Array.isArray(rlField?.required) || !rlField.required.includes('props')) {
  fail('FormFieldRecordLink.required must include props')
}
// Closed outer object: columns / unknown keys must not be contract-legal on record-link.
if (rlField?.additionalProperties !== false) {
  fail(
    `FormFieldRecordLink.additionalProperties must be false (got ${JSON.stringify(rlField?.additionalProperties)})`,
  )
}
if (rlField?.properties?.columns !== undefined) {
  fail('FormFieldRecordLink must not declare columns (record-link is top-level only)')
}
if (rlField?.properties?.minRows !== undefined || rlField?.properties?.maxRows !== undefined) {
  fail('FormFieldRecordLink must not declare minRows/maxRows (detail-only keys)')
}
const rlAllowed = new Set([
  'id',
  'type',
  'label',
  'required',
  'placeholder',
  'defaultValue',
  'options',
  'props',
  'visibilityRule',
])
for (const key of Object.keys(rlField?.properties || {})) {
  if (!rlAllowed.has(key)) {
    fail(`FormFieldRecordLink has unexpected property ${key} (allowed: ${[...rlAllowed].join(', ')})`)
  }
}
ok('FormFieldRecordLink requires strict RecordLinkFieldProps + closed outer object')

// RecordLinkFieldProps: non-whitespace pattern (minLength alone accepts "   ").
const rlProps = json?.components?.schemas?.RecordLinkFieldProps
if (rlProps?.additionalProperties !== false) {
  fail(
    `RecordLinkFieldProps.additionalProperties must be false (got ${JSON.stringify(rlProps?.additionalProperties)})`,
  )
}
for (const pin of ['baseId', 'sheetId']) {
  const prop = rlProps?.properties?.[pin]
  if (!prop || prop.type !== 'string') {
    fail(`RecordLinkFieldProps.${pin} must be type string`)
  }
  if (typeof prop.minLength !== 'number' || prop.minLength < 1) {
    fail(`RecordLinkFieldProps.${pin} must have minLength >= 1`)
  }
  const pat = typeof prop.pattern === 'string' ? prop.pattern : ''
  // Discriminating: pattern must reject whitespace-only (require a non-whitespace class).
  if (!pat.includes('\\S') && !pat.includes('[^\\s]') && !pat.includes('[^ ]')) {
    fail(
      `RecordLinkFieldProps.${pin}.pattern must reject whitespace-only (need \\S or equivalent), got ${JSON.stringify(pat)}`,
    )
  }
  // Sanity: whitespace-only must NOT match the pattern.
  try {
    const re = new RegExp(pat)
    if (re.test('   ') || re.test('\t') || re.test('')) {
      fail(`RecordLinkFieldProps.${pin}.pattern still matches whitespace-only: ${JSON.stringify(pat)}`)
    }
    if (!re.test('base-1') || !re.test('a')) {
      fail(`RecordLinkFieldProps.${pin}.pattern must match a normal non-blank id`)
    }
  } catch (err) {
    fail(`RecordLinkFieldProps.${pin}.pattern is not a valid RegExp: ${pat} (${err})`)
  }
}
ok('RecordLinkFieldProps baseId/sheetId reject whitespace-only via pattern')

const genField = json?.components?.schemas?.FormFieldGeneric
const genTypeEnum = genField?.properties?.type?.enum
if (!Array.isArray(genTypeEnum) || genTypeEnum.includes('record-link')) {
  fail('FormFieldGeneric.type must exclude record-link (no oneOf overlap)')
}
const genProps = genField?.properties?.props
if (!genProps || genProps.$ref) {
  fail('FormFieldGeneric.props must be free-form object (not RecordLinkFieldProps ref)')
}
const columnsRef = genField?.properties?.columns?.items?.$ref || ''
if (!String(columnsRef).includes('FormFieldDetailLeaf')) {
  fail(`FormFieldGeneric.columns must $ref FormFieldDetailLeaf, got ${columnsRef}`)
}
ok('FormFieldGeneric excludes record-link and keeps free-form props')

const leaf = json?.components?.schemas?.FormFieldDetailLeaf
const leafEnum = leaf?.properties?.type?.enum
if (!Array.isArray(leafEnum)) {
  fail('FormFieldDetailLeaf missing — detail columns must not recurse FormField (record-link leak)')
}
if (leafEnum.includes('record-link') || leafEnum.includes('detail')) {
  fail('FormFieldDetailLeaf must not allow record-link or nested detail')
}
ok('FormFieldDetailLeaf excludes record-link/detail')

const notFound = json?.paths?.['/api/approvals/record-link-options']?.get?.responses?.['404']
const nfSchema = notFound?.content?.['application/json']?.schema
const nfRef = nfSchema?.$ref || ''
if (!String(nfRef).includes('ErrorResponse')) {
  fail(`record-link-options 404 must $ref ErrorResponse, got ${JSON.stringify(nfSchema)}`)
}
ok('record-link-options 404 uses ErrorResponse')

if (!dts.includes('listApprovalRecordLinkOptions')) {
  fail('SDK index.d.ts missing listApprovalRecordLinkOptions — generate:sdk did not run')
}
if (!dts.includes('/api/approvals/record-link-options')) {
  fail('SDK index.d.ts missing /api/approvals/record-link-options path')
}
if (!dts.includes('record-link') && !dts.includes('"record-link"')) {
  fail('SDK types missing record-link FormField type')
}
if (!dts.includes('FormFieldRecordLink') && !dts.includes('RecordLinkFieldProps')) {
  fail('SDK types missing FormFieldRecordLink / RecordLinkFieldProps (discriminated union not generated)')
}
// openapi-typescript should express the union (FormFieldRecordLink | FormFieldGeneric) or equivalent.
if (!dts.includes('FormFieldGeneric') && !dts.includes('FormFieldRecordLink')) {
  fail('SDK types missing FormField union members')
}
ok('SDK types include record-link surfaces + FormField union')

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
if (pkg.name !== '@metasheet/openapi') {
  fail(`packages/openapi/package.json name must be @metasheet/openapi, got ${pkg.name}`)
}
ok('package name is @metasheet/openapi (pnpm --filter works)')

// Content hash log (not compared to a stored golden — git diff is the drift gate).
console.log(`[openapi-guard] content-sha256 dist/openapi.json=${sha256(openapiJson).slice(0, 12)}…`)
console.log(`[openapi-guard] content-sha256 dist-sdk/index.d.ts=${sha256(sdkDts).slice(0, 12)}…`)
console.log('[openapi-guard] all checks passed')

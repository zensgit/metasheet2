#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv from 'ajv'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..')

const rootInput = process.argv[2] ?? 'output/playwright/attendance-prod-acceptance'
const minCountRaw = process.argv[3] ?? '1'
const schemaInput = process.argv[4] ?? 'schemas/attendance/strict-gate-summary.schema.json'

function info(message) {
  console.error(`[attendance-validate-gate-summary-schema] ${message}`)
}

function die(message) {
  console.error(`[attendance-validate-gate-summary-schema] ERROR: ${message}`)
  process.exit(1)
}

function resolveFromRepo(value) {
  if (!value) return repoRoot
  if (path.isAbsolute(value)) return path.resolve(value)
  return path.resolve(repoRoot, value)
}

async function pathType(targetPath) {
  try {
    const stat = await fs.stat(targetPath)
    if (stat.isDirectory()) return 'dir'
    if (stat.isFile()) return 'file'
    return 'other'
  } catch {
    return 'missing'
  }
}

async function collectSummaryFiles(targetPath) {
  const type = await pathType(targetPath)
  if (type === 'missing') return []
  if (type === 'file') {
    if (path.basename(targetPath) === 'gate-summary.json') return [targetPath]
    return []
  }
  if (type !== 'dir') return []

  const out = []
  const stack = [targetPath]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile() && entry.name === 'gate-summary.json') {
        out.push(full)
      }
    }
  }
  out.sort()
  return out
}

function formatErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return 'unknown schema error'
  return errors
    .slice(0, 10)
    .map((error) => {
      const pointer = error.instancePath && error.instancePath.length > 0 ? error.instancePath : '/'
      const message = error.message || 'validation error'
      return `${pointer} ${message}`
    })
    .join('; ')
}

async function main() {
  if (!/^[0-9]+$/.test(String(minCountRaw))) {
    die(`invalid min count: ${minCountRaw}`)
  }
  const minCount = Number(minCountRaw)

  const rootPath = resolveFromRepo(rootInput)
  const schemaPath = resolveFromRepo(schemaInput)

  const schemaType = await pathType(schemaPath)
  if (schemaType !== 'file') {
    die(`schema file not found: ${schemaPath}`)
  }

  let schema = null
  try {
    schema = JSON.parse(await fs.readFile(schemaPath, 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    die(`failed to parse schema JSON: ${message}`)
  }

  const files = await collectSummaryFiles(rootPath)
  if (files.length < minCount) {
    die(`gate-summary.json count=${files.length} < expected minimum=${minCount} (root=${rootPath})`)
  }

  const ajv = new Ajv({
    allErrors: true,
    strict: false,
  })
  const validate = ajv.compile(schema)

  for (const filePath of files) {
    let value = null
    try {
      value = JSON.parse(await fs.readFile(filePath, 'utf8'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      die(`failed to parse JSON (${filePath}): ${message}`)
    }

    const ok = validate(value)
    if (!ok) {
      die(`schema validation failed (${filePath}): ${formatErrors(validate.errors)}`)
    }
  }

  info(`OK: validated ${files.length} gate-summary.json file(s) with schema ${path.relative(repoRoot, schemaPath)}`)
}

await main()

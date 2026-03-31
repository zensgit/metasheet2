#!/usr/bin/env node

// OpenAPI spec smoke validator
// Reads all .yml files in packages/openapi/src/ and checks for basic structural issues.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OPENAPI_DIR = path.join(ROOT, 'packages', 'openapi', 'src')

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Usage: node scripts/openapi-check.mjs [options]

Validate OpenAPI specs in packages/openapi/src/.

Options:
  --help, -h    Show this help message
  --verbose     Show detailed output for each file

Checks performed:
  - YAML syntax (basic line-by-line validation)
  - Top-level structure (openapi/info/paths for main files; paths for fragments)
  - $ref references point to existing files
  - No duplicate path definitions across files
  - All path operations have at least a responses block

Exit codes:
  0  All checks passed
  1  Issues found`)
  process.exit(0)
}

const verbose = process.argv.includes('--verbose')

let filesChecked = 0
let issuesFound = 0
const allPaths = new Map() // path -> source file
const issues = []

function addIssue(file, message) {
  issues.push({ file: path.relative(ROOT, file), message })
  issuesFound++
}

function log(msg) {
  if (verbose) console.log(msg)
}

/**
 * Basic YAML validation: check for obvious syntax issues.
 * We intentionally avoid adding a YAML parser dependency.
 */
function checkYamlBasics(content, filePath) {
  const lines = content.split('\n')
  let hasTabIndent = false
  let unclosedQuote = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Check for tab indentation (YAML only allows spaces)
    if (/^\t/.test(line)) {
      hasTabIndent = true
      addIssue(filePath, `Line ${i + 1}: Tab indentation detected (YAML requires spaces)`)
    }
  }

  return { hasTabIndent }
}

/**
 * Extract top-level keys from YAML content (simple heuristic).
 */
function getTopLevelKeys(content) {
  const keys = []
  const lines = content.split('\n')
  for (const line of lines) {
    // Top-level key: starts at column 0, has format "key:" (not a comment, not blank)
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*/)
    if (match && !line.startsWith('#')) {
      keys.push(match[1])
    }
  }
  return keys
}

/**
 * Extract path definitions from YAML content.
 */
function extractPaths(content) {
  const paths = []
  const lines = content.split('\n')
  let inPaths = false

  for (const line of lines) {
    if (/^paths:\s*$/.test(line) || /^paths:$/.test(line.trim()) && !line.startsWith(' ')) {
      inPaths = true
      continue
    }
    // New top-level key ends paths block
    if (inPaths && /^[a-zA-Z]/.test(line) && !line.startsWith('#')) {
      inPaths = false
      continue
    }
    // Path definition: exactly 2-space indent, starts with /
    if (inPaths) {
      const pathMatch = line.match(/^  (\/[^\s:]+):/)
      if (pathMatch) {
        paths.push(pathMatch[1])
      }
    }
  }
  return paths
}

/**
 * Extract $ref values from content.
 */
function extractRefs(content) {
  const refs = []
  const refPattern = /\$ref:\s*['"]?([^'"}\s]+)['"]?/g
  let match
  while ((match = refPattern.exec(content)) !== null) {
    refs.push(match[1])
  }
  return refs
}

/**
 * Check that path operations have responses.
 * Handles both multi-line and inline YAML styles.
 */
function checkPathResponses(content, filePath) {
  const lines = content.split('\n')
  let currentPath = null
  let currentMethod = null
  let hasResponses = false

  const httpMethods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head']

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Detect path (2-space indent, starts with /)
    const pathMatch = line.match(/^  (\/[^\s:]+):/)
    if (pathMatch) {
      // Check previous method
      if (currentMethod && !hasResponses) {
        addIssue(filePath, `${currentPath} ${currentMethod}: missing responses block`)
      }
      currentPath = pathMatch[1]
      currentMethod = null
      hasResponses = false
      continue
    }

    // Detect method (4-space indent)
    const methodMatch = line.match(/^    ([a-z]+):/)
    if (methodMatch && httpMethods.includes(methodMatch[1])) {
      // Check previous method
      if (currentMethod && !hasResponses) {
        addIssue(filePath, `${currentPath} ${currentMethod}: missing responses block`)
      }
      currentMethod = methodMatch[1]
      hasResponses = false
      continue
    }

    // Detect responses - both multi-line (responses:\n) and inline (responses: { ... })
    if (currentMethod && /\bresponses\s*:/.test(line)) {
      hasResponses = true
    }
  }

  // Check last method
  if (currentMethod && !hasResponses) {
    addIssue(filePath, `${currentPath} ${currentMethod}: missing responses block`)
  }
}

// --- Main ---

if (!fs.existsSync(OPENAPI_DIR)) {
  console.error(`ERROR: OpenAPI directory not found: ${OPENAPI_DIR}`)
  process.exit(1)
}

const files = fs.readdirSync(OPENAPI_DIR).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))

if (files.length === 0) {
  console.error('ERROR: No YAML files found in', OPENAPI_DIR)
  process.exit(1)
}

for (const file of files) {
  const filePath = path.join(OPENAPI_DIR, file)
  const content = fs.readFileSync(filePath, 'utf-8')
  filesChecked++

  log(`Checking ${file}...`)

  // 1. Basic YAML validation
  checkYamlBasics(content, filePath)

  // 2. Top-level structure
  const topKeys = getTopLevelKeys(content)

  const isMainSpec = topKeys.includes('openapi')
  const isFragment = topKeys.includes('paths') && !isMainSpec

  if (!isMainSpec && !isFragment) {
    // Could be a components-only file or other structure - just warn
    log(`  Note: ${file} has neither openapi nor paths top-level key`)
  }

  if (isMainSpec) {
    if (!topKeys.includes('info')) {
      addIssue(filePath, 'Main spec missing "info" key')
    }
    if (!topKeys.includes('paths')) {
      addIssue(filePath, 'Main spec missing "paths" key')
    }
  }

  // 3. Extract and check paths for duplicates
  const filePaths = extractPaths(content)
  for (const p of filePaths) {
    if (allPaths.has(p)) {
      addIssue(filePath, `Duplicate path "${p}" (also in ${allPaths.get(p)})`)
    } else {
      allPaths.set(p, file)
    }
  }

  // 4. Check $ref references
  const refs = extractRefs(content)
  for (const ref of refs) {
    // Only check file references (not internal #/ references)
    if (ref.startsWith('#/')) continue
    const refFile = ref.split('#')[0]
    if (refFile) {
      const refPath = path.resolve(OPENAPI_DIR, refFile)
      if (!fs.existsSync(refPath)) {
        addIssue(filePath, `$ref points to missing file: ${refFile}`)
      }
    }
  }

  // 5. Check path operations have responses
  checkPathResponses(content, filePath)

  log(`  ${filePaths.length} paths, ${refs.length} refs`)
}

// --- Summary ---

console.log('')
console.log('=== OpenAPI Spec Check ===')
console.log(`Files checked: ${filesChecked}`)
console.log(`Total paths:   ${allPaths.size}`)
console.log(`Issues found:  ${issuesFound}`)

if (issues.length > 0) {
  console.log('')
  for (const issue of issues) {
    console.log(`  [ISSUE] ${issue.file}: ${issue.message}`)
  }
  console.log('')
  console.log('FAILED')
  process.exit(1)
} else {
  console.log('')
  console.log('PASSED')
  process.exit(0)
}

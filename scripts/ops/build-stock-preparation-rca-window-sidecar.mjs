#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const FROZEN_RUNTIME_SHA = 'd87e086fd1218b4cfb150177d43f2c52904b1d6d'
const FROZEN_HELPERS = Object.freeze({
  'stock-preparation-prep-line-extended-smoke.mjs': '912f3ef75c4487dbdd946486d4cb7374f1c3ea1eb126c3b68381ad11963f0049',
  'stock-preparation-mvp-postdeploy-smoke.mjs': 'e5265a2a8052ddc34866438a1ee3356b5d2aa1a106c8199f5e2fbbe4f2614df4',
  'stock-preparation-rca-window-pm2-sample.mjs': '09cc76024bd98fd4ce86cfa834eea3b94680482d0d0970600da008a19a6731ec',
})
const FILES = Object.freeze([
  'stock-preparation-rca-window.ps1',
  'stock-preparation-rca-window-pm2-sample.mjs',
  'stock-preparation-prep-line-extended-smoke.mjs',
  'stock-preparation-mvp-postdeploy-smoke.mjs',
  'stock-preparation-rca-window-README.txt',
])

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function parseArgs(argv) {
  const result = { outputDir: path.join(repoRoot, 'output/stock-preparation-rca-window-sidecar'), sourceSha: '' }
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--output-dir' && value) { result.outputDir = path.resolve(value); i += 1; continue }
    if (flag === '--source-sha' && value) { result.sourceSha = value; i += 1; continue }
    throw new Error('USAGE')
  }
  if (!/^[0-9a-f]{40}$/.test(result.sourceSha)) throw new Error('SOURCE_SHA_INVALID')
  return result
}

export function buildSidecar({ outputDir, sourceSha }) {
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error('SOURCE_SHA_INVALID')
  for (const [name, expected] of Object.entries(FROZEN_HELPERS)) {
    const actual = sha256(path.join(repoRoot, 'scripts/ops', name))
    if (actual !== expected) throw new Error('FROZEN_HELPER_MISMATCH')
  }

  const packageName = `stock-preparation-rca-c-window-sidecar-${sourceSha.slice(0, 10)}`
  const packageDir = path.join(outputDir, packageName)
  fs.rmSync(packageDir, { recursive: true, force: true })
  fs.mkdirSync(packageDir, { recursive: true })
  for (const name of FILES) {
    fs.copyFileSync(path.join(repoRoot, 'scripts/ops', name), path.join(packageDir, name))
  }

  const provenance = {
    contract: 'stock-preparation-rca-c-window-sidecar-v1',
    sourceGitCommit: sourceSha,
    frozenRuntimeGitCommit: FROZEN_RUNTIME_SHA,
    frozenHelperSha256: FROZEN_HELPERS,
    externalWrite: false,
  }
  fs.writeFileSync(path.join(packageDir, 'BUILD_PROVENANCE.json'), `${JSON.stringify(provenance, null, 2)}\n`)

  const checksumNames = [...FILES, 'BUILD_PROVENANCE.json'].sort()
  const checksumLines = checksumNames.map((name) => `${sha256(path.join(packageDir, name))}  ${name}`)
  fs.writeFileSync(path.join(packageDir, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`)
  return { packageName, packageDir }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const built = buildSidecar(parseArgs(process.argv))
    process.stdout.write(`${JSON.stringify({ packageName: built.packageName })}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'BUILD_FAILED'}\n`)
    process.exitCode = 2
  }
}

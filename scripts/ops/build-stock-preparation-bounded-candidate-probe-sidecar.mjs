#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PM2_HELPER = Object.freeze({
  name: 'stock-preparation-rca-window-pm2-sample.mjs',
  sha256: '09cc76024bd98fd4ce86cfa834eea3b94680482d0d0970600da008a19a6731ec',
})
const FILES = Object.freeze([
  'stock-preparation-bounded-candidate-probe.ps1',
  'stock-preparation-bounded-candidate-probe-README.txt',
  PM2_HELPER.name,
])

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function parseArgs(argv) {
  const result = {
    outputDir: path.join(repoRoot, 'output/stock-preparation-bounded-candidate-probe'),
    sourceSha: '',
  }
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--output-dir' && value) {
      result.outputDir = path.resolve(value)
      index += 1
      continue
    }
    if (flag === '--source-sha' && value) {
      result.sourceSha = value
      index += 1
      continue
    }
    throw new Error('USAGE')
  }
  if (!/^[0-9a-f]{40}$/.test(result.sourceSha)) throw new Error('SOURCE_SHA_INVALID')
  return result
}

export function buildSidecar({ outputDir, sourceSha }) {
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error('SOURCE_SHA_INVALID')
  if (sha256(path.join(repoRoot, 'scripts/ops', PM2_HELPER.name)) !== PM2_HELPER.sha256) {
    throw new Error('FROZEN_HELPER_MISMATCH')
  }

  const packageName = `stock-preparation-bounded-discovery-${sourceSha.slice(0, 10)}`
  const packageDir = path.join(outputDir, packageName)
  fs.rmSync(packageDir, { recursive: true, force: true })
  fs.mkdirSync(packageDir, { recursive: true })

  for (const name of FILES) {
    fs.copyFileSync(path.join(repoRoot, 'scripts/ops', name), path.join(packageDir, name))
  }

  const provenance = {
    contract: 'stock-preparation-bounded-candidate-discovery-sidecar-v2',
    sourceGitCommit: sourceSha,
    targetShell: 'Windows PowerShell 5.1',
    requestedRunCount: 1,
    deployment: false,
    configMutation: false,
    flagOn: false,
    externalWrite: false,
    valuesFreePublicOutput: true,
    sourceCountDiagnostics: 'closed-stage-v2',
    frozenHelperSha256: { [PM2_HELPER.name]: PM2_HELPER.sha256 },
  }
  fs.writeFileSync(
    path.join(packageDir, 'BUILD_PROVENANCE.json'),
    `${JSON.stringify(provenance, null, 2)}\n`,
  )

  const checksumNames = [...FILES, 'BUILD_PROVENANCE.json'].sort()
  const checksumLines = checksumNames.map(
    (name) => `${sha256(path.join(packageDir, name))}  ${name}`,
  )
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

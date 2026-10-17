#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const entry = fileURLToPath(import.meta.url)
const repository = path.resolve(path.dirname(entry), '../..')
const typedEntry = path.join(repository, 'packages/core-backend/scripts/run-stock-preparation-yida-synthetic-trial.mts')
const prefix = 'YIDA_SYNTHETIC_TRIAL '

export const HELP = `Usage:
  node scripts/ops/run-stock-preparation-yida-synthetic-trial.mjs --pg-bin=/absolute/postgresql/bin --ttl-seconds=300
  node scripts/ops/run-stock-preparation-yida-synthetic-trial.mjs --help

Linux, non-root, complete development workspace only. TTL is an integer 60..900.
Creates a fresh owned synthetic database; all external sends remain OFF.
READY identifies a private local handoff file. Never enter real material.
No browser is launched. Ordinary browsers are not network-isolation attested.
Stop with stdin "stop", SIGINT/SIGTERM, or the bounded TTL.
No existing DB, env file, real credentials, target, or internal-worker arguments.
`

/** This is the actual public CLI parser, not a test-only replacement. */
export function parseSyntheticTrialArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true }
  assert.equal(args.length, 2)
  assert(args[0].startsWith('--pg-bin=') && args[1].startsWith('--ttl-seconds='))
  const pgBin = args[0].slice('--pg-bin='.length)
  const ttlText = args[1].slice('--ttl-seconds='.length), ttlSeconds = Number(ttlText)
  assert(path.posix.isAbsolute(pgBin))
  assert(/^[1-9][0-9]*$/u.test(ttlText) && Number.isSafeInteger(ttlSeconds) && ttlSeconds >= 60 && ttlSeconds <= 900)
  return { help: false, pgBin, ttlSeconds }
}

export function assertSyntheticTrialPlatform(platform = process.platform,
  uid = process.getuid?.() ?? 0, gid = process.getgid?.() ?? 0) {
  assert.equal(platform, 'linux')
  assert(uid > 0 && gid > 0)
}

export function cleanSyntheticTrialEnvironment(source) {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) =>
    ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'COMSPEC', 'PATHEXT', 'HOME'].includes(key.toUpperCase())
    && typeof value === 'string'))
}

export async function runSyntheticTrial(args = process.argv.slice(2)) {
  const options = parseSyntheticTrialArguments(args)
  if (options.help) { process.stdout.write(HELP); return }
  assertSyntheticTrialPlatform()
  const env = cleanSyntheticTrialEnvironment(process.env)
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]
  // Installed tsx 4.20.6 register() uses node:module.register in this process;
  // its async unregister() deactivates that loader. No extra launcher child.
  const requireCore = createRequire(path.join(repository, 'packages/core-backend/package.json'))
  const { register } = await import(pathToFileURL(requireCore.resolve('tsx/esm/api')).href)
  const unregister = register()
  try { await import(pathToFileURL(typedEntry).href) }
  finally { await unregister() }
}

if (process.argv[1] && path.resolve(process.argv[1]) === entry) {
  try { await runSyntheticTrial() }
  catch { console.log(prefix + JSON.stringify({ stage: 'FAILED' })); process.exitCode = 1 }
}

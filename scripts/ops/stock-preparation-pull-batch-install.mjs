#!/usr/bin/env node
// stock-preparation-pull-batch-install.mjs — the OPS-SIDE client of the per-sheet 批次标识 install (batch-identifier design
// §8.8; register R-65; BI-2). An HTTP client of POST /api/integration/stock-preparation/projects/:projectNo/target/pull-batch
// and nothing else: it never reads a database, never writes a file, never decides anything the route does not.
//
// DEFAULT = A DRY-RUN of every project listed in --projects-file (one project number per line; `#` comments and blank
// lines ignored). Each answer is printed as ONE JSON line identified by the project's INPUT ORDINAL (1-based), NEVER by
// its project number, and carrying only an allow-list of the answer's values-free keys — so the output can be pasted as
// public evidence (design §8.8).
//
// --install acts on ONE project (--ordinal) with the typed confirmations the route requires (the approval reference, the
// plan digest the dry-run showed, the attested historical pull count) and re-POSTs while the route answers
// `write_budget` (at most 200 times, then a non-zero exit). --abort aborts ONE project's install. Every real run is OWNER
// GATE ② per sheet (O-BI-1 / O-BI-8): this script only carries the owner-approved parameters to the route.
//
// Env: MS_API (base URL), MS_TOKEN (an admin bearer token BOUND TO the target tenant — a token without a tenantId claim is
// refused unless --allow-tenantless), MS_TENANT_ID. The token is redacted from every line written (exact match and any
// Bearer-shaped value); argv values are never echoed.

import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { jwtHasTenantClaim } from './stock-preparation-scheduled-pull.mjs'

export class UsageError extends Error {}

const MAX_BUDGET_ROUNDS = 200
const ANSWER_KEYS = Object.freeze(['mode', 'run', 'K', 'planDigest', 'refusals', 'resolved', 'reason', 'count', 'remaining', 'written', 'skipped', 'historyStatus', 'provisional'])
const APPROVAL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/
const PLAN_DIGEST_PATTERN = /^[0-9a-f]{64}$/
const VALUE_FLAGS = Object.freeze({
  '--projects-file': 'projectsFile',
  '--ordinal': 'ordinal',
  '--approval-ref': 'approvalRef',
  '--plan-digest': 'planDigest',
  '--confirm-count': 'confirmCount',
  '--history-mode': 'historyMode',
  '--placement': 'placement',
  '--landing': 'landing',
  '--gap-minutes': 'gapMinutes',
})

export const HELP_TEXT = `Usage: node scripts/ops/stock-preparation-pull-batch-install.mjs --projects-file <path> [options]

Default: a values-free DRY-RUN of every project in the file (one JSON line per input ordinal, never a project number).

  --install --ordinal <n> --approval-ref <ref> --plan-digest <hex> --confirm-count <int>
            [--history-mode inferred|unknown] [--placement left|right] [--landing promote_prep_fill|keep_current]
            [--gap-minutes <int>]      install the batch columns of ONE project (owner gate per sheet); re-posts while
                                       the route answers write_budget (at most ${MAX_BUDGET_ROUNDS} times)
  --abort --ordinal <n> --approval-ref <ref>
                                       abort ONE project's install
  --allow-tenantless                   proceed with a token without a tenantId claim (not recommended)
  --help, -h                           print this text

Env: MS_API, MS_TOKEN (an admin token bound to the tenant), MS_TENANT_ID.
Exit code: 1 on any HTTP failure or refusal (in --install / --abort mode on the one project), 2 on a usage error,
3 when an install answered but did not resolve (rows after the plan / rows still blank): run it again.
`

export function parseArgs(argv) {
  const flags = { install: false, abort: false, allowTenantless: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') flags.help = true
    else if (arg === '--install') flags.install = true
    else if (arg === '--abort') flags.abort = true
    else if (arg === '--allow-tenantless') flags.allowTenantless = true
    else if (Object.prototype.hasOwnProperty.call(VALUE_FLAGS, arg)) {
      if (index + 1 >= argv.length) throw new UsageError(`${arg} needs a value`)
      flags[VALUE_FLAGS[arg]] = argv[index + 1]
      index += 1
    } else throw new UsageError(`unrecognized argument at position ${index} (see --help); its value is not echoed`)
  }
  if (flags.help) return flags
  if (!flags.projectsFile) throw new UsageError('--projects-file is required')
  if (flags.install && flags.abort) throw new UsageError('--install and --abort are exclusive')
  const integer = (name, value, min) => {
    if (value === undefined) return undefined
    if (!/^\d+$/.test(String(value)) || Number(value) < min) throw new UsageError(`${name} must be an integer of at least ${min} (its value is not echoed)`)
    return Number(value)
  }
  if (flags.install || flags.abort) {
    flags.ordinal = integer('--ordinal', flags.ordinal, 1)
    if (flags.ordinal === undefined) throw new UsageError('--ordinal is required with --install / --abort')
    if (flags.approvalRef === undefined || !APPROVAL_REF_PATTERN.test(flags.approvalRef)) throw new UsageError('--approval-ref is required and must be a register row or comment reference (its value is not echoed)')
  }
  if (flags.install) {
    if (flags.planDigest === undefined || !PLAN_DIGEST_PATTERN.test(flags.planDigest)) throw new UsageError('--plan-digest is required: the 64-hex digest the dry-run showed')
    flags.confirmCount = integer('--confirm-count', flags.confirmCount, 0)
    if (flags.confirmCount === undefined) throw new UsageError('--confirm-count is required: the attested historical pull count')
    if (flags.historyMode !== undefined && !['inferred', 'unknown'].includes(flags.historyMode)) throw new UsageError('--history-mode must be inferred or unknown')
    if (flags.placement !== undefined && !['left', 'right'].includes(flags.placement)) throw new UsageError('--placement must be left or right')
    if (flags.landing !== undefined && !['promote_prep_fill', 'keep_current'].includes(flags.landing)) throw new UsageError('--landing must be promote_prep_fill or keep_current')
  }
  flags.gapMinutes = integer('--gap-minutes', flags.gapMinutes, 1)
  return flags
}

export function readProjects(text) {
  return String(text).split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'))
}

let activeSecret = null
function redact(text) {
  let out = String(text)
  if (activeSecret) {
    out = out.split(activeSecret).join('<redacted>')
    const escaped = JSON.stringify(activeSecret).slice(1, -1)
    if (escaped && escaped !== activeSecret) out = out.split(escaped).join('<redacted>')
  }
  return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g, 'Bearer <redacted>')
}

let stdoutSink = (text) => { process.stdout.write(text) }
let stderrSink = (text) => { process.stderr.write(text) }
/** TEST-ONLY. Redirects output and returns a function to undo it. */
export function __setOutputSinksForTesting(sinks = {}) {
  const previous = { stdoutSink, stderrSink }
  if (typeof sinks.stdout === 'function') stdoutSink = sinks.stdout
  if (typeof sinks.stderr === 'function') stderrSink = sinks.stderr
  return () => { stdoutSink = previous.stdoutSink; stderrSink = previous.stderrSink }
}
const writeOut = (text) => stdoutSink(redact(text))
const writeErr = (text) => stderrSink(redact(text))

async function postInstall({ apiBase, token, tenantId, projectNo, body, timeoutMs }) {
  const url = `${apiBase}/api/integration/stock-preparation/projects/${encodeURIComponent(projectNo)}/target/pull-batch?tenantId=${encodeURIComponent(tenantId)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  try {
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-tenant-id': tenantId },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      return { networkError: true, errorName: error && error.name ? String(error.name) : null }
    }
    let json = null
    try { json = await response.json() } catch { json = null }
    return { httpStatus: response.status, ok: response.ok && Boolean(json && json.ok === true), json }
  } finally {
    clearTimeout(timer)
  }
}

/** The values-free line of one answer: the ordinal and an allow-list of keys — nothing else leaves the server answer. */
export function lineOf(ordinal, answer) {
  const line = { ordinal }
  if (answer.networkError) return { ...line, ok: false, code: 'NETWORK_ERROR', errorName: answer.errorName }
  line.httpStatus = answer.httpStatus
  line.ok = answer.ok
  const envelope = answer.json && typeof answer.json === 'object' ? answer.json : {}
  if (!answer.ok) {
    const error = envelope.error && typeof envelope.error === 'object' ? envelope.error : {}
    line.code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code) ? error.code : null
    return line
  }
  const data = envelope.data && typeof envelope.data === 'object' ? envelope.data : {}
  for (const key of ANSWER_KEYS) if (Object.prototype.hasOwnProperty.call(data, key)) line[key] = data[key]
  if (line.K === undefined && data.plan && Number.isSafeInteger(data.plan.K)) line.K = data.plan.K
  if (data.requires && data.requires.confirmHistoricalBatchCount && Number.isSafeInteger(data.requires.confirmHistoricalBatchCount.inferred)) line.confirmCountInferred = data.requires.confirmHistoricalBatchCount.inferred
  if (data.extension && typeof data.extension === 'object') line.extension = { K: data.extension.K, planDigest: data.extension.planDigest }
  return line
}

export async function main(argv, env, { readFile = (file) => fs.readFileSync(file, 'utf8') } = {}) {
  activeSecret = null
  let flags
  try {
    flags = parseArgs(argv)
  } catch (error) {
    writeErr(`${error.message}\n`)
    return 2
  }
  if (flags.help) {
    writeOut(HELP_TEXT)
    return 0
  }
  const missing = ['MS_API', 'MS_TOKEN', 'MS_TENANT_ID'].filter((name) => !(env[name] && String(env[name]).trim()))
  if (missing.length > 0) {
    writeErr(`missing required environment variable(s): ${missing.join(', ')}\n`)
    return 1
  }
  const token = String(env.MS_TOKEN).trim()
  if (/[\x00-\x1f]/.test(token)) {
    writeErr('MS_TOKEN contains a control character and was refused\n')
    return 1
  }
  activeSecret = token
  if (jwtHasTenantClaim(token) !== true && !flags.allowTenantless) {
    writeErr('MS_TOKEN does not carry a tenantId claim; refusing (mint it from an admin account bound to the tenant, or pass --allow-tenantless)\n')
    return 1
  }
  let projects
  try {
    projects = readProjects(readFile(flags.projectsFile))
  } catch {
    writeErr('the projects file could not be read (its path is not echoed)\n')
    return 1
  }
  if (projects.length === 0) {
    writeErr('the projects file lists no project\n')
    return 1
  }
  const config = { apiBase: String(env.MS_API).trim().replace(/\/+$/, ''), token, tenantId: String(env.MS_TENANT_ID).trim(), timeoutMs: 600000 }
  const write = (line) => writeOut(`${JSON.stringify(line)}\n`)
  const summary = { projectCount: projects.length, mode: flags.install ? 'install' : (flags.abort ? 'abort' : 'dry_run'), failed: 0 }

  if (!flags.install && !flags.abort) {
    for (const [index, projectNo] of projects.entries()) {
      const answer = await postInstall({ ...config, projectNo, body: { mode: 'dry_run', confirmProjectNo: projectNo, ...(flags.gapMinutes ? { gapMinutes: flags.gapMinutes } : {}) } })
      const line = lineOf(index + 1, answer)
      if (!line.ok) summary.failed += 1
      write(line)
    }
    write({ summary })
    return summary.failed > 0 ? 1 : 0
  }

  if (flags.ordinal > projects.length) {
    writeErr('--ordinal is beyond the projects file\n')
    return 2
  }
  const projectNo = projects[flags.ordinal - 1]
  const body = flags.abort
    ? { mode: 'abort', confirmProjectNo: projectNo, approvalRef: flags.approvalRef }
    : {
      mode: 'install',
      confirmProjectNo: projectNo,
      approvalRef: flags.approvalRef,
      planDigest: flags.planDigest,
      confirmHistoricalBatchCount: flags.confirmCount,
      ...(flags.historyMode ? { historyMode: flags.historyMode } : {}),
      ...(flags.placement ? { placement: flags.placement } : {}),
      ...(flags.landing ? { landing: flags.landing } : {}),
      ...(flags.gapMinutes ? { gapMinutes: flags.gapMinutes } : {}),
    }
  let rounds = 0
  for (;;) {
    rounds += 1
    const answer = await postInstall({ ...config, projectNo, body })
    const line = lineOf(flags.ordinal, answer)
    write(line)
    if (!line.ok) {
      summary.failed = 1
      break
    }
    if (flags.install && line.reason === 'write_budget') {
      if (rounds >= MAX_BUDGET_ROUNDS) {
        summary.failed = 1
        summary.budgetRoundsExhausted = true
        break
      }
      continue
    }
    summary.resolved = line.resolved === true || flags.abort
    break
  }
  summary.rounds = rounds
  write({ summary })
  if (summary.failed > 0) return 1
  // An install that answered but did not resolve (rows after the plan, rows still blank) is not done: exit 3, re-run.
  return flags.install && summary.resolved !== true ? 3 : 0
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntryPoint) {
  main(process.argv.slice(2), process.env)
    .then(async (code) => {
      process.exitCode = code
      await new Promise((resolve) => { setImmediate(resolve) })
    })
    .catch((error) => {
      writeErr(`${error && error.name ? error.name : 'Error'}: the install client failed\n`)
      process.exitCode = 1
    })
}

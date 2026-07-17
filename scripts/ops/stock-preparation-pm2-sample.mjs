#!/usr/bin/env node

// Normalize `pm2 jlist` before PowerShell sees it. Windows PowerShell treats
// object keys case-insensitively, so ordinary environment pairs such as
// `Path`/`PATH` make ConvertFrom-Json reject the otherwise valid PM2 payload.
// This helper emits only the coarse fields needed by the acceptance runner
// and never echoes input, env values, or parse errors.
//
// corrective-6 (entity finding ACCEPTANCE_TOKEN_PERSISTED_IN_PM2_ENV): the
// projection additionally reports whether the acceptance token variables are
// NON-EMPTY in the managed process environment — booleans only, NEVER the
// value — so the runner can fail closed when a token leaked into pm2.

const APP_NAME = 'metasheet-backend'
const ALLOWED_STATES = new Set([
  'online',
  'stopping',
  'stopped',
  'launching',
  'errored',
  'one-launch-status',
  'waiting restart',
])
// Windows environment names are case-INSENSITIVE, so detection matches any case variant (owner P2:
// `metasheet_admin_token=LEAKED` must count). An optional argv[2] names the operator-configured admin
// carrier (-AdminTokenEnvVar) and folds into the admin boolean.
const CUSTOM_ADMIN_CARRIER = typeof process.argv[2] === 'string' && process.argv[2].trim() ? process.argv[2].trim() : null
const ADMIN_CARRIERS = [...new Set([CUSTOM_ADMIN_CARRIER, 'METASHEET_ADMIN_TOKEN'].filter(Boolean))]
const AUTH_CARRIERS = ['METASHEET_AUTH_TOKEN']

import fs from 'node:fs'

// fs.readFileSync(0) instead of the async stdin iterator: Windows PowerShell 5.1 string-pipes can
// race an ESM module's async stdin attach (observed as an empty read -> silent exit 1 on the CI
// windows arm), while a synchronous fd-0 read drains whatever the pipe delivered.
let raw = ''
try {
  raw = fs.readFileSync(0, 'utf8')
} catch {
  raw = ''
}

try {
  // Windows PowerShell 5.1 pipes strings to native stdin through the console host, which HARD-WRAPS
  // at the console buffer width - a CRLF can land in the middle of any JSON token (observed on the
  // CI windows arm: short probes survive, a 176-char payload does not). Valid JSON cannot contain a
  // raw CR/LF inside a string literal and no two JSON tokens are delimited by whitespace alone, so
  // stripping every raw CR/LF provably reconstructs a parseable document.
  const processes = JSON.parse(raw.replace(/[\r\n]+/g, ''))
  if (!Array.isArray(processes)) throw new Error('invalid_shape')

  const matches = processes.filter((entry) => entry?.name === APP_NAME)
  if (matches.length !== 1) throw new Error('target_count')

  const pm2Env = matches[0]?.pm2_env
  const rawState = typeof pm2Env?.status === 'string' ? pm2Env.status : ''
  const restartTime = pm2Env?.restart_time
  const uptime = pm2Env?.pm_uptime
  if (!Number.isSafeInteger(restartTime) || restartTime < 0) throw new Error('restart_time')
  if (!Number.isSafeInteger(uptime) || uptime < 0) throw new Error('uptime')

  // pm2 exposes the captured environment both merged into pm2_env and under pm2_env.env; a token
  // counts as leaked if ANY case variant of a carrier name holds a non-empty string on EITHER bag.
  const envBag = pm2Env && typeof pm2Env.env === 'object' && pm2Env.env !== null ? pm2Env.env : {}
  const carrierNonEmpty = (names) => {
    const targets = new Set(names.map((name) => name.toUpperCase()))
    for (const bag of [envBag, pm2Env]) {
      if (!bag || typeof bag !== 'object') continue
      for (const key of Object.keys(bag)) {
        if (!targets.has(key.toUpperCase())) continue
        const value = bag[key]
        if (typeof value === 'string' && value.trim().length > 0) return true
      }
    }
    return false
  }

  process.stdout.write(JSON.stringify({
    state: ALLOWED_STATES.has(rawState) ? rawState : 'unknown',
    restartTime,
    uptime,
    adminTokenNonEmpty: carrierNonEmpty(ADMIN_CARRIERS),
    authTokenNonEmpty: carrierNonEmpty(AUTH_CARRIERS),
  }))
} catch {
  process.exitCode = 1
}

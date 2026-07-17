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
const TOKEN_ENV_VARS = ['METASHEET_ADMIN_TOKEN', 'METASHEET_AUTH_TOKEN']

let raw = ''
for await (const chunk of process.stdin) raw += chunk

try {
  const processes = JSON.parse(raw)
  if (!Array.isArray(processes)) throw new Error('invalid_shape')

  const matches = processes.filter((entry) => entry?.name === APP_NAME)
  if (matches.length !== 1) throw new Error('target_count')

  const pm2Env = matches[0]?.pm2_env
  const rawState = typeof pm2Env?.status === 'string' ? pm2Env.status : ''
  const restartTime = pm2Env?.restart_time
  const uptime = pm2Env?.pm_uptime
  if (!Number.isSafeInteger(restartTime) || restartTime < 0) throw new Error('restart_time')
  if (!Number.isSafeInteger(uptime) || uptime < 0) throw new Error('uptime')

  // pm2 exposes the captured environment both merged into pm2_env and under pm2_env.env;
  // a token counts as leaked if it is a non-empty string on EITHER carrier.
  const envBag = pm2Env && typeof pm2Env.env === 'object' && pm2Env.env !== null ? pm2Env.env : {}
  const tokenNonEmpty = (name) => {
    for (const candidate of [envBag[name], pm2Env?.[name]]) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) return true
    }
    return false
  }

  process.stdout.write(JSON.stringify({
    state: ALLOWED_STATES.has(rawState) ? rawState : 'unknown',
    restartTime,
    uptime,
    adminTokenNonEmpty: tokenNonEmpty(TOKEN_ENV_VARS[0]),
    authTokenNonEmpty: tokenNonEmpty(TOKEN_ENV_VARS[1]),
  }))
} catch {
  process.exitCode = 1
}

#!/usr/bin/env node

// Values-free PM2 projection for the #4437 RC-A ON -> smoke -> OFF window.
// Windows PowerShell 5.1 cannot safely ConvertFrom-Json a raw `pm2 jlist` payload when the
// environment contains case-variant keys such as Path/PATH. This helper parses the payload in Node
// and emits only the process state, restart counters, token-presence booleans, and whether the one
// temporary RC-A feature flag is effectively true. It never emits environment values.

const APP_NAME = 'metasheet-backend'
const FLAG_NAME = 'MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED'
const TOKEN_CARRIERS = Object.freeze(['METASHEET_AUTH_TOKEN', 'METASHEET_ADMIN_TOKEN'])
const ALLOWED_STATES = new Set([
  'online',
  'stopping',
  'stopped',
  'launching',
  'errored',
  'one-launch-status',
  'waiting restart',
])

let raw = ''
for await (const chunk of process.stdin) raw += chunk

try {
  const processes = JSON.parse(raw.replace(/^\uFEFF/, ''))
  if (!Array.isArray(processes)) throw new Error('invalid_shape')
  const matches = processes.filter((entry) => entry?.name === APP_NAME)
  if (matches.length !== 1) throw new Error('target_count')

  const pm2Env = matches[0]?.pm2_env
  const rawState = typeof pm2Env?.status === 'string' ? pm2Env.status : ''
  const restartTime = pm2Env?.restart_time
  const uptime = pm2Env?.pm_uptime
  if (!Number.isSafeInteger(restartTime) || restartTime < 0) throw new Error('restart_time')
  if (!Number.isSafeInteger(uptime) || uptime < 0) throw new Error('uptime')

  const envBag = pm2Env && typeof pm2Env.env === 'object' && pm2Env.env !== null ? pm2Env.env : {}
  const bags = [envBag, pm2Env].filter((bag) => bag && typeof bag === 'object')
  const valuesFor = (name) => {
    const expected = name.toUpperCase()
    const values = []
    for (const bag of bags) {
      for (const key of Object.keys(bag)) {
        if (key.toUpperCase() === expected) values.push(bag[key])
      }
    }
    return values
  }
  const carrierNonEmpty = (name) => valuesFor(name).some(
    (value) => typeof value === 'string' && value.trim().length > 0,
  )
  const flagEnabled = valuesFor(FLAG_NAME).some(
    (value) => typeof value === 'string' && value.trim().toLowerCase() === 'true',
  )

  process.stdout.write(JSON.stringify({
    state: ALLOWED_STATES.has(rawState) ? rawState : 'unknown',
    restartTime,
    uptime,
    authTokenNonEmpty: carrierNonEmpty(TOKEN_CARRIERS[0]),
    adminTokenNonEmpty: carrierNonEmpty(TOKEN_CARRIERS[1]),
    plmAutoPersistEnabledTrue: flagEnabled,
  }))
} catch {
  process.exitCode = 1
}

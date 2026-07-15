#!/usr/bin/env node

// Normalize `pm2 jlist` before PowerShell sees it. Windows PowerShell treats
// object keys case-insensitively, so ordinary environment pairs such as
// `Path`/`PATH` make ConvertFrom-Json reject the otherwise valid PM2 payload.
// This helper emits only the three coarse fields needed by the acceptance
// runner and never echoes input or parse errors.

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

  process.stdout.write(JSON.stringify({
    state: ALLOWED_STATES.has(rawState) ? rawState : 'unknown',
    restartTime,
    uptime,
  }))
} catch {
  process.exitCode = 1
}

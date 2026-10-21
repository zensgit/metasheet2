import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// This runner owns its cluster. It never accepts a database URL or existing data directory.
assert.ok(process.argv.slice(2).every(argument => ['--browser', '--attachment-stage', '--workbench'].includes(argument)), 'UNKNOWN_ACCEPTANCE_ARGUMENT')
const browser = process.argv.includes('--browser')
const attachmentStage = process.argv.includes('--attachment-stage')
const workbench = process.argv.includes('--workbench')
assert.ok([browser, attachmentStage, workbench].filter(Boolean).length <= 1, 'INCOMPATIBLE_ACCEPTANCE_ARGUMENTS')
const bin = await realpath(process.env.TM_TEST_PG_BIN ?? '/invalid')
const repo = fileURLToPath(new URL('../../', import.meta.url))
const root = await mkdtemp(join(await realpath(tmpdir()), 'tm-manual-checkpoint-cluster-'))
const pgdata = join(root, 'pgdata')
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LC_ALL: 'C' }
const run = (name, args) => spawnSync(join(bin, name), args, { env, encoding: 'utf8', timeout: 30000 })
async function runPnpm(args, childEnv) {
  const code = await new Promise((accept, reject) => {
    const child = spawn('pnpm', ['--filter', '@metasheet/core-backend', ...args], {
      cwd: repo, stdio: 'inherit', timeout: 1200000, env: childEnv,
    })
    child.once('error', reject)
    child.once('exit', accept)
  })
  assert.equal(code, 0, 'SYNTHETIC_CHECKPOINT_ACCEPTANCE_FAILED')
}
let initialized = false
try {
  const init = run('initdb', ['-D', pgdata, '-U', 'tm_manual', '-A', 'trust', '--no-locale', '--encoding=UTF8'])
  assert.equal(init.status, 0, 'SYNTHETIC_CLUSTER_INIT_FAILED')
  initialized = true
  const listener = createServer()
  await new Promise((accept, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', accept)
  })
  const port = listener.address().port
  await new Promise((accept, reject) => listener.close((error) => error ? reject(error) : accept()))
  assert.ok(port >= 1024 && ![5432, 5433, 5435].includes(port))
  const start = run('pg_ctl', ['-D', pgdata, '-l', join(root, 'server.log'), '-w', 'start',
    '-o', `-h 127.0.0.1 -p ${port} -c unix_socket_directories=''`])
  assert.equal(start.status, 0, 'SYNTHETIC_CLUSTER_START_FAILED')
  if (workbench) {
    const database = `tm_browser_acceptance_${randomBytes(12).toString('hex')}`
    const connect = ['-h', '127.0.0.1', '-p', String(port), '-U', 'tm_manual']
    assert.equal(run('createdb', [...connect, database]).status, 0, 'WORKBENCH_DATABASE_CREATE_FAILED')
    try {
      const config = join(root, 'config.json')
      await writeFile(config, '{}\n', { mode: 0o600 })
      const databaseEnv = { ...env, NODE_ENV: 'test', METASHEET_ENV_DIR: root, CONFIG_FILE: config,
        SECRET_PROVIDER: 'env', JWT_SECRET: randomBytes(48).toString('hex'),
        DATABASE_URL: `postgresql://tm_manual@127.0.0.1:${port}/${database}` }
      await runPnpm(['migrate'], databaseEnv)
      await runPnpm(['exec', 'tsx', 'scripts/verify-timemachine-workbench.mts'], databaseEnv)
    } finally {
      const census = run('psql', [...connect, '-d', 'postgres', '-At', '-c',
        `SELECT count(*) FROM pg_stat_activity WHERE datname='${database}'`])
      assert.equal(census.status, 0, 'WORKBENCH_DATABASE_CENSUS_FAILED')
      assert.equal(census.stdout.trim(), '0', 'WORKBENCH_DATABASE_CONNECTIONS_REMAIN')
      assert.equal(run('dropdb', [...connect, database]).status, 0, 'WORKBENCH_DATABASE_DROP_FAILED')
      console.log('CLEAN: owned workbench database dropped; connections=0')
    }
  } else {
    const scripts = attachmentStage ? ['scripts/verify-recovery-attachment-stage.mts']
      : ['scripts/verify-recovery-manual-checkpoint.mts', 'scripts/verify-recovery-attachment-stage.mts']
    for (const script of scripts) {
      await runPnpm(['exec', 'tsx', script], { ...env, NODE_ENV: 'test', TM_MANUAL_TEST_PGDATA: pgdata,
        ...(browser ? { TM_MANUAL_TEST_BROWSER: 'true' } : {}),
        TM_MANUAL_TEST_ADMIN_URL: `postgresql://tm_manual@127.0.0.1:${port}/postgres` })
    }
  }
} finally {
  if (initialized) {
    const status = run('pg_ctl', ['-D', pgdata, 'status'])
    if (status.status === 0) {
      assert.equal(run('pg_ctl', ['-D', pgdata, '-m', 'fast', '-w', 'stop']).status, 0,
        'SYNTHETIC_CLUSTER_STOP_FAILED')
    } else {
      assert.equal(status.status, 3, 'SYNTHETIC_CLUSTER_STATUS_UNKNOWN')
    }
    assert.match((await readFile(join(pgdata, 'PG_VERSION'), 'utf8')).trim(), /^\d+$/)
    assert.equal(run('pg_ctl', ['-D', pgdata, 'status']).status, 3)
  }
  assert.equal(await realpath(root), resolve(root))
  await rm(root, { recursive: true })
  console.log('CLEAN: owned synthetic cluster stopped and removed')
}

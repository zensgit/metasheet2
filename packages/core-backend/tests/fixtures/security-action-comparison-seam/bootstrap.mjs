import { createHash } from 'node:crypto'
import { closeSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { assertSeamDatabaseOwner, validateSeamDatabaseUrl } from './database-owner.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const repo = resolve(root, '../../../../..')
const pins = {
  'packages/core-backend/src/auth/security-action-attempt-admission.ts': '95190b7079a8b8d36eb6a68ed5bcf04432ad04087a241c96141938e17a8e4247',
  'packages/core-backend/src/db/pg.ts': '1810088e95b8e5c8d3156a89908652de1a9165c6d3290bf5835f97aeecaaa4bb',
  'packages/core-backend/src/integration/db/connection-pool.ts': '80f32e2ec3695e96cc76ad2adfb6cd28cfd7901c89c4636c17e42ce2db8e34b3',
  'docs/development/security-action-attempt-coordination-design-lock-20261117.md': 'aecb64b7d141c21c144e796d994f5f10e4d5207b53320a715d50bbce34b87c71',
}
let context
let journal
let role
let sequence = 0
let journalFailed = false
const requireCondition = (condition) => { if (!condition) throw new Error('SEAM_BOOTSTRAP_REFUSED') }
const emit = (event, outcome) => {
  try {
    if (journal === undefined) return
    writeSync(journal, `${JSON.stringify({ event, role, seq: ++sequence, supervisorPid: process.pid, outcome })}\n`)
  } catch {
    journalFailed = true
  }
}

try {
  process.umask(0o077)
  requireCondition(process.execArgv.length === 0 && process.argv.length === 2 && !process.env.NODE_OPTIONS)
  role = process.env.SA_SEAM_ROLE
  requireCondition(['owner', 'peer', 'smoke'].includes(role))
  const control = process.env.SA_SEAM_CONTROL_DIR
  requireCondition(typeof control === 'string' && isAbsolute(control))
  const controlStat = lstatSync(control)
  const childPath = relative(realpathSync(join(repo, 'artifacts')), realpathSync(control))
  requireCondition(controlStat.isDirectory() && !controlStat.isSymbolicLink()
    && (controlStat.mode & 0o777) === 0o700 && controlStat.uid === process.getuid?.()
    && childPath !== '' && childPath !== '..' && !childPath.startsWith(`..${sep}`) && !isAbsolute(childPath))
  requireCondition(readdirSync(control).length === 0)
  journal = openSync(join(control, 'bootstrap.jsonl'), 'ax', 0o600)
  emit('BOOTSTRAP_STARTED', 'PENDING')
  requireCondition(process.env.EXPECT_DB === '1' && process.env.SECRET_PROVIDER === 'env'
    && process.env.SA_SEAM_SYNTHETIC === 'true')
  const schema = process.env.SA_SCHEMA ?? ''
  requireCondition(/^sa_wpc_admit_[a-f0-9]{16}$/.test(schema))
  const database = validateSeamDatabaseUrl(process.env.DATABASE_URL ?? '', schema, role)
  process.env.DATABASE_URL = database.toString()
  const owner = JSON.parse(process.env.SA_SEAM_DATABASE_OWNER ?? 'null')
  requireCondition(['TRUE', 'FALSE', 'ERROR'].includes(process.env.SA_SEAM_OUTCOME)
    && ['none', 'insert'].includes(process.env.SA_SEAM_EFFECT)
    && Boolean(process.env.SA_SESSION_ID) && Boolean(process.env.SA_PASSWORD))
  const hashPattern = process.env.SA_SEAM_OUTCOME === 'ERROR'
    ? /^\$2c\$04\$[./A-Za-z0-9]{53}$/
    : /^\$2[aby]\$(?:04|12)\$[./A-Za-z0-9]{53}$/
  requireCondition(hashPattern.test(process.env.SA_PASSWORD_HASH ?? ''))
  const ack = process.env.SA_SEAM_ACK
  if (ack !== undefined) {
    requireCondition((ack === 'claim' || ack === 'account' || ack === 'release' || ack === 'acquisition')
      && role === 'smoke'
      && (process.env.SA_SEAM_OUTCOME === 'TRUE' || process.env.SA_SEAM_OUTCOME === 'FALSE'))
  }
  const fault = process.env.SA_SEAM_FAULT
  if (fault !== undefined) {
    requireCondition((fault === 'rollback-tx1' || fault === 'rollback-tx2' || fault === 'rollback-tx2-withheld'
      || fault === 'unlock-false' || fault === 'unlock-error')
      && role === 'smoke'
      && process.env.SA_SEAM_OUTCOME === 'TRUE'
      && ack === undefined)
  }
  const hold = process.env.SA_SEAM_HOLD
  if (hold !== undefined) {
    requireCondition((hold === 'blocked' || hold === 'abandoned')
      && ack === 'release'
      && role === 'smoke'
      && process.env.SA_SEAM_OUTCOME === 'TRUE'
      && fault === undefined)
  }
  const gate = process.env.SA_SEAM_GATE
  if (gate !== undefined) {
    requireCondition(gate === 'read'
      && role === 'smoke'
      && process.env.SA_SEAM_OUTCOME === 'TRUE'
      && process.env.SA_SEAM_EFFECT === 'none'
      && ack === undefined
      && fault === undefined
      && hold === undefined)
  }
  requireCondition(!readdirSync(root).some((name) => /^(?:vitest\.(?:workspace|projects|config)|vite\.config)\./.test(name)))
  for (const [path, expected] of Object.entries(pins)) {
    requireCondition(createHash('sha256').update(readFileSync(join(repo, path))).digest('hex') === expected)
  }
  const vitest = join(repo, 'node_modules/vitest')
  const bcrypt = join(repo, 'node_modules/bcryptjs')
  requireCondition(JSON.parse(readFileSync(join(vitest, 'package.json'), 'utf8')).version === '1.6.1')
  requireCondition(JSON.parse(readFileSync(join(bcrypt, 'package.json'), 'utf8')).version === '3.0.3')
  const allowed = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'DATABASE_URL', 'EXPECT_DB', 'SECRET_PROVIDER',
    'SA_SEAM_ROLE', 'SA_SEAM_CONTROL_DIR', 'SA_SEAM_SYNTHETIC', 'SA_SEAM_OUTCOME', 'SA_SEAM_EFFECT',
    'SA_SCHEMA', 'SA_SESSION_ID', 'SA_PASSWORD', 'SA_PASSWORD_HASH', 'SA_SEAM_ACK', 'SA_SEAM_FAULT',
    'SA_SEAM_HOLD', 'SA_SEAM_GATE'])
  for (const key of Object.keys(process.env)) if (!allowed.has(key)) delete process.env[key]
  Object.assign(process.env, {
    NODE_ENV: 'test', DB_POOL_MAX: '1', DB_POOL_MIN: '0', DB_CONNECT_TIMEOUT: '5000',
    DB_QUERY_TIMEOUT: '30000', DB_STATEMENT_TIMEOUT: '30000',
    SA_SEAM_SUPERVISOR_PID: String(process.pid), APP_NAME: `sa_wpc_seam_${role}`, LOG_LEVEL: 'error',
  })
  const { Client } = createRequire(import.meta.url)('pg')
  const probe = new Client({ connectionString: database.toString(), connectionTimeoutMillis: 5000, query_timeout: 5000 })
  try {
    await probe.connect()
    await assertSeamDatabaseOwner((text, params) => probe.query(text, params), schema, owner)
  } finally {
    await probe.end()
  }
  let finishedCount = 0
  let oneTestCompleted = false
  const reporter = {
    onInit: (value) => { context = value },
    onFinished: (files = [], errors = []) => {
      finishedCount += 1
      const file = files[0]
      const test = file?.tasks?.[0]
      oneTestCompleted = files.length === 1 && errors.length === 0 && file.filepath === join(root, 'comparison.worker.ts')
        && file.result?.state === 'pass' && file.tasks.length === 1 && test.type === 'test'
        && test.name === 'production comparison delivery seam' && test.result?.state === 'pass'
    },
  }
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback() } })
  const { startVitest } = await import(pathToFileURL(join(vitest, 'dist/node.js')).href)
  const result = await startVitest('test', ['comparison.worker.ts'], {
    root, config: false, run: true, watch: false, environment: 'node',
    include: ['comparison.worker.ts'], setupFiles: [], globalSetup: [],
    pool: 'forks', poolOptions: { forks: { singleFork: true, isolate: true, execArgv: [] } },
    fileParallelism: false, retry: 0, coverage: { enabled: false }, api: false, ui: false,
    passWithNoTests: false, allowOnly: false, testTimeout: 30000,
    clearMocks: false, mockReset: false, restoreMocks: false, cache: false,
    reporters: [reporter], silent: true, onConsoleLog: () => false,
  }, {
    envFile: false, cacheDir: join(control, 'vite-cache'), logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null },
    resolve: { alias: [{ find: /^bcryptjs$/, replacement: join(bcrypt, 'index.js') }] },
  }, { stdout: sink, stderr: sink })
  requireCondition(result && context === result && finishedCount === 1 && oneTestCompleted
    && context.state.getUnhandledErrors().length === 0 && !process.exitCode)
  const events = readFileSync(join(control, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const ready = events.filter((event) => event.event === 'WORKER_READY')
  requireCondition(ready.length === 1 && Number.isSafeInteger(ready[0].workerPid)
    && ready[0].workerPid > 0 && ready[0].workerPid !== process.pid && ready[0].supervisorPid === process.pid
    && events.every((event, index) => event.role === role && event.workerPid === ready[0].workerPid && event.seq === index + 1)
    && events.filter((event) => event.event === 'ATTEMPT_TERMINAL').length === 1
    && events.filter((event) => event.event === 'POOL_ENDED').length === 1
    && events.filter((event) => event.event === 'WORKER_DONE').length === 1
    && events.at(-1)?.event === 'WORKER_DONE')
  emit('BOOTSTRAP_FINISHED', 'COMPLETED')
  process.exitCode = journalFailed ? 1 : 0
} catch {
  process.exitCode = 1
  emit('BOOTSTRAP_FAILED', 'FAILED')
} finally {
  try {
    await context?.close()
  } catch {
    process.exitCode = 1
    emit('BOOTSTRAP_FAILED', 'FAILED')
  }
  if (journal !== undefined) closeSync(journal)
}

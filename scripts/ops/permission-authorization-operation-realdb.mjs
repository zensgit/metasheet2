import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const backend = path.join(root, 'packages/core-backend')
const names = ['permission_command_fence_test', 'permission_command_test', 'permission_command_compat_test']
const prefix = 'tests/integration/'
export const baseline = Object.freeze([
  { file: 'authorization-operation-fence.db.test.ts', min: 25, required: ['holds every attested table in EXCLUSIVE mode and leaves work timeouts active', 'returns retryable busy without waiting when an old writer holds a table'], skipped: [] },
  { file: 'authorization-operation-fullschema.db.test.ts', min: 14, required: ['previews, commits and replays using the real fence and current migrated schema', 'keeps real host HEAD, encoded receipt and ordinary-actor 403 paths read-only across the auth chain'], skipped: ['bounds slow pre-planning reads and never starts a late write', 'returns unknown while COMMIT is pending, then GET observes the late receipt and released locks', 'rolls back injected post-fence write failure on the same client'] },
  { file: 'authorization-operation-delegated.db.test.ts', min: 12, required: ['does not disclose whole-profile warnings to a delegated actor', 'does not union an A audience with a B admission and rejects platform or delegated admin roles', 'rechecks current audience for stored receipt reads and replay'], skipped: [] },
  { file: 'authorization-operation-exception.db.test.ts', min: 8, required: ['requires live RBAC admin before disclosing target existence', 'requires reason for grant and template and rejects a stale template before any writes', 'hides compatibility receipts and does not let a colliding key create a new receipt'], skipped: ['rejects a post-write legacy non-string mutation and rolls back', 'rolls back a direct write and receipt after post-fence audit failure'] },
  { file: 'authorization-operation-exception-compat.db.test.ts', min: 5, required: ['checks live RBAC authority for every compatibility entry and conceals target existence', 'rolls back template codes and receipt on a mandatory audit error'], skipped: [] },
  { file: 'authorization-operation-migration.db.test.ts', min: 2, required: ['rolls the receipt back when mandatory audit insertion fails'], skipped: [] },
  { file: 'authorization-operation-migration-provider.db.test.ts', min: 1, required: ['refuses migration and ledger writes while an authorization reader holds the world lock'], skipped: [] },
  { file: 'authorization-operation-schema-gate.db.test.ts', min: 2, required: ['holds R0 exclusive through the transaction and releases it on rollback'], skipped: [] },
  { file: 'authorization-operation-audit-feed.db.test.ts', min: 4, required: ['lists both sources once, with stable pagination, text actor and matching CSV filters', 'denies delegated actor both global surfaces'], skipped: [] },
])
export const unitBaseline = Object.freeze([
  {directory:'unit',file:'authorization-input-lock.test.ts',min:98,required:['ranks are strictly increasing in acquisition order and the order lists every rank'],skipped:[]},
  {directory:'unit',file:'authorization-input-consumers.guard.test.ts',min:7,required:['the authorization command write decision is registered as locked'],skipped:[]},
  {directory:'unit',file:'authorization-operation-validation.test.ts',min:27,required:['normalizes only reason and sorts explicitly chosen admissions'],skipped:[]},
  {directory:'unit',file:'authorization-operation-fence.test.ts',min:3,required:['locks the closed table set, qualified and without waiting'],skipped:[]},
  {directory:'unit',file:'authorization-operation-snapshot.test.ts',min:1,required:['binds the acting principal, complete input, policy classification, feature value and source rows'],skipped:[]},
  {directory:'unit',file:'authorization-schema-mutation.test.ts',min:4,required:['keeps every production schema-gate call inside the registered provider'],skipped:[]},
  {directory:'unit',file:'role-assignment-boundary.test.ts',min:46,required:['every scoped preset declares the capability it grants through roleId + permissions'],skipped:[]},
])
const full = 'authorization-operation-fullschema.db.test.ts'
const exception = 'authorization-operation-exception.db.test.ts'
export const variants = Object.freeze([
  { id:'fault-admission',file:full,title:'rolls back injected post-fence write failure on the same client',env:{PERMISSION_COMMAND_TEST_FAULT:'admission'} },
  { id:'fault-audit',file:full,title:'rolls back injected post-fence write failure on the same client',env:{PERMISSION_COMMAND_TEST_FAULT:'audit'} },
  { id:'fault-cleanup',file:full,title:'rolls back injected post-fence write failure on the same client',env:{PERMISSION_COMMAND_TEST_FAULT:'cleanup'} },
  { id:'exception-audit',file:exception,title:'rolls back a direct write and receipt after post-fence audit failure',env:{PERMISSION_COMMAND_TEST_FAULT:'audit'} },
  { id:'exception-integrity',file:exception,title:'rejects a post-write legacy non-string mutation and rolls back',env:{PERMISSION_COMMAND_TEST_FAULT:'legacy_corrupt'} },
  { id:'planning-deadline',file:full,title:'bounds slow pre-planning reads and never starts a late write',env:{PERMISSION_COMMAND_TEST_SLOW_PLAN:'1'} },
  { id:'late-commit',file:full,title:'returns unknown while COMMIT is pending, then GET observes the late receipt and released locks',env:{PERMISSION_COMMAND_TEST_DELAY_COMMIT:'1'} },
])
const unsafe = ['PERMISSION_COMMAND_TEST_UNFENCED_FIXTURE','PERMISSION_COMMAND_TEST_MUTATION','PERMISSION_COMMAND_TEST_FAULT','PERMISSION_COMMAND_TEST_DELAY_COMMIT','PERMISSION_COMMAND_TEST_SLOW_PLAN','MIGRATION_EXCLUDE','MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL']
export function validateEnvironment(env) {
  for (const key of ['DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED','RBAC_BYPASS','RBAC_TOKEN_TRUST']) if (env[key] !== 'false') throw new Error(`${key} must be exactly false`)
  for (const key of unsafe) if (env[key] !== undefined) throw new Error(`${key} must be absent from the parent environment`)
  let u
  try { u = new URL(env.PERMISSION_COMMAND_PG_BASE_URL) } catch { throw new Error('PERMISSION_COMMAND_PG_BASE_URL is required and must be valid') }
  if (!['postgres:', 'postgresql:'].includes(u.protocol) || !['127.0.0.1','[::1]'].includes(u.hostname) || u.pathname !== '/postgres' || !u.port || u.search || u.hash) throw new Error('PostgreSQL base URL must name a loopback /postgres service with an explicit port and no options')
  return u
}
export function validateDatabaseInfo(row, existing) {
  if (!(row?.version>=160000 && row.version<170000 && row.datcollate==='C' && row.datctype==='C' && row.encoding==='UTF8')) throw new Error('Expected PostgreSQL 16 with C collation/ctype and UTF8')
  if (existing.length) throw new Error('Dedicated fixture database already exists; start a fresh synthetic PostgreSQL service')
}
export function validateReport(report, expected, selectedTitle) {
  if (!report || report.success !== true || !Array.isArray(report.testResults)) throw new Error('Vitest JSON report missing or unsuccessful')
  const results=report.testResults
  for (const item of expected) {
    const matches=results.filter(result=>String(result.name).replaceAll('\\','/').endsWith(`/tests/${item.directory ?? 'integration'}/${item.file}`))
    if (matches.length!==1) throw new Error(`Expected exactly one result for ${item.file}`)
    const tests=matches[0].assertionResults
    if (!Array.isArray(tests)) throw new Error(`Missing test results for ${item.file}`)
    if (selectedTitle) {
      const matchesTitle=tests.filter(test=>test.title===selectedTitle)
      if(matchesTitle.length!==1 || matchesTitle[0].status!=='passed' || tests.filter(test=>test.status==='passed').length!==1 || tests.some(test=>test.status!=='passed' && test.status!=='skipped')) throw new Error(`Selected test did not pass exactly once: ${selectedTitle}`)
      continue
    }
    const passed=tests.filter(test=>test.status==='passed')
    if (passed.length<item.min) throw new Error(`Too few passing tests in ${item.file}: ${passed.length}`)
    for(const name of item.required) if(passed.filter(test=>test.title===name).length!==1) throw new Error(`Required test did not execute: ${name}`)
    for(const test of tests) if(test.status!=='passed' && !(test.status==='skipped' && item.skipped.includes(test.title))) throw new Error(`Unexpected ${test.status} test in ${item.file}: ${test.title}`)
    for(const name of item.skipped) if(!tests.some(test=>test.title===name && test.status==='skipped')) throw new Error(`Expected conditional skip not found: ${name}`)
  }
  if (results.length !== expected.length) throw new Error(`Unexpected test file count: ${results.length}`)
}
export function validateDeadlineReport(unit) {
  const files=unit?.testResults
  if (!unit?.success || !Array.isArray(files) || files.length!==1 || !String(files[0].name).replaceAll('\\','/').endsWith('/tests/unit/authorization-operation-deadline.test.ts')) throw new Error('Deadline unit report missing')
  const tests=files[0].assertionResults
  const required=['returns unknown and never starts the roles read if receipt lookup exceeds the deadline','returns unknown and never starts the write transaction if role planning exceeds the deadline']
  if (!Array.isArray(tests) || tests.length!==2 || tests.some(test=>test.status!=='passed') || required.some(name=>tests.filter(test=>test.title===name).length!==1)) throw new Error('Deadline unit test report incomplete')
}
function run(command,args,env,cwd=root) {
  const executable=process.platform==='win32' && command==='pnpm' ? 'pnpm.cmd' : command
  const useShell=process.platform==='win32' && command==='pnpm'
  const safeArgs=useShell ? args.map(arg=>`"${arg.replaceAll('"','""')}"`) : args
  const result=spawnSync(executable,safeArgs,{cwd,env,stdio:'inherit',shell:useShell})
  if(result.error) throw result.error
  if(result.status!==0) throw new Error(`${command} failed with exit ${result.status}`)
}
async function runTests(dir, env, id, expected, variant) {
  const report=path.join(dir,`${id}.json`)
  const files=expected.map(item=>`${prefix}${item.file}`)
  const args=['exec','vitest','run','--config','vitest.authorization-operation-realdb.config.ts',...files,'--reporter=json','--outputFile',report]
  if(variant) args.push('-t',variant.title)
  run('pnpm',args,{...env,...variant?.env},backend)
  validateReport(JSON.parse(await readFile(report,'utf8')),expected,variant?.title)
  process.stdout.write(`validated ${id}\n`)
}
export async function main(env=process.env) {
  const base=validateEnvironment(env)
  const require=createRequire(path.join(backend,'package.json'))
  const {Client}=require('pg')
  const client=new Client({connectionString:base.toString(),connectionTimeoutMillis:3000})
  await client.connect()
  try {
    const info=await client.query(`SELECT current_setting('server_version_num')::int AS version, d.datcollate, d.datctype, pg_encoding_to_char(d.encoding) AS encoding FROM pg_database d WHERE d.datname=current_database()`)
    const row=info.rows[0]
    const existing=await client.query("SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres'")
    validateDatabaseInfo(row,existing.rows)
    for(const name of names) await client.query(`CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`)
  } finally { await client.end() }
  const urls=names.map(name=>{const u=new URL(base);u.pathname=`/${name}`;return u.toString()})
  const clean={...env, DATABASE_URL:urls[1], PERMISSION_COMMAND_FENCE_DATABASE_URL:urls[0],PERMISSION_COMMAND_TEST_DATABASE_URL:urls[1],PERMISSION_COMMAND_COMPAT_DATABASE_URL:urls[2],VITEST_MAX_THREADS:'3'}
  for (const url of urls) run('pnpm',['--filter','@metasheet/core-backend','db:migrate'],{...clean,DATABASE_URL:url})
  const temp=path.join(root,'tmp','permission-authorization-operation-ci')
  await mkdir(temp,{recursive:true})
  const dir=await mkdtemp(path.join(temp,'run-'))
  await runTests(dir,clean,'baseline',baseline)
  const unitReport=path.join(dir,'unit-baseline.json')
  run('pnpm',['exec','vitest','run','--config','vitest.config.ts',...unitBaseline.map(item=>`tests/unit/${item.file}`),'--retry','0','--maxWorkers','3','--minWorkers','1','--reporter=json','--outputFile',unitReport],clean,backend)
  validateReport(JSON.parse(await readFile(unitReport,'utf8')),unitBaseline)
  process.stdout.write('validated unit-baseline\n')
  for (const variant of variants) await runTests(dir,clean,variant.id,[{file:variant.file}],variant)
  // Deadline unit tests have their own exact name and no real DB claim.
  const report=path.join(dir,'deadline-unit.json')
  run('pnpm',['exec','vitest','run','--config','vitest.authorization-operation-realdb.config.ts','tests/unit/authorization-operation-deadline.test.ts','--reporter=json','--outputFile',report],clean,backend)
  const unit=JSON.parse(await readFile(report,'utf8'))
  validateDeadlineReport(unit)
  process.stdout.write('validated deadline-unit\n')
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error=>{process.stderr.write(`authorization operation CI failed: ${error.message}\n`);process.exitCode=1})

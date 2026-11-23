import test from 'node:test'
import assert from 'node:assert/strict'
import { validateEnvironment, validateDatabaseInfo, validateReport, validateDeadlineReport, validateMutationReport } from './permission-authorization-operation-realdb.mjs'
const env={PERMISSION_COMMAND_PG_BASE_URL:'postgres://synthetic:synthetic@127.0.0.1:11111/postgres',DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED:'false',RBAC_BYPASS:'false',RBAC_TOKEN_TRUST:'false'}
const spec={file:'proof.db.test.ts',min:1,required:['real proof'],skipped:['conditional proof']}
const report=()=>({success:true,testResults:[{name:'/workspace/packages/core-backend/tests/integration/proof.db.test.ts',assertionResults:[{title:'real proof',status:'passed'},{title:'conditional proof',status:'skipped'}]}]})
test('requires explicitly disabled trust, bypass, and scope flags',()=>{
  assert.equal(validateEnvironment(env).hostname,'127.0.0.1')
  for(const key of ['DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED','RBAC_BYPASS','RBAC_TOKEN_TRUST']) for(const value of [undefined,'true','FALSE','']) assert.throws(()=>validateEnvironment({...env,[key]:value}),new RegExp(key))
})
test('rejects bypass/mutation overrides and non-loopback or option-bearing databases',()=>{
  for(const key of ['PERMISSION_COMMAND_TEST_UNFENCED_FIXTURE','PERMISSION_COMMAND_TEST_MUTATION','PERMISSION_COMMAND_TEST_FAULT','PERMISSION_COMMAND_TEST_DELAY_COMMIT','PERMISSION_COMMAND_TEST_SLOW_PLAN','MIGRATION_EXCLUDE','MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL']) assert.throws(()=>validateEnvironment({...env,[key]:'1'}),new RegExp(key))
  assert.throws(()=>validateEnvironment({...env,PERMISSION_COMMAND_PG_BASE_URL:undefined}))
  for(const url of ['postgres://x@host.test:5432/postgres','postgres://x@127.0.0.1:5432/production','postgres://x@127.0.0.1/postgres','postgres://x@127.0.0.1:5432/postgres?options=x']) assert.throws(()=>validateEnvironment({...env,PERMISSION_COMMAND_PG_BASE_URL:url}))
})
test('requires a successful report, correct file, passed required test and declared skips',()=>{
  validateReport(report(),[spec])
  const duplicate=report();duplicate.testResults.push(structuredClone(duplicate.testResults[0]));assert.throws(()=>validateReport(duplicate,[spec,spec]))
  assert.throws(()=>validateReport(report(),[{...spec,min:2}]))
  assert.throws(()=>validateReport(report(),[{...spec,required:['missing required case']}]))
  for(const mutate of [r=>r.success=false,r=>r.testResults=[],r=>r.testResults[0].name='/unrelated.test.ts',r=>r.testResults[0].assertionResults[0].status='skipped',r=>r.testResults[0].assertionResults[1].status='failed',r=>r.testResults[0].assertionResults.push({title:'unexpected skip',status:'skipped'}),r=>r.testResults.push(r.testResults[0])]) {const r=report();mutate(r);assert.throws(()=>validateReport(r,[spec]))}
})
test('conditional run must pass exactly its selected test and must not silently skip',()=>{
  const r=report();r.testResults[0].assertionResults=[{title:'wanted',status:'passed'},{title:'other',status:'skipped'}]
  validateReport(r,[spec],'wanted')
  for(const tests of [[{title:'wanted',status:'skipped'}],[{title:'wanted',status:'skipped'},{title:'other',status:'passed'}],[{title:'wanted',status:'passed'},{title:'other',status:'passed'}],[{title:'wrong',status:'passed'}]]) { const bad=report();bad.testResults[0].assertionResults=tests;assert.throws(()=>validateReport(bad,[spec],'wanted')) }
})

test('authorization mutants must fail only at the selected HTTP assertion', () => {
  const variant = { id: 'activation-filter-removed', file: spec.file, title: 'specific denial', failure: 'expected 200 to be 403' }
  const failed = report()
  failed.success = false
  failed.testResults[0].assertionResults[0] = { title: variant.title, status: 'failed', failureMessages: ['AssertionError: expected 200 to be 403'] }
  validateMutationReport(failed, variant)
  for (const change of [
    result => { result.success = true },
    result => { result.testResults = [] },
    result => { result.testResults[0].assertionResults[0].status = 'skipped' },
    result => { result.testResults[0].assertionResults[0].title = 'unrelated denial' },
    result => { result.testResults[0].assertionResults[0].failureMessages = ['Error: connection unavailable'] },
    result => { result.testResults[0].assertionResults[1].status = 'failed' },
  ]) {
    const changed = structuredClone(failed)
    change(changed)
    assert.throws(() => validateMutationReport(changed, variant))
  }
})

test('requires a fresh UTF8 C cluster of the explicitly verified PostgreSQL major',()=>{
  const valid={version:160016,datcollate:'C',datctype:'C',encoding:'UTF8'}
  validateDatabaseInfo(valid,[])
  for(const changed of [{version:150000},{version:170000},{datcollate:'en_US.UTF-8'},{datctype:'C.UTF-8'},{encoding:'LATIN1'}]) assert.throws(()=>validateDatabaseInfo({...valid,...changed},[]))
  for (const major of [14, 15, 16, 17]) {
    validateEnvironment({...env, PERMISSION_COMMAND_PG_MAJOR: String(major)})
    validateDatabaseInfo({...valid, version: major * 10000 + 12}, [], major)
    assert.throws(()=>validateDatabaseInfo({...valid, version: (major + 1) * 10000}, [], major))
  }
  for (const version of ['13', '18', '016', '']) assert.throws(()=>validateEnvironment({...env, PERMISSION_COMMAND_PG_MAJOR: version}))
  assert.throws(()=>validateDatabaseInfo(valid,[{datname:'permission_command_test'}]))
})

test('deadline proof requires both specifically named tests to pass',()=>{
  const valid={success:true,testResults:[{name:'/repo/tests/unit/authorization-operation-deadline.test.ts',assertionResults:[{title:'returns unknown and never starts the roles read if receipt lookup exceeds the deadline',status:'passed'},{title:'returns unknown and never starts the write transaction if role planning exceeds the deadline',status:'passed'}]}]}
  validateDeadlineReport(valid)
  for(const edit of [r=>r.testResults=[],r=>r.testResults[0].assertionResults.pop(),r=>r.testResults[0].assertionResults[0].status='skipped',r=>r.testResults[0].assertionResults[0].title='different']) {const copy=structuredClone(valid);edit(copy);assert.throws(()=>validateDeadlineReport(copy))}
})

test('unit reports are verified against the unit directory',()=>{
  const r=report();r.testResults[0].name='/workspace/packages/core-backend/tests/unit/proof.db.test.ts'
  validateReport(r,[{...spec,directory:'unit'}])
  assert.throws(()=>validateReport(r,[spec]))
})

test('the notification lock-capacity suite is a fenced baseline member with every case required', async () => {
  const { baseline, notificationLockCapacity } = await import('./permission-authorization-operation-realdb.mjs')
  const { readFileSync } = await import('node:fs')
  const entries = baseline.filter(item => item.file === notificationLockCapacity)
  assert.equal(entries.length, 1)
  const [entry] = entries
  assert.deepEqual(entry.skipped, [])
  const source = readFileSync(new URL(`../../packages/core-backend/tests/integration/${notificationLockCapacity}`, import.meta.url), 'utf8')
  const titles = [...source.matchAll(/\bit\('([^']+)'/g)].map(match => match[1])
  assert.equal(titles.length, 4)
  assert.equal(entry.min, titles.length)
  assert.deepEqual([...entry.required].sort(), [...titles].sort())
  // The config that runs the baseline must collect this name, or a file argument would match nothing.
  const config = readFileSync(new URL('../../packages/core-backend/vitest.authorization-operation-realdb.config.ts', import.meta.url), 'utf8')
  assert.match(notificationLockCapacity, /^authorization-operation-.+\.db\.test\.ts$/)
  assert.ok(config.includes("'tests/integration/authorization-operation-*.db.test.ts'"))
})

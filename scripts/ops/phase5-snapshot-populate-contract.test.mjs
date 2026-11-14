import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dbName = 'phase5_test_11111111-1111-4111-8111-111111111111';
const token = `header.${Buffer.from(JSON.stringify({ sub: '7' })).toString('base64url')}.signature`;

async function run(mode = '', env = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'phase5-snapshot-contract-'));
  const scripts = path.join(dir, 'scripts');
  const bin = path.join(dir, 'bin');
  const backend = path.join(dir, 'packages/core-backend');
  await mkdir(path.join(scripts, 'ops'), { recursive: true });
  await mkdir(path.join(backend, 'node_modules/pg'), { recursive: true });
  await mkdir(bin);
  await writeFile(path.join(backend, 'package.json'), '{}');
  await cp(process.env.PHASE5_CONTRACT_POPULATOR_SOURCE || path.join(root, 'scripts/phase5-populate-snapshots.sh'), path.join(scripts, 'phase5-populate-snapshots.sh'));
  await cp(process.env.PHASE5_CONTRACT_HELPER_SOURCE || path.join(root, 'scripts/ops/phase5-snapshot-fixture.mjs'), path.join(scripts, 'ops/phase5-snapshot-fixture.mjs'));
  const statePath = path.join(dir, 'state.json');
  const callsPath = path.join(dir, 'calls.jsonl');
  await writeFile(statePath, JSON.stringify({ snapshots: [], views: [], items: [], restoreCalls: 0 }));
  await writeFile(callsPath, '');
  await writeFile(path.join(backend, 'node_modules/pg/index.js'), `
const fs=require('fs');
const get=()=>JSON.parse(fs.readFileSync(process.env.STATE));
const save=s=>fs.writeFileSync(process.env.STATE,JSON.stringify(s));
exports.Client=class {
  async connect() {fs.appendFileSync(process.env.CALLS,JSON.stringify({db:'connect'})+'\\n');if(process.env.MODE==='uppercase-connect') throw Error('SECRET_CREDENTIAL');}
  async end() {}
  async query(sql,p=[]) {
    fs.appendFileSync(process.env.CALLS,JSON.stringify({sql,p})+'\\n');const s=get();const mode=process.env.MODE;
    if(mode==='uppercase-query') throw Error('SECRET_CREDENTIAL');
    if(sql==='SELECT current_database() AS name') return {rows:[{name:mode==='wrong-database'?'other':process.env.DB_NAME}]};
    if(sql.startsWith('SELECT u.id')) return {rows:mode==='missing-admin'?[]:[{id:process.env.TEST_ACTOR}]};
    if(sql.startsWith('SELECT (SELECT count')) return {rows:[{views:mode==='dirty-database'?1:0,snapshots:0}]};
    if(sql.startsWith('INSERT INTO views')) {s.views.push({id:p[0],table_id:null,type:p[1],name:p[2],config:JSON.parse(p[3])});save(s);if(mode==='interrupt-insert') {process.kill(process.pid,'SIGTERM');await new Promise(resolve=>setTimeout(resolve,20));}return {rowCount:1};}
    if(sql.startsWith('SELECT id, table_id')) return {rows:s.views.filter(v=>v.id===p[0])};
    if(sql.startsWith('SELECT id, view_id')) {const a=s.snapshots.filter(v=>v.id===p[0]);return {rows:mode==='foreign-snapshot'?a.map(v=>({...v,view_id:'foreign'})):a};}
    if(sql.startsWith('SELECT item_type')) {const a=s.items.filter(v=>v.snapshot_id===p[0]);return {rows:mode==='foreign-item'?a.map(v=>({...v,item_id:'foreign'})):mode==='extra-item'?[...a,...a]:a};}
    if(sql.startsWith('SELECT id FROM snapshots')) return {rows:s.snapshots.filter(v=>v.view_id===p[0]&&v.name===p[1]&&v.metadata.phase5_run===p[2]&&String(v.created_by)===p[3])};
    if(sql.startsWith('DELETE FROM snapshot_items')) {s.items=s.items.filter(v=>v.snapshot_id!==p[0]);save(s);return {rowCount:1};}
    if(sql.startsWith('DELETE FROM snapshots')) {const before=s.snapshots.length;s.snapshots=s.snapshots.filter(v=>!(v.id===p[0]&&v.view_id===p[1]&&v.name===p[2]));save(s);return {rowCount:before-s.snapshots.length};}
    if(sql.startsWith('DELETE FROM views')) {if(mode==='cleanup-failure') throw Error('SECRET cleanup detail');const before=s.views.length;s.views=s.views.filter(v=>!(v.id===p[0]&&v.name===p[1]&&v.config.phase5_run===p[2]));save(s);if(mode==='interrupt-cleanup') {process.kill(process.pid,'SIGTERM');await new Promise(resolve=>setTimeout(resolve,20));}return {rowCount:before-s.views.length};}
    if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)) return {rows:[]};
    throw Error('Unrecognized mock SQL');
  }
};
`);
  const curlPath = path.join(bin, 'curl');
  await writeFile(curlPath, `#!${process.execPath}
const fs=require('fs');const a=process.argv.slice(2);const route=a.find(v=>v.startsWith('http'));const method=a[a.indexOf('-X')+1];
const body=a.includes('--data')?JSON.parse(a[a.indexOf('--data')+1]):undefined;
const headers=a.flatMap((v,i)=>v==='-H'?[a[i+1]]:[]);const s=JSON.parse(fs.readFileSync(process.env.STATE));const mode=process.env.MODE;
fs.appendFileSync(process.env.CALLS,JSON.stringify({route,method,body,headers,args:a})+'\\n');
let status=200;let result;
if(mode==='transport') {process.stderr.write('SECRET transport details');process.exit(7);}
if(mode==='interrupt') {process.kill(process.ppid,'SIGTERM');setInterval(()=>{},1000);return;}
if(route.includes('/api/views/')) {const v=s.views[0];result={success:true,data:{...v,...v.config}};if(mode==='wrong-api') result.data.phase5_run='foreign';}
else if(route.endsWith('/api/snapshots')) {
  const id='22222222-2222-4222-8222-'+String(s.snapshots.length+1).padStart(12,'0');const v=s.views[0];s.snapshots.push({id,view_id:v.id,name:body.name,created_by:process.env.TEST_ACTOR,metadata:body.metadata});s.items.push({snapshot_id:id,item_type:'view',item_id:v.id,data:v});
  if(mode==='foreign-cleanup') s.snapshots.push({id:'foreign-id',view_id:'foreign-view',name:'foreign-name',created_by:'8',metadata:{}});
  status=201;result={ok:true,data:{id}};
  if(mode==='create-http') status=500;
  if(mode==='create-logical') result.ok=false;
  if(mode==='legacy-id') result={id};
  if(mode==='malformed') {fs.writeFileSync(process.env.STATE,JSON.stringify(s));process.stdout.write('SECRET invalid body\\n201');process.exit(0);}
} else if(route.endsWith('/safety/confirm')) {result={success:mode!=='confirm-logical'};if(mode==='confirm-http') status=403;}
else if(route.endsWith('/restore')) {
  s.restoreCalls++;
  if(s.restoreCalls%2===1) {status=403;result={code:'SAFETY_CHECK_REQUIRED',confirmation:{token:'safety-secret-'+Math.ceil(s.restoreCalls/2)}};if(mode==='challenge-status') status=200;if(mode==='challenge-code') result.code='ADMIN_REQUIRED';if(mode==='challenge-token') delete result.confirmation;}
  else {result={ok:true,data:{success:true,itemsRestored:1}};if(mode==='restore-http') status=500;if(mode==='restore-logical') result.ok=false;if(mode==='restore-data') result.data.success=false;if(mode==='zero-items') result.data.itemsRestored=0;if(mode==='two-items') result.data.itemsRestored=2;}
} else {throw Error('Unrecognized mock route');}
fs.writeFileSync(process.env.STATE,JSON.stringify(s));process.stdout.write(JSON.stringify(result)+'\\n'+status);
`);
  await chmod(curlPath, 0o755);
  try {
    const result = await new Promise(resolve => execFile('bash', ['scripts/phase5-populate-snapshots.sh'], {
      cwd: dir, env: { ...process.env, API_BASE: 'http://127.0.0.1:8900', DATABASE_URL: `postgresql://test:test@127.0.0.1:5432/${dbName}`,
        TOKEN: token, TEST_ACTOR: '7', SNAPSHOT_COUNT: '1', PATH: `${bin}:${process.env.PATH}`, STATE: statePath, CALLS: callsPath, DB_NAME: dbName, MODE: mode, ...env },
      timeout: 10_000,
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, killed: error?.killed, signal: error?.signal, stdout, stderr })));
    assert(!result.killed && !result.signal, 'Harness timeout or signal termination');
    assert(Number.isInteger(result.code), `Unexpected harness exit: ${result.code}`);
    return { ...result, state: JSON.parse(await readFile(statePath, 'utf8')), calls: (await readFile(callsPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('fresh owned fixture uses exact create schema and three-step partial restore, then scoped teardown', async () => {
  const result = await run();
  assert.equal(result.code, 0, result.stderr);
  const http = result.calls.filter(call => call.route);
  assert.equal(http.length, 5);
  const [link, create, challenge, confirm, retry] = http;
  assert.equal(link.method, 'GET');
  assert.deepEqual(Object.keys(create.body).sort(), ['description', 'metadata', 'name', 'snapshot_type', 'view_id']);
  assert.match(create.body.view_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(challenge.body, { restore_type: 'partial', item_types: ['view'] });
  assert.deepEqual(retry.body, challenge.body);
  assert.equal(retry.route, challenge.route);
  assert.deepEqual(confirm.body, { token: 'safety-secret-1', typedConfirmation: 'restore_snapshot', acknowledged: true });
  assert(retry.headers.includes('X-Safety-Token: safety-secret-1'));
  for (const call of http) {
    assert(call.headers.includes(`Authorization: Bearer ${token}`));
    assert(call.args.includes('--max-time'));
  }
  assert.deepEqual(result.state.views, []);
  assert.deepEqual(result.state.snapshots, []);
  assert.deepEqual(result.state.items, []);
  assert.doesNotMatch(result.stdout + result.stderr, /safety-secret|phase5-fixture-|signature|postgresql/);
});

for (const mode of ['wrong-database', 'missing-admin', 'dirty-database', 'wrong-api', 'create-http', 'create-logical', 'legacy-id', 'malformed',
  'foreign-snapshot', 'foreign-item', 'extra-item', 'challenge-status', 'challenge-code', 'challenge-token', 'confirm-http', 'confirm-logical',
  'restore-http', 'restore-logical', 'restore-data', 'zero-items', 'two-items', 'cleanup-failure', 'transport', 'uppercase-connect', 'uppercase-query']) {
  test(`${mode} cannot produce a passing population`, async () => {
    const result = await run(mode);
    assert.equal(result.code, 1, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /SECRET|safety-secret|signature|postgresql/);
    if (mode !== 'cleanup-failure') {
      assert.deepEqual(result.state.views, []);
      assert.deepEqual(result.state.snapshots, []);
      assert.deepEqual(result.state.items, []);
    }
    if (['wrong-database', 'missing-admin', 'dirty-database', 'wrong-api'].includes(mode)) {
      assert.equal(result.calls.filter(call => call.route && call.method === 'POST').length, 0);
    }
    if (['foreign-snapshot', 'foreign-item', 'extra-item', 'create-http', 'create-logical', 'legacy-id', 'malformed'].includes(mode)) {
      assert.equal(result.calls.filter(call => call.route?.endsWith('/restore')).length, 0);
    }
  });
}

test('teardown preserves foreign snapshots', async () => {
  const result = await run('foreign-cleanup');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.state.snapshots.length, 1);
  assert.equal(result.state.snapshots[0].id, 'foreign-id');
  assert.equal(result.state.views.length, 0);
});

test('external database and existing target inputs cannot authorize a restore', async () => {
  const result = await run('', { DATABASE_URL: `postgresql://test:test@external.invalid/${dbName}`, VIEW_ID: 'existing-view' });
  assert.equal(result.code, 1);
  assert.deepEqual(result.calls, []);
});

test('canonical userId takes precedence over conflicting id and sub claims', async () => {
  const canonical = `header.${Buffer.from(JSON.stringify({ userId: '7', id: '8', sub: '9' })).toString('base64url')}.signature`;
  const result = await run('', { TOKEN: canonical });
  assert.equal(result.code, 0, result.stderr);
  const adminRead = result.calls.find(call => call.sql?.startsWith('SELECT u.id'));
  assert.deepEqual(adminRead.p, ['7']);
});

test('interrupting an in-flight request cleans the owned view and stops all forward writes', async () => {
  const result = await run('interrupt');
  assert.equal(result.code, 143, result.stderr);
  assert.deepEqual(result.state.views, []);
  assert.deepEqual(result.state.snapshots, []);
  assert.equal(result.calls.filter(call => call.route && call.method === 'POST').length, 0);
  assert(result.calls.find(call => call.sql?.endsWith('FOR UPDATE')));
});

test('each new snapshot gets its own challenge and exactly matching retry', async () => {
  const result = await run('', { SNAPSHOT_COUNT: '2' });
  assert.equal(result.code, 0, result.stderr);
  const http = result.calls.filter(call => call.route);
  assert.equal(http.length, 9);
  for (let i = 0; i < 2; i++) {
    const [create, challenge, confirm, retry] = http.slice(1 + i * 4, 5 + i * 4);
    assert.equal(create.method, 'POST');
    assert.equal(retry.route, challenge.route);
    assert.deepEqual(retry.body, challenge.body);
    assert(retry.headers.includes(`X-Safety-Token: ${confirm.body.token}`));
    assert.equal(confirm.body.token, `safety-secret-${i + 1}`);
  }
  assert.notEqual(http[2].route, http[6].route);
  assert.deepEqual(result.state.views, []);
  assert.deepEqual(result.state.snapshots, []);
});

for (const mode of ['interrupt-insert', 'interrupt-cleanup']) {
  test(`${mode} preserves signal status and completes owned teardown`, async () => {
    const result = await run(mode);
    assert.equal(result.code, 143, result.stderr);
    assert.deepEqual(result.state.views, []);
    assert.deepEqual(result.state.snapshots, []);
    assert.deepEqual(result.state.items, []);
    if (mode === 'interrupt-insert') assert.equal(result.calls.filter(call => call.route).length, 0);
  });
}

test('an existing UUID test admin matches the text actor schema', async () => {
  const actor = '33333333-3333-4333-8333-333333333333';
  const canonical = `header.${Buffer.from(JSON.stringify({ userId: actor })).toString('base64url')}.signature`;
  const result = await run('', { TOKEN: canonical, TEST_ACTOR: actor });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.calls.find(call => call.sql?.startsWith('SELECT u.id')).p, [actor]);
});

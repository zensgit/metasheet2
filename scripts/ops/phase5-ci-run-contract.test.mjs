import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function run(options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'phase5-run-contract-'));
  const scripts = path.join(dir, 'scripts');
  const bin = path.join(dir, 'bin');
  await mkdir(scripts);
  await mkdir(bin);
  await cp(process.env.PHASE5_CONTRACT_RUNNER_SOURCE || path.join(root, 'scripts/phase5-ci-run.sh'), path.join(scripts, 'phase5-ci-run.sh'));
  if (options.cleanupTimeout) {
    const source = await readFile(path.join(scripts, 'phase5-ci-run.sh'), 'utf8');
    await writeFile(path.join(scripts, 'phase5-ci-run.sh'), source.replace('wait_try<400', 'wait_try<2'));
  }
  const executable = async (file, body) => {
    await writeFile(file, body);
    await chmod(file, 0o755);
  };
  await executable(path.join(scripts, 'phase5-dev-jwt.sh'), '#!/bin/bash\necho test-token\n');
  await executable(path.join(scripts, 'phase5-populate-snapshots.sh'), `#!/bin/bash
echo "$$" > "$HELPER_PID"
if [[ "\${SNAPSHOT_INTERRUPT:-}" == 1 ]]; then
  if [[ "\${SNAPSHOT_DOUBLE_SIGNAL:-}" == 1 ]]; then
    helper_cleanup() {
      trap '' INT TERM
      echo helper-cleanup-start >> "$CALLS"
      kill -TERM "$PPID"
      /bin/sleep 0.1
      echo helper-cleanup >> "$CALLS"
      exit 143
    }
    trap helper_cleanup TERM
  elif [[ "\${IGNORE_TERM:-}" == 1 ]]; then trap '' TERM; else trap 'echo helper-cleanup >> "$CALLS"; exit 143' TERM; fi
  kill -TERM "$PPID"
  while :; do /bin/sleep 0.05; done
fi
exit "\${SNAPSHOT_EXIT:-0}"
`);
  await executable(path.join(scripts, 'phase5-full-validate.sh'), '#!/bin/bash\n[ "${VALIDATE_EXIT:-0}" = 0 ] || exit "$VALIDATE_EXIT"\nprintf \'{"summary":{"overall_status":"%s","passed":%s,"failed":0,"na":%s}}\' "${VALIDATE_STATUS:-pass}" "${VALIDATE_PASSED:-11}" "${VALIDATE_NA:-0}" > "$2"\n');
  await executable(path.join(scripts, 'phase5-generate-report.sh'), '#!/bin/bash\n[ "${REPORT_EXIT:-0}" = 0 ] || exit "$REPORT_EXIT"\necho report > "$2"\n');
  await executable(path.join(bin, 'pnpm'), '#!/bin/bash\necho "$$" > "$OWNED_PID"\n[[ "${BASELINE_LAUNCHER_ONESHOT:-}" == 1 ]] && exit 0\ntrap \'echo cleanup >> "$CALLS"; exit 0\' TERM\nwhile :; do /bin/sleep 0.05; done\n');
  await executable(path.join(bin, 'lsof'), '#!/bin/bash\necho listener-inspection >> "$CALLS"\ncat "$OWNED_PID"\n');
  await executable(path.join(bin, 'ps'), '#!/bin/bash\nif [[ "${FOREIGN_LISTENER:-}" == 1 ]]; then echo 999999; else cat "$OWNED_PID"; fi\n');
  await executable(path.join(bin, 'sleep'), '#!/bin/bash\nexit 0\n');
  await executable(path.join(bin, 'node'), `#!${process.execPath}\nconst fs=require('fs');if(process.argv.includes('--check')) {fs.appendFileSync(process.env.CALLS,'fixture-check\\n');process.exit(Number(process.env.FIXTURE_EXIT||0));}fs.appendFileSync(process.env.CALLS,'port-check\\n');process.exit(process.env.OCCUPIED==='1'?1:0);\n`);
  await executable(path.join(bin, 'curl'), `#!${process.execPath}
const fs=require('fs');const a=process.argv.slice(2);const u=a.find(x=>x.startsWith('http'));fs.appendFileSync(process.env.CALLS,JSON.stringify(a)+'\\n');
let body='{"ok":true,"success":true,"enabled":true}';let status='200';
if(u.includes('metrics/prom')) body='cache_hits_total 10\\ncache_miss_total 1\\nmetasheet_plugin_reload_duration_seconds_count 5\\nmetasheet_snapshot_operation_duration_seconds_count 5\\n';
if(u.endsWith('/plugins/example-plugin/reload')) {if(!a.some(v=>v.startsWith('X-Safety-Token:'))) {status='403';body='{"code":"SAFETY_CHECK_REQUIRED","confirmation":{"token":"reload-token"}}';if(process.env.RELOAD_CHALLENGE_CODE==='1') body='{"code":"ADMIN_REQUIRED","confirmation":{"token":"reload-token"}}';if(process.env.RELOAD_CHALLENGE_TOKEN==='1') body='{"code":"SAFETY_CHECK_REQUIRED"}';}else {body=JSON.stringify({success:true,pluginId:process.env.RELOAD_WRONG_PLUGIN==='1'?'other-plugin':'example-plugin',runtime:{status:process.env.RELOAD_INACTIVE==='1'?'failed':'active'}});if(process.env.RELOAD_RETRY_HTTP==='1') status='500';if(process.env.RELOAD_RETRY_LOGICAL==='1') body='{"success":false}';}}
if(u.includes('/internal/test/fallback')) {if(a.includes('{"mode":"http_error"}')) {status='500';body='{"ok":false,"error":"simulated http error"}';}else body='{"ok":true,"note":"simulated cache miss (raw only)"}';}
if(process.env.MISSING_METRICS==='1'&&u.includes('metrics/prom')) body='cache_hits_total 10\\n';
if(process.env.CACHE_DISABLED==='1'&&u.includes('/internal/cache')) body='{"enabled":false}';
if(process.env.FAIL_PATH&&u.includes(process.env.FAIL_PATH)) {status='500';body='{"ok":false}';}
if(process.env.LOGICAL_PATH&&u.includes(process.env.LOGICAL_PATH)) {status='200';body='{"success":false}';}
if(process.env.HEALTH_FAILURE==='1'&&u.includes('metrics/prom')) process.exit(7);
const i=a.indexOf('-o');if(i>=0) fs.writeFileSync(a[i+1],body);else process.stdout.write(body);
if(a.includes('-w')) process.stdout.write(status);
`);
  const calls = path.join(dir, 'calls');
  await writeFile(calls, '');
  const artifact = path.join(dir, 'phase5.json');
  if (options.stale) await writeFile(artifact, '{"summary":{"overall_status":"pass"}}');
  if (options.dangling) await symlink(path.join(dir, 'missing-destination'), artifact);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, OWNED_PID: path.join(dir, 'owned.pid'), HELPER_PID: path.join(dir, 'helper.pid'),
    ARTIFACT_JSON: artifact, ARTIFACT_MD: path.join(dir, 'phase5.md'), SERVER_LOG: path.join(dir, 'server.log'),
    API_BASE: 'http://127.0.0.1:8900', METRICS_URL: 'http://127.0.0.1:8900/metrics/prom', TOKEN: 'test-token',
    HTTP_WARM_ITERS: '1', CACHE_WARM_COUNT: '1', RELOAD_COUNT: '1', SNAPSHOT_COUNT: '1', HEALTH_MAX_TRIES: '1', HEALTH_DELAY_SECS: '0', ...options.env };
  if (options.alias) env.ARTIFACT_MD = path.join(dir, '.', 'phase5.json');
  async function ownedPids() {
    const pids = [];
    for (const file of [env.OWNED_PID, env.HELPER_PID]) {
      try { pids.push(Number((await readFile(file, 'utf8')).trim())); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return pids;
  }
  function alive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  }
  try {
    const result = await new Promise(resolve => execFile('bash', ['scripts/phase5-ci-run.sh'], { cwd: dir, env, timeout: 10_000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, killed: error?.killed, signal: error?.signal, stdout, stderr })));
    assert(!result.killed, 'Harness timeout');
    assert(!result.signal, `Unexpected process termination: ${result.signal}`);
    assert(Number.isInteger(result.code), `Unexpected harness exit: ${result.code}`);
    return { ...result, calls: await readFile(calls, 'utf8'), ownedProcessesAlive: (await ownedPids()).map(alive) };
  } finally {
    // A failing regression must not itself leak its test-only launchers.
    for (const pid of await ownedPids()) {
      if (!alive(pid)) continue;
      process.kill(pid, 'SIGTERM');
      for (let i = 0; i < 20 && alive(pid); i++) await pause(25);
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test('validator failure remains nonzero and cannot print PASS', async () => {
  const result = await run({ env: { VALIDATE_EXIT: '7' } });
  assert.equal(result.code, 7);
  assert.doesNotMatch(result.stdout, /Completed with PASS/);
});

test('occupied local port is rejected without terminating an existing process', async () => {
  const result = await run({ env: { OCCUPIED: '1' } });
  assert.equal(result.code, 1);
  assert.match(result.calls, /port-check/);
  assert.doesNotMatch(result.calls, /\/plugins\/example-plugin\/reload|\/api\/snapshots/);
});

test('valid fresh artifacts pass and cleanup only the owned launcher', async () => {
  const result = await run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Completed with PASS/);
  assert.match(result.calls, /cleanup/);
  assert.match(result.calls, /listener-inspection/);
  const calls = result.calls.split('\n').filter(line => line.startsWith('[')).map(JSON.parse);
  assert(calls.find(call => call.includes('http://127.0.0.1:8900/api/cache-test/simulate')).includes('POST'));
  assert(calls.find(call => call.some(arg => arg.includes('/api/cache-test/warm?'))).includes('POST'));
  for (const call of calls) assert(call.includes('--max-time'));
  const reloads = calls.filter(call => call.includes('http://127.0.0.1:8900/api/admin/plugins/example-plugin/reload'));
  assert.equal(reloads.length, 2);
  assert(!reloads[0].some(arg => arg.startsWith('X-Safety-Token:')));
  assert(reloads[1].includes('X-Safety-Token: reload-token'));
  assert(reloads.every(call => call.includes('Authorization: Bearer test-token')));
  const confirm = calls.find(call => call.includes('http://127.0.0.1:8900/api/admin/safety/confirm'));
  assert.deepEqual(JSON.parse(confirm[confirm.indexOf('-d') + 1]), { token: 'reload-token', acknowledged: true });
  assert.doesNotMatch(result.calls, /reload-unsafe/);
});

for (const [name, env] of Object.entries({
  'fixture check': { FIXTURE_EXIT: '1' },
  health: { HEALTH_FAILURE: '1' },
  features: { CACHE_DISABLED: '1' },
  'cache population': { FAIL_PATH: '/api/cache-test/simulate' },
  'cache logical response': { LOGICAL_PATH: '/api/cache-test/warm' },
  'reload population': { FAIL_PATH: '/plugins/example-plugin/reload' },
  'reload challenge status': { LOGICAL_PATH: '/plugins/example-plugin/reload' },
  'reload retry HTTP': { RELOAD_RETRY_HTTP: '1' },
  'reload retry logical': { RELOAD_RETRY_LOGICAL: '1' },
  'reload inactive runtime': { RELOAD_INACTIVE: '1' },
  'reload wrong plugin': { RELOAD_WRONG_PLUGIN: '1' },
  'reload challenge code': { RELOAD_CHALLENGE_CODE: '1' },
  'reload challenge token': { RELOAD_CHALLENGE_TOKEN: '1' },
  'reload confirmation HTTP': { FAIL_PATH: '/api/admin/safety/confirm' },
  'reload confirmation logical': { LOGICAL_PATH: '/api/admin/safety/confirm' },
  fallback: { FAIL_PATH: '/internal/test/fallback' },
  snapshots: { SNAPSHOT_EXIT: '4' },
  metrics: { MISSING_METRICS: '1' },
  report: { REPORT_EXIT: '3' },
  'summary status': { VALIDATE_STATUS: 'fail' },
  'summary missing samples': { VALIDATE_NA: '1' },
  'summary fractional passes': { VALIDATE_PASSED: '0.5' },
  'remote endpoint': { API_BASE: 'https://external.invalid' },
  'mismatched metrics': { METRICS_URL: 'http://127.0.0.1:8901/metrics/prom' },
  'foreign listener': { FOREIGN_LISTENER: '1' },
})) {
  test(`${name} failure remains nonzero`, async () => {
    const result = await run({ env });
    assert.equal(result.code, name === 'report' ? 3 : name === 'snapshots' ? 4 : 1, result.stderr);
    assert.doesNotMatch(result.stdout, /Completed with PASS/);
    if (!['fixture check', 'remote endpoint', 'mismatched metrics'].includes(name)) assert.match(result.calls, /cleanup/);
    if (name === 'foreign listener') assert.doesNotMatch(result.calls, /simulate|warm\?|\/plugins\/example-plugin\/reload/);
  });
}

test('a stale passing artifact cannot satisfy a failed run', async () => {
  const result = await run({ stale: true });
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stdout, /Completed with PASS/);
  assert.doesNotMatch(result.calls, /port-check/);
});

test('optional generic warm route failures remain optional', async () => {
  const result = await run({ env: { FAIL_PATH: '/api/version' } });
  assert.equal(result.code, 0, result.stderr);
});

test('interrupt cleanup waits for owned fixture cleanup before stopping backend', async () => {
  const result = await run({ env: { SNAPSHOT_INTERRUPT: '1' } });
  assert.equal(result.code, 143, result.stderr);
  assert.doesNotMatch(result.stdout, /Completed with PASS/);
  assert.match(result.calls, /helper-cleanup/);
  assert(result.calls.indexOf('helper-cleanup') < result.calls.indexOf('\ncleanup'));
});

test('a second TERM during fixture cleanup still cleans both owned processes', async () => {
  const result = await run({ env: { SNAPSHOT_INTERRUPT: '1', SNAPSHOT_DOUBLE_SIGNAL: '1' } });
  assert.equal(result.code, 143, result.stderr);
  assert.doesNotMatch(result.stdout, /Completed with PASS/);
  assert.match(result.calls, /helper-cleanup-start/);
  assert.match(result.calls, /helper-cleanup/);
  assert(result.calls.indexOf('\nhelper-cleanup\n') < result.calls.indexOf('\ncleanup'));
  assert.deepEqual(result.ownedProcessesAlive, [false, false]);
});

test('fixture cleanup timeout fails without a PASS message', async () => {
  const result = await run({ cleanupTimeout: true, env: { SNAPSHOT_INTERRUPT: '1', IGNORE_TERM: '1' } });
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /Fixture cleanup timeout/);
  assert.doesNotMatch(result.stdout, /Completed with PASS/);
  assert.match(result.calls, /cleanup/);
});

for (const option of ['alias', 'dangling']) {
  test(`${option} artifact destination is rejected before startup`, async () => {
    const result = await run({ [option]: true });
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stdout, /Completed with PASS/);
    assert.doesNotMatch(result.calls, /port-check/);
  });
}

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const require = createRequire(new URL('../../packages/core-backend/package.json', import.meta.url));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
class FixtureError extends Error {}
let interrupted = 0;
let cleaning = false;
let activeRequest;
for (const [signal, status] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, () => { interrupted = status; process.exitCode = status; activeRequest?.abort(); });
}
function ensure(condition, code) {
  if (interrupted && !cleaning) throw new FixtureError('INTERRUPTED');
  if (!condition) throw new FixtureError(code);
}

// No caller-supplied fixture ids, database bootstrap, or admin provisioning.
// Dedicated database provenance still needs qualification by its test harness.
async function main() {
  ensure(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--check'), 'INVALID_ARGUMENTS');
  const api = process.env.API_BASE || 'http://127.0.0.1:8900';
  ensure(api === 'http://127.0.0.1:8900', 'LOCAL_ENDPOINT_REQUIRED');
  const database = new URL(process.env.DATABASE_URL || '');
  const databaseName = database.pathname.slice(1);
  ensure(['postgres:', 'postgresql:'].includes(database.protocol)
    && ['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname)
    && !database.search && uuid.test(databaseName.replace(/^phase5_test_/, ''))
    && databaseName.startsWith('phase5_test_'), 'DEDICATED_DATABASE_REQUIRED');
  const token = process.env.TOKEN;
  ensure(typeof token === 'string' && token.length > 0, 'TEST_ADMIN_TOKEN_REQUIRED');
  const claims = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString());
  const identityClaim = claims.userId || claims.id || claims.sub;
  const actor = typeof identityClaim === 'string' ? identityClaim.trim() : '';
  ensure(actor.length > 0, 'TEST_ADMIN_ID_REQUIRED');
  const count = Number(process.env.SNAPSHOT_COUNT || 6);
  ensure(Number.isSafeInteger(count) && count > 0 && count <= 100, 'INVALID_SNAPSHOT_COUNT');
  const { Client } = require('pg');
  const db = new Client({ connectionString: database.href, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  await db.connect();
  let owned = false;
  const viewId = randomUUID();
  const runId = randomUUID();
  const name = `phase5-fixture-${runId}`;
  const config = { phase5_run: runId };

  async function rows(sql, parameters = []) { return (await db.query(sql, parameters)).rows; }
  async function verifyView(lock = false) {
    const result = await rows(`SELECT id, table_id, type, name, config FROM views WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [viewId]);
    const view = result[0];
    ensure(result.length === 1 && view.id === viewId && view.table_id === null
      && view.type === 'grid' && view.name === name && view.config?.phase5_run === runId, 'FIXTURE_OWNERSHIP_MISMATCH');
  }
  async function request(method, route, body, safetyToken) {
    ensure(true, 'INTERRUPTED');
    const args = ['-sS', '--connect-timeout', '3', '--max-time', '15', '-X', method,
      '-H', `Authorization: Bearer ${token}`, '-H', 'Content-Type: application/json'];
    if (body !== undefined) args.push('--data', JSON.stringify(body));
    if (safetyToken) args.push('-H', `X-Safety-Token: ${safetyToken}`);
    args.push('-w', '\n%{http_code}', `${api}${route}`);
    // Do not log stdout, stderr, tokens, ids, database URLs, or API error bodies.
    activeRequest = new AbortController();
    let stdout;
    try {
      ({ stdout } = await execute('curl', args, { timeout: 18000, maxBuffer: 1024 * 1024, signal: activeRequest.signal }));
    } finally { activeRequest = undefined; }
    ensure(true, 'INTERRUPTED');
    const separator = stdout.lastIndexOf('\n');
    return { status: Number(stdout.slice(separator + 1)), body: JSON.parse(stdout.slice(0, separator)) };
  }
  try {
    const identity = await rows('SELECT current_database() AS name');
    ensure(identity[0]?.name === databaseName, 'DATABASE_IDENTITY_MISMATCH');
    const admins = await rows("SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id WHERE u.id = $1 AND u.is_active = true AND ur.role_id = 'admin'", [actor]);
    ensure(admins.length === 1 && String(admins[0].id) === actor, 'TEST_ADMIN_NOT_FOUND');
    const existing = await rows('SELECT (SELECT count(*) FROM views) AS views, (SELECT count(*) FROM snapshots) AS snapshots');
    ensure(Number(existing[0]?.views) === 0 && Number(existing[0]?.snapshots) === 0, 'DATABASE_NOT_EMPTY');
    if (process.argv[2] === '--check') return;
    const inserted = await db.query('INSERT INTO views (id, table_id, type, name, config) VALUES ($1, NULL, $2, $3, $4::jsonb)', [viewId, 'grid', name, JSON.stringify(config)]);
    owned = inserted.rowCount === 1;
    ensure(inserted.rowCount === 1, 'FIXTURE_CREATE_FAILED');
    await verifyView();
    // Establish API -> owned database linkage before the first HTTP mutation.
    const linked = await request('GET', `/api/views/${viewId}/config`);
    ensure(linked.status === 200 && linked.body.success === true
      && linked.body.data?.id === viewId && linked.body.data.table_id === null
      && linked.body.data.type === 'grid' && linked.body.data.name === name
      && linked.body.data.phase5_run === runId, 'API_DATABASE_LINK_MISMATCH');
    for (let i = 0; i < count; i++) {
      await verifyView();
      const created = await request('POST', '/api/snapshots', {
        view_id: viewId, name, description: 'synthetic Phase5 fixture', snapshot_type: 'manual', metadata: config,
      });
      ensure(created.status === 201 && created.body.ok === true
        && typeof created.body.data?.id === 'string' && uuid.test(created.body.data.id), 'SNAPSHOT_CREATE_FAILED');
      const snapshotId = created.body.data.id;
      const snapshots = await rows('SELECT id, view_id, name, created_by, metadata FROM snapshots WHERE id = $1', [snapshotId]);
      const snapshot = snapshots[0];
      ensure(snapshots.length === 1 && snapshot.id === snapshotId && snapshot.view_id === viewId
        && snapshot.name === name && String(snapshot.created_by) === actor
        && snapshot.metadata?.phase5_run === runId, 'SNAPSHOT_OWNERSHIP_MISMATCH');
      const items = await rows('SELECT item_type, item_id, data FROM snapshot_items WHERE snapshot_id = $1', [snapshotId]);
      const item = items[0];
      const data = typeof item?.data === 'string' ? JSON.parse(item.data) : item?.data;
      ensure(items.length === 1 && item.item_type === 'view' && item.item_id === viewId
        && data?.id === viewId && data.table_id === null && data.type === 'grid'
        && data.name === name && data.config?.phase5_run === runId, 'SNAPSHOT_ITEMS_MISMATCH');
      const restoreBody = { restore_type: 'partial', item_types: ['view'] };
      await verifyView();
      const challenge = await request('POST', `/api/snapshots/${snapshotId}/restore`, restoreBody);
      ensure(challenge.status === 403 && challenge.body.code === 'SAFETY_CHECK_REQUIRED'
        && typeof challenge.body.confirmation?.token === 'string' && challenge.body.confirmation.token.length > 0, 'SAFETY_CHALLENGE_REQUIRED');
      const safetyToken = challenge.body.confirmation.token;
      const confirmed = await request('POST', '/api/admin/safety/confirm', {
        token: safetyToken, typedConfirmation: 'restore_snapshot', acknowledged: true,
      });
      ensure(confirmed.status === 200 && confirmed.body.success === true, 'SAFETY_CONFIRM_FAILED');
      await verifyView();
      const restored = await request('POST', `/api/snapshots/${snapshotId}/restore`, restoreBody, safetyToken);
      ensure(restored.status === 200 && restored.body.ok === true && restored.body.data?.success === true
        && restored.body.data.itemsRestored === 1, 'SNAPSHOT_RESTORE_FAILED');
      await verifyView();
    }
    console.log('[snapshot] Owned create/restore samples completed');
  } finally {
    cleaning = true;
    try {
      if (owned) {
        // Fixture teardown only: no force/cascade, and never use unverified API ids.
        await db.query('BEGIN');
        await verifyView(true);
        const ownedSnapshots = await rows('SELECT id FROM snapshots WHERE view_id = $1 AND name = $2 AND metadata->>\'phase5_run\' = $3 AND created_by::text = $4 FOR UPDATE', [viewId, name, runId, actor]);
        for (const snapshot of ownedSnapshots) {
          await db.query('DELETE FROM snapshot_items WHERE snapshot_id = $1', [snapshot.id]);
          const removed = await db.query('DELETE FROM snapshots WHERE id = $1 AND view_id = $2 AND name = $3', [snapshot.id, viewId, name]);
          ensure(removed.rowCount === 1, 'SNAPSHOT_CLEANUP_FAILED');
        }
        const removed = await db.query('DELETE FROM views WHERE id = $1 AND name = $2 AND config->>\'phase5_run\' = $3', [viewId, name, runId]);
        ensure(removed.rowCount === 1, 'FIXTURE_CLEANUP_FAILED');
        await db.query('COMMIT');
      }
    } catch {
      await db.query('ROLLBACK').catch(() => {});
      throw new FixtureError('FIXTURE_CLEANUP_FAILED');
    } finally { await db.end(); }
  }
}

main().catch(error => {
  const code = error instanceof FixtureError ? error.message : 'FIXTURE_OPERATION_FAILED';
  console.error(`[snapshot] ${code}`);
  process.exitCode = interrupted || 1;
});

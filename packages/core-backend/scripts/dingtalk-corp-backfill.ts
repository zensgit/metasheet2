import { readFile } from 'node:fs/promises'
import { Client, type PoolClient } from 'pg'
import { readStrictLoginInstallation } from '../src/auth/strict-login-grant-store'

/** Externally reviewed operation inputs. An input file does not authorize an operation. */
interface ReviewedRow {
  identityId: string
  userId: string
  rowVersion: string
  oldKey: string
  connectionId: string
  accountId: string
}
export interface ReviewedBackfill {
  systemIdentifier: string
  database: string
  schema: string
  operator: string
  corpId: string
  rows: ReviewedRow[]
}

function requireState(value: unknown): asserts value {
  if (!value) throw new Error('DINGTALK_CORP_BACKFILL_REFUSED')
}

function nonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function uuid(value: unknown): boolean {
  return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
}

/** Validate both lists before opening a database connection. */
export function checkPlan(plan: ReviewedBackfill, allowlist: string[], targetCorp: string): void {
  requireState(plan && nonblank(targetCorp) && plan.corpId === targetCorp && nonblank(plan.systemIdentifier)
    && nonblank(plan.database) && nonblank(plan.schema) && nonblank(plan.operator))
  requireState(Array.isArray(plan.rows) && plan.rows.length > 0 && plan.rows.length === allowlist.length)
  const approved = new Set(allowlist)
  requireState(approved.size === allowlist.length)
  for (const row of plan.rows) {
    requireState(row && uuid(row.identityId) && uuid(row.accountId) && uuid(row.connectionId)
      && nonblank(row.userId) && typeof row.oldKey === 'string'
      && typeof row.rowVersion === 'string' && /^\d+$/.test(row.rowVersion) && approved.delete(row.identityId))
  }
  requireState(approved.size === 0)
}

const REVIEWED = `jsonb_to_recordset($1::jsonb) AS p("identityId" uuid, "userId" text, "rowVersion" text,
    "oldKey" text, "connectionId" uuid, "accountId" uuid)`

/** The caller supplies a dedicated connection. Only the reviewed, still-current rows may be changed. */
export async function applyReviewedBackfill(
  client: Client | PoolClient, plan: ReviewedBackfill, allowlist: string[], corp: string,
): Promise<number> {
  checkPlan(plan, allowlist, corp)
  const users = Array.from(new Set(plan.rows.map(row => row.userId))).sort()
  const ids = plan.rows.map(row => row.identityId).sort()
  const inputs = [JSON.stringify(plan.rows), corp]
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
  try {
    await client.query("SET LOCAL lock_timeout = '5s'")
    await client.query("SET LOCAL statement_timeout = '30s'")
    const environment = await client.query(
      `SELECT c.system_identifier::text = $1 AND pg_catalog.current_database() = $2
        AND current_schema() = $3 AND session_user = $4 AS matches
       FROM pg_catalog.pg_control_system() c`, [plan.systemIdentifier, plan.database, plan.schema, plan.operator],
    )
    requireState(environment.rows[0]?.matches === true)
    await client.query("SELECT pg_catalog.set_config('search_path', pg_catalog.format('%I, pg_catalog', $1::text), true)", [plan.schema])
    await client.query("SELECT pg_advisory_xact_lock(hashtext('directory:identity-maintenance'))")
    const lockedUsers = await client.query('SELECT id FROM users WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', [users])
    requireState(lockedUsers.rowCount === users.length)
    // Fence additions as well as changes to the rows used as independent attribution evidence.
    await client.query('LOCK TABLE directory_integrations, directory_accounts, directory_account_links IN SHARE MODE NOWAIT')
    await client.query('LOCK TABLE user_external_identities IN SHARE ROW EXCLUSIVE MODE NOWAIT')
    const lockedIdentities = await client.query(
      'SELECT id FROM user_external_identities WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids],
    )
    requireState(lockedIdentities.rowCount === ids.length)

    // This is the last membership barrier: a first scope INSERT must take ROW EXCLUSIVE.
    await client.query('LOCK TABLE directory_connection_login_scope IN SHARE MODE NOWAIT')
    requireState((await readStrictLoginInstallation(client)).installation === 'installed')
    const scopes = await client.query('SELECT 1 FROM directory_connection_login_scope LIMIT 1')
    requireState(scopes.rowCount === 0)

    const blockers = await client.query(
      `SELECT 1 FROM user_external_identities old
        WHERE old.provider='dingtalk' AND old.corp_id IS NULL AND (
          old.provider_open_id IS NULL OR EXISTS (
            SELECT 1 FROM user_external_identities other WHERE other.id<>old.id
              AND other.provider='dingtalk' AND other.external_key=$1 || ':' || old.provider_open_id))
        LIMIT 1`, [corp],
    )
    requireState(blockers.rowCount === 0)
    const eligible = await client.query(
      `SELECT u.id FROM ${REVIEWED}
       JOIN user_external_identities u ON u.id=p."identityId" AND u.local_user_id=p."userId"
       WHERE u.provider='dingtalk' AND u.corp_id IS NULL AND u.provider_open_id IS NOT NULL
         AND u.xmin::text=p."rowVersion" AND u.external_key=p."oldKey"
         AND (SELECT count(*)=1 AND bool_and(a.id=p."accountId" AND i.id=p."connectionId"
                AND l.local_user_id=u.local_user_id AND a.corp_id=$2 AND i.corp_id=$2
                AND (u.provider_union_id IS NULL OR a.union_id=u.provider_union_id))
              FROM directory_accounts a
              JOIN directory_integrations i ON i.id=a.integration_id
              JOIN directory_account_links l ON l.directory_account_id=a.id
              WHERE a.provider='dingtalk' AND i.provider='dingtalk' AND i.status='active'
                AND a.is_active AND l.link_status='linked' AND a.open_id=u.provider_open_id
                AND (l.local_user_id=u.local_user_id OR a.corp_id=$2))`, inputs,
    )
    requireState(eligible.rowCount === ids.length)
    const written = await client.query(
      `UPDATE user_external_identities SET corp_id=$1, external_key=$1 || ':' || provider_open_id,
         updated_at=now() WHERE id=ANY($2::uuid[])`, [corp, ids],
    )
    requireState(written.rowCount === ids.length)
    const audit = await client.query(
      `INSERT INTO audit_logs (event_type,event_category,resource_type,action,action_details)
       VALUES ('DINGTALK_CORP_BACKFILL','SECURITY','user_external_identities','apply',jsonb_build_object('count',$1::integer))`,
      [ids.length],
    )
    requireState(audit.rowCount === 1)
    await client.query('COMMIT')
    return ids.length
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

async function main(): Promise<void> {
  const [corp, allowlistPath, planPath] = process.argv.slice(2)
  requireState(nonblank(corp) && nonblank(allowlistPath) && nonblank(planPath) && nonblank(process.env.DATABASE_URL))
  const allowlist = (await readFile(allowlistPath, 'utf8')).split(/\r?\n/)
    .map(line => line.replace(/#.*$/, '').trim()).filter(Boolean)
  const plan = JSON.parse(await readFile(planPath, 'utf8')) as ReviewedBackfill
  checkPlan(plan, allowlist, corp)
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    const count = await applyReviewedBackfill(client, plan, allowlist, corp)
    process.stdout.write(`updated_rows=${count}\n`)
  } finally {
    await client.end()
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  main().catch(() => {
    process.stderr.write('DINGTALK_CORP_BACKFILL_REFUSED\n')
    process.exitCode = 1
  })
}

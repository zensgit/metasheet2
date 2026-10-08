import { afterAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import crypto from 'node:crypto'
import { query } from '../../src/db/pg'
import { up as backfillUp } from '../../src/db/migrations/zzzz20260721150000_backfill_user_orgs_from_directory_links'

/**
 * W4-PRE-1b item C (F7) — real-stock backfill migration
 * (`zzzz20260721150000_backfill_user_orgs_from_directory_links`).
 *
 * Runs the migration's `up()` DIRECTLY (not through the tracked migration runner — it already
 * ran once against this shared test DB when the suite's schema was provisioned) against the
 * SAME shared public-schema tables the rest of this line's fixtures use, via a Kysely instance
 * wrapping a plain pg Pool (no search_path override — the migration's own SQL is unqualified,
 * same as production). Namespaced fixture rows only, `w4pre1b_` prefix per this line's shared-DB
 * discipline.
 *
 * Proves:
 *  - a linked-but-membership-less user (the exact pre-fix stock the owner named) gets an ACTIVE
 *    row after the migration runs;
 *  - a row already `is_active=false` (deactivated by item B's own logic, or by any other prior
 *    writer) is NEVER resurrected — `ON CONFLICT (user_id, org_id) DO NOTHING` only inserts
 *    where no row exists at all;
 *  - re-running `up()` a second time (idempotency) changes nothing further.
 */
const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const TS = Date.now()
const RUN = crypto.randomBytes(4).toString('hex')
const NS = `w4pre1bbackfill${TS}${RUN}`

describeIfDatabase('W4-PRE-1b item C — backfill migration (real DB, shared public schema)', () => {
  const integrationIds: string[] = []
  const userIds: string[] = []
  let pool: Pool | undefined
  let db: Kysely<unknown> | undefined

  afterAll(async () => {
    await db?.destroy()
    if (userIds.length) {
      await query(`DELETE FROM directory_account_links WHERE local_user_id = ANY($1::text[])`, [userIds])
      await query(`DELETE FROM user_orgs WHERE user_id = ANY($1::text[])`, [userIds])
      await query(`DELETE FROM users WHERE id = ANY($1::text[])`, [userIds])
    }
    if (integrationIds.length) {
      await query(`DELETE FROM directory_accounts WHERE integration_id = ANY($1::uuid[])`, [integrationIds])
      await query(`DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])`, [integrationIds])
    }
  })

  async function seedUser(tag: string): Promise<string> {
    const id = `${NS}-u-${tag}`
    await query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $3, 'Fixture', 'x', 'user', '[]'::jsonb, true, false, NOW(), NOW())`,
      [id, `${id}@example.test`, id],
    )
    userIds.push(id)
    return id
  }

  async function seedIntegration(org: string, tag: string): Promise<string> {
    const id = (
      await query<{ id: string }>(
        `INSERT INTO directory_integrations (org_id, name, corp_id, provider, status)
         VALUES ($1, $2, $3, 'dingtalk', 'active') RETURNING id::text AS id`,
        [org, `${NS}-int-${tag}`, `${NS}-corp-${tag}`],
      )
    ).rows[0].id
    integrationIds.push(id)
    return id
  }

  async function seedLinkedAccount(integrationId: string, userId: string, tag: string, isActive = true): Promise<string> {
    const external = `${NS}-ext-${tag}`
    const accountId = (
      await query<{ id: string }>(
        `INSERT INTO directory_accounts (integration_id, provider, corp_id, external_user_id, union_id, open_id, external_key, name, is_active)
         VALUES ($1, 'dingtalk', 'corp', $2, $3, $4, $5, 'Fixture', $6) RETURNING id::text AS id`,
        [integrationId, external, `${NS}-union-${tag}`, `${NS}-open-${tag}`, external, isActive],
      )
    ).rows[0].id
    await query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy, created_at, updated_at)
       VALUES ($1, $2, 'linked', 'manual', NOW(), NOW())`,
      [accountId, userId],
    )
    return accountId
  }

  it('inserts membership for a linked user with no row; never resurrects an already-deactivated row; idempotent on rerun', async () => {
    pool = new Pool({ connectionString: dbUrl })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })

    const org = `${NS}_org`
    const integrationId = await seedIntegration(org, 'main')

    // (1) linked, no user_orgs row at all — the population this migration targets.
    const missingUser = await seedUser('missing')
    await seedLinkedAccount(integrationId, missingUser, 'missing')

    // (2) linked, but ALREADY deactivated — must NOT be resurrected.
    const deactivatedUser = await seedUser('deactivated')
    await seedLinkedAccount(integrationId, deactivatedUser, 'deactivated')
    await query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, false)`, [deactivatedUser, org])

    // (3) linked, already active — control: stays active, no duplicate/error.
    const activeUser = await seedUser('active')
    await seedLinkedAccount(integrationId, activeUser, 'active')
    await query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`, [activeUser, org])

    // (4) an INACTIVE directory account (a.is_active=false) that is still `link_status='linked'`
    // — the migration's `a.is_active=true` predicate must exclude it, exactly like the S7-5
    // readiness read and every bind-shaped writer in this line.
    const inactiveAccountUser = await seedUser('inactiveaccount')
    await seedLinkedAccount(integrationId, inactiveAccountUser, 'inactiveaccount', false)

    await backfillUp(db)

    const rows = await query<{ user_id: string; is_active: boolean }>(
      `SELECT user_id, is_active FROM user_orgs WHERE user_id = ANY($1::text[]) ORDER BY user_id`,
      [[missingUser, deactivatedUser, activeUser, inactiveAccountUser]],
    )
    const byUser = new Map(rows.rows.map((r) => [r.user_id, r.is_active]))
    expect(byUser.get(missingUser)).toBe(true)
    expect(byUser.get(deactivatedUser)).toBe(false)
    expect(byUser.get(activeUser)).toBe(true)
    expect(byUser.has(inactiveAccountUser)).toBe(false)

    // Idempotency: rerun changes nothing.
    await backfillUp(db)
    const rowsAfterRerun = await query<{ user_id: string; is_active: boolean }>(
      `SELECT user_id, is_active FROM user_orgs WHERE user_id = ANY($1::text[]) ORDER BY user_id`,
      [[missingUser, deactivatedUser, activeUser, inactiveAccountUser]],
    )
    expect(rowsAfterRerun.rows).toEqual(rows.rows)
  })
})

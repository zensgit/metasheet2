import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

const provider = vi.hoisted(() => ({
  token: vi.fn(),
  exchange: vi.fn(),
  user: vi.fn(),
  config: vi.fn(),
}))
vi.mock('../../src/integrations/dingtalk/client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  fetchDingTalkAppAccessToken: provider.token,
  exchangeCodeForUserAccessToken: provider.exchange,
  fetchDingTalkCurrentUser: provider.user,
  readDingTalkOauthConfig: provider.config,
  isDingTalkConfigured: () => true,
}))
import { exchangeCodeForUser } from '../../src/auth/dingtalk-oauth'
import { pool, query } from '../../src/db/pg'
import {
  applyDirectoryHandover,
  finishDirectoryHandover,
  previewDirectoryHandover,
} from '../../src/directory/controlled-handover'
import { syncDirectoryIntegration } from '../../src/directory/directory-sync'
import { listUserPermissions } from '../../src/rbac/service'
import { approvalPendingSource } from '../../src/services/approval-pending-source'
import { insertDingTalkApprovalCardDelivery } from '../../src/integrations/dingtalk/approval-card-deliveries'

const db = process.env.DATABASE_URL ? describe : describe.skip
if (process.env.EXPECT_DB === '1')
  it('DB lane must not skip', () =>
    expect(process.env.DATABASE_URL).toBeTruthy())
const q = (sql: string, args?: unknown[]) => query(sql, args)

async function fixture() {
  const tag = `handover_${randomUUID()}`
  const admin = `${tag}_admin`,
    users = [`${tag}_a`, `${tag}_b`]
  const source = randomUUID(),
    target = randomUUID(),
    corp = `corp_${tag}`
  for (const id of [admin, ...users])
    await q(
      `INSERT INTO users(id,username,name,password_hash,is_active,is_admin) VALUES($1,$1,$1,'synthetic-only',true,$2)`,
      [id, id === admin],
    )
  for (const [id, app] of [
    [source, 'old'],
    [target, 'new'],
  ]) {
    const config = {
      appKey: app,
      appSecret: 'synthetic-credential',
      approvalCardLinkSecret: 'synthetic-hmac',
      identityVerification: {
        source: 'admin_console',
        corpId: corp,
        appKey: app,
        appCorpId: corp,
        checkedBy: admin,
        checkedAt: '2026-11-01T00:00:00Z',
      },
    }
    await q(
      `INSERT INTO directory_integrations(id,org_id,provider,name,corp_id,config,sync_enabled) VALUES($1::uuid,'default','dingtalk',$1::text,$2,$3,false)`,
      [id, corp, config],
    )
  }
  const departments = [randomUUID(), randomUUID()]
  await q(
    `INSERT INTO directory_departments(id,integration_id,external_department_id,name,full_path) VALUES($1,$2,'1','Root','Root')`,
    [departments[0], source],
  )
  await q(
    `INSERT INTO directory_departments(id,integration_id,external_department_id,external_parent_department_id,name,full_path) VALUES($1,$2,'2','1','Team','Root/Team')`,
    [departments[1], source],
  )
  // Non-empty target: same stable root + an unrelated department/account must survive.
  await q(
    `INSERT INTO directory_departments(integration_id,external_department_id,name,full_path) VALUES($1,'1','Root','Root'),($1,'9','Other','Other')`,
    [target],
  )
  const accounts = [randomUUID(), randomUUID()]
  for (let i = 0; i < 2; i++) {
    await q(
      `INSERT INTO directory_accounts(id,integration_id,corp_id,external_user_id,union_id,open_id,external_key,name) VALUES($1,$2,$3,$4,$5,$6,$5,$4)`,
      [
        accounts[i],
        source,
        corp,
        `${tag}_employee_${i}`,
        `${tag}_union_${i}`,
        `${tag}_open_${i}`,
      ],
    )
    await q(
      `INSERT INTO directory_account_links(directory_account_id,local_user_id,link_status,match_strategy) VALUES($1,$2,'linked','manual_admin')`,
      [accounts[i], users[i]],
    )
    await q(
      `INSERT INTO user_orgs(user_id,org_id,is_active) VALUES($1,'default',true) ON CONFLICT(user_id,org_id) DO UPDATE SET is_active=true`,
      [users[i]],
    )
    await q(
      `INSERT INTO user_external_identities(provider,external_key,local_user_id,corp_id,provider_union_id,provider_open_id,bound_by) VALUES('dingtalk',$1,$2,$3,$4,$5,$2)`,
      [
        `${corp}:${tag}_open_${i}`,
        users[i],
        corp,
        `${tag}_union_${i}`,
        `${tag}_open_${i}`,
      ],
    )
    await q(
      `INSERT INTO user_external_auth_grants(provider,local_user_id,enabled) VALUES('dingtalk',$1,true)`,
      [users[i]],
    )
    for (let j = 0; j < (i === 0 ? 2 : 1); j++) {
      const role = `${tag}_role_${i}_${j}`
      await q('INSERT INTO roles(id,name) VALUES($1,$1)', [role])
      await q('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)', [
        users[i],
        role,
      ])
      for (const code of ['approvals:read', 'approvals:act']) {
        await q(
          'INSERT INTO permissions(code,name) VALUES($1,$1) ON CONFLICT DO NOTHING',
          [code],
        )
        await q(
          'INSERT INTO role_permissions(role_id,permission_code) VALUES($1,$2)',
          [role, code],
        )
      }
    }
    await q(
      `INSERT INTO directory_account_departments(directory_account_id,directory_department_id,is_primary,is_manager) VALUES($1,$2,true,$3)`,
      [accounts[i], departments[1], i === 0],
    )
    for (let j = 0; j < (i === 0 ? 5 : 4); j++) {
      const id = `${tag}_approval_${i}_${j}`
      await q(
        `INSERT INTO approval_instances(id,status,current_node_key,title,org_id) VALUES($1,'pending','approve',$1,'default')`,
        [id],
      )
      await q(
        `INSERT INTO approval_assignments(instance_id,assignment_type,assignee_id,node_key,entry_epoch,is_active) VALUES($1,'user',$2,'approve',1,true)`,
        [id, users[i]],
      )
    }
  }
  const unrelated = randomUUID()
  await q(
    `INSERT INTO directory_accounts(id,integration_id,corp_id,external_user_id,external_key,name) VALUES($1,$2,$3,$4,$4,'Other user')`,
    [unrelated, target, corp, `${tag}_other`],
  )
  const pair = { sourceIntegrationId: source, targetIntegrationId: target }
  async function stable() {
    const result: Record<string, unknown> = {}
    for (const [table, key] of [
      ['users', 'id'],
      ['user_roles', 'user_id'],
      ['user_external_identities', 'local_user_id'],
      ['user_external_auth_grants', 'local_user_id'],
      ['user_orgs', 'user_id'],
    ] as const) {
      result[table] = (
        await q(
          `SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${key}=ANY($1::text[]) ORDER BY to_jsonb(t)::text`,
          [users],
        )
      ).rows
    }
    result.approvals = (
      await q(
        'SELECT to_jsonb(t) AS row FROM approval_instances t WHERE id LIKE $1 ORDER BY id',
        [tag + '%'],
      )
    ).rows
    result.assignments = (
      await q(
        'SELECT to_jsonb(t) AS row FROM approval_assignments t WHERE instance_id LIKE $1 ORDER BY id',
        [tag + '%'],
      )
    ).rows
    result.todo = []
    for (const user of users) {
      const permissions = await listUserPermissions(user, q)
      const roles = (
        await q('SELECT role_id FROM user_roles WHERE user_id=$1', [user])
      ).rows.map((r) => r.role_id)
      const items = await approvalPendingSource.listPendingForUser({
        actorId: user,
        roles,
        permissions,
      })
      ;(result.todo as unknown[]).push({
        permissions: permissions.sort(),
        items: items
          .map((i) => ({ id: i.id, actionable: i.actionable }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      })
    }
    return result
  }
  return {
    tag,
    admin,
    users,
    source,
    target,
    corp,
    departments,
    accounts,
    unrelated,
    pair,
    stable,
  }
}

db(
  'controlled same-enterprise handover (real database, synthetic users)',
  () => {
    it('atomically moves original accounts, preserves 2 users/roles/identities/9 actionable todos, restores exact membership on rollback', async () => {
      const f = await fixture(),
        before = await f.stable()
      expect(
        (before.todo as { items: unknown[] }[]).map((t) => t.items.length),
      ).toEqual([5, 4])
      const preview = await previewDirectoryHandover(f.pair, f.admin)
      expect(preview).toMatchObject({ accounts: 2, linkedUsers: 2 })
      const moved = await applyDirectoryHandover(
        f.pair,
        preview.digest,
        f.admin,
      )
      expect(await f.stable()).toEqual(before)
      expect(
        (
          await q(
            'SELECT id,integration_id FROM directory_accounts WHERE id=ANY($1::uuid[]) ORDER BY id',
            [f.accounts],
          )
        ).rows.every((r) => r.integration_id === f.target),
      ).toBe(true)
      expect(
        (
          await q('SELECT integration_id FROM directory_accounts WHERE id=$1', [
            f.unrelated,
          ])
        ).rows[0].integration_id,
      ).toBe(f.target)
      const journal = (
        await q('SELECT before_state FROM directory_handovers WHERE id=$1', [
          moved.id,
        ])
      ).rows[0].before_state
      expect(JSON.stringify(journal)).not.toContain('synthetic-credential')
      expect(JSON.stringify(journal)).not.toContain('synthetic-hmac')
      expect(JSON.stringify(journal)).not.toContain('password_hash')
      await finishDirectoryHandover(moved.id, moved.digest, f.admin, 'rollback')
      expect(await f.stable()).toEqual(before)
      expect(
        (
          await q(
            'SELECT integration_id FROM directory_accounts WHERE id=ANY($1::uuid[])',
            [f.accounts],
          )
        ).rows.every((r) => r.integration_id === f.source),
      ).toBe(true)
    })

    it('both sync directions are frozen after apply; finalize releases only target without enabling it', async () => {
      const f = await fixture(),
        p = await previewDirectoryHandover(f.pair, f.admin),
        m = await applyDirectoryHandover(f.pair, p.digest, f.admin)
      provider.token.mockClear()
      for (const id of [f.source, f.target])
        await expect(syncDirectoryIntegration(id)).rejects.toMatchObject({
          code: 'DIRECTORY_SYNC_FROZEN_BY_TRANSFER',
        })
      expect(provider.token).not.toHaveBeenCalled()
      await finishDirectoryHandover(m.id, m.digest, f.admin, 'finalize')
      await expect(syncDirectoryIntegration(f.source)).rejects.toMatchObject({
        code: 'DIRECTORY_SYNC_FROZEN_BY_TRANSFER',
      })
      expect(
        (
          await q(
            'SELECT sync_enabled FROM directory_integrations WHERE id=ANY($1::uuid[])',
            [[f.source, f.target]],
          )
        ).rows.every((r) => r.sync_enabled === false),
      ).toBe(true)
      await expect(
        finishDirectoryHandover(m.id, m.digest, f.admin, 'rollback'),
      ).rejects.toThrow('not awaiting verification')
    })

    it('new source/target card insertion is blocked during verification and source remains blocked after finalize', async () => {
      const f = await fixture(),
        p = await previewDirectoryHandover(f.pair, f.admin),
        m = await applyDirectoryHandover(f.pair, p.digest, f.admin)
      const card = (integrationId: string) =>
        insertDingTalkApprovalCardDelivery(q, {
          integrationId,
          instanceId: f.tag + '_approval_0_0',
          nodeKey: 'approve',
          entryEpoch: 1,
          recipientUserId: f.users[0],
          recipientDingTalkUserId: 'synthetic',
          deliveryKind: 'work_notice_action_card',
        })
      await expect(card(f.source)).rejects.toThrow('handover blocks')
      await expect(card(f.target)).rejects.toThrow('handover blocks')
      await finishDirectoryHandover(m.id, m.digest, f.admin, 'finalize')
      await expect(card(f.source)).rejects.toThrow('handover blocks')
      expect((await card(f.target)).id).toBeTruthy()
    })

    it('rejects non-admin preview and apply without changing accounts', async () => {
      const f = await fixture()
      await expect(
        previewDirectoryHandover(f.pair, f.users[0]),
      ).rejects.toThrow('administrator')
      await expect(
        applyDirectoryHandover(f.pair, 'bad', f.users[0]),
      ).rejects.toThrow('administrator')
    })

    it.each(['corp', 'org', 'proof', 'sync', 'running', 'governance', 'card'])(
      'fails closed for %s preflight',
      async (kind) => {
        const f = await fixture(),
          before = await f.stable()
        if (kind === 'corp')
          await q('UPDATE directory_integrations SET corp_id=$2 WHERE id=$1', [
            f.target,
            'different',
          ])
        if (kind === 'org')
          await q('UPDATE directory_integrations SET org_id=$2 WHERE id=$1', [
            f.target,
            'other',
          ])
        if (kind === 'proof')
          await q(
            "UPDATE directory_integrations SET config=config-'identityVerification' WHERE id=$1",
            [f.target],
          )
        if (kind === 'sync')
          await q(
            'UPDATE directory_integrations SET sync_enabled=true WHERE id=$1',
            [f.target],
          )
        if (kind === 'running')
          await q(
            "INSERT INTO directory_sync_runs(integration_id,triggered_by,status) VALUES($1,'manual','running')",
            [f.target],
          )
        if (kind === 'governance')
          await q(
            `UPDATE directory_integrations SET config=config||'{"memberGroupSyncMode":"sync_scoped_departments"}' WHERE id=$1`,
            [f.target],
          )
        if (kind === 'card')
          await insertDingTalkApprovalCardDelivery(q, {
            integrationId: f.source,
            instanceId: f.tag + '_approval_0_0',
            nodeKey: 'approve',
            entryEpoch: 1,
            recipientUserId: f.users[0],
            recipientDingTalkUserId: 'synthetic',
            deliveryKind: 'work_notice_action_card',
          })
        await expect(
          previewDirectoryHandover(f.pair, f.admin),
        ).rejects.toThrow()
        expect(await f.stable()).toEqual(before)
      },
    )

    it('stale preview and stale rollback are rejected without undoing new changes', async () => {
      const f = await fixture(),
        p = await previewDirectoryHandover(f.pair, f.admin)
      await q('UPDATE directory_accounts SET name=$2 WHERE id=$1', [
        f.accounts[0],
        'changed',
      ])
      await expect(
        applyDirectoryHandover(f.pair, p.digest, f.admin),
      ).rejects.toThrow('stale')
      const fresh = await previewDirectoryHandover(f.pair, f.admin),
        m = await applyDirectoryHandover(f.pair, fresh.digest, f.admin)
      await q('UPDATE users SET name=$2 WHERE id=$1', [
        f.users[0],
        'new profile',
      ])
      await expect(
        finishDirectoryHandover(m.id, m.digest, f.admin, 'rollback'),
      ).rejects.toThrow('State changed')
      expect(
        (await q('SELECT name FROM users WHERE id=$1', [f.users[0]])).rows[0]
          .name,
      ).toBe('new profile')
    })

    it('late write fault rolls back account moves, department clones and journal atomically', async () => {
      const f = await fixture(),
        p = await previewDirectoryHandover(f.pair, f.admin),
        before = await f.stable()
      const fn = 'syn_fail_' + f.source.replaceAll('-', '')
      await q(
        `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.accounts[0]}'::uuid THEN RAISE EXCEPTION 'synthetic write fault'; END IF; RETURN NEW; END $$`,
      )
      await q(
        `CREATE TRIGGER ${fn} BEFORE UPDATE ON directory_accounts FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
      )
      try {
        await expect(
          applyDirectoryHandover(f.pair, p.digest, f.admin),
        ).rejects.toThrow('synthetic write fault')
      } finally {
        await q(`DROP TRIGGER ${fn} ON directory_accounts`)
        await q(`DROP FUNCTION ${fn}()`)
      }
      expect(await f.stable()).toEqual(before)
      expect((await previewDirectoryHandover(f.pair, f.admin)).digest).toBe(
        p.digest,
      )
      expect(
        (
          await q(
            'SELECT id FROM directory_handovers WHERE source_integration_id=$1',
            [f.source],
          )
        ).rows,
      ).toHaveLength(0)
    })

    it.each(['source', 'target'])(
      'refuses %s department authorization references',
      async (side) => {
        const f = await fixture()
        const dept =
          side === 'source'
            ? f.departments[1]
            : (
                await q(
                  'SELECT id FROM directory_departments WHERE integration_id=$1 LIMIT 1',
                  [f.target],
                )
              ).rows[0].id
        await q(
          `INSERT INTO delegated_role_admin_scopes(admin_user_id,namespace,directory_department_id) VALUES($1,'stock-preparation',$2)`,
          [f.admin, dept],
        )
        await expect(previewDirectoryHandover(f.pair, f.admin)).rejects.toThrow(
          'dependencies',
        )
      },
    )

    it('new target template reference prevents rollback without cascading away the reference', async () => {
      const f = await fixture(),
        p = await previewDirectoryHandover(f.pair, f.admin),
        m = await applyDirectoryHandover(f.pair, p.digest, f.admin)
      const dept = (
        await q(
          "SELECT id FROM directory_departments WHERE integration_id=$1 AND external_department_id='2'",
          [f.target],
        )
      ).rows[0].id
      const template = (
        await q(
          'INSERT INTO delegated_role_scope_templates(name) VALUES($1) RETURNING id',
          [f.tag],
        )
      ).rows[0].id
      await q(
        'INSERT INTO delegated_role_scope_template_departments(template_id,directory_department_id) VALUES($1,$2)',
        [template, dept],
      )
      await expect(
        finishDirectoryHandover(m.id, m.digest, f.admin, 'rollback'),
      ).rejects.toThrow('State changed')
      expect(
        (
          await q(
            'SELECT 1 FROM delegated_role_scope_template_departments WHERE template_id=$1',
            [template],
          )
        ).rows,
      ).toHaveLength(1)
      expect(
        (await q('SELECT 1 FROM directory_departments WHERE id=$1', [dept]))
          .rows,
      ).toHaveLength(1)
    })

    it('refuses canonical approval routing and conflicting same-name department manager metadata', async () => {
      const f = await fixture()
      await q(
        `INSERT INTO org_directory_routing_policy(org_id,purpose,canonical_integration_id) VALUES('default','approval_routing',$1)`,
        [f.source],
      )
      try {
        await expect(previewDirectoryHandover(f.pair, f.admin)).rejects.toThrow(
          'dependencies',
        )
      } finally {
        await q(
          'DELETE FROM org_directory_routing_policy WHERE canonical_integration_id=$1',
          [f.source],
        )
      }
      await q(
        `UPDATE directory_departments SET raw='{"dept_manager_userid_list":["synthetic-manager"]}' WHERE id=$1`,
        [f.departments[0]],
      )
      const p = await previewDirectoryHandover(f.pair, f.admin)
      await expect(
        applyDirectoryHandover(f.pair, p.digest, f.admin),
      ).rejects.toThrow('Target department conflict')
    })

    it('refuses permission writers already in progress instead of approving stale permissions', async () => {
      const f = await fixture(),
        p = await previewDirectoryHandover(f.pair, f.admin),
        writer = await pool!.connect()
      await writer.query('BEGIN')
      try {
        await writer.query(
          'UPDATE role_permissions SET permission_code=permission_code WHERE role_id=$1',
          [f.tag + '_role_0_0'],
        )
        await expect(
          applyDirectoryHandover(f.pair, p.digest, f.admin),
        ).rejects.toMatchObject({ code: '55P03' })
      } finally {
        await writer.query('ROLLBACK')
        writer.release()
      }
      expect((await previewDirectoryHandover(f.pair, f.admin)).digest).toBe(
        p.digest,
      )
    })

    it('an old REPEATABLE READ card writer cannot bypass the committed freeze', async () => {
      const f = await fixture(),
        p = await previewDirectoryHandover(f.pair, f.admin),
        old = await pool!.connect()
      await old.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await old.query('SELECT id FROM directory_integrations WHERE id=$1', [
        f.target,
      ])
      try {
        await applyDirectoryHandover(f.pair, p.digest, f.admin)
        await expect(
          old.query(
            `INSERT INTO dingtalk_approval_card_deliveries(instance_id,node_key,recipient_user_id,recipient_dingtalk_user_id,delivery_kind,integration_id,entry_epoch)
        VALUES($1,'approve',$2,'synthetic','work_notice_action_card',$3,1)`,
            [f.tag + '_approval_0_0', f.users[0], f.target],
          ),
        ).rejects.toMatchObject({ code: '55000', constraint: 'directory_handover_card_insert' })
      } finally {
        await old.query('ROLLBACK')
        old.release()
      }
    })

    it.each(['rollback', 'finalize'] as const)(
      'normal mock-provider OAuth login preserves identity and allows %s',
      async (action) => {
        const f = await fixture(),
          p = await previewDirectoryHandover(f.pair, f.admin),
          m = await applyDirectoryHandover(f.pair, p.digest, f.admin)
        provider.config.mockReturnValue({
          clientId: 'synthetic',
          clientSecret: 'synthetic',
          redirectUri: 'https://synthetic.invalid/callback',
          corpId: f.corp,
        })
        provider.exchange.mockResolvedValue({ accessToken: 'synthetic' })
        for (let i = 0; i < 2; i++) {
          provider.user.mockResolvedValue({
            openId: f.tag + '_open_' + i,
            unionId: f.tag + '_union_' + i,
            nick: 'Synthetic',
            avatarUrl: '',
          })
          expect(
            (await exchangeCodeForUser('synthetic-code')).localUserId,
          ).toBe(f.users[i])
        }
        const telemetry = (
          await q(
            'SELECT local_user_id,last_login_at,profile FROM user_external_identities WHERE local_user_id=ANY($1::text[]) ORDER BY local_user_id',
            [f.users],
          )
        ).rows
        expect(telemetry.every((r) => r.last_login_at)).toBe(true)
        await finishDirectoryHandover(m.id, m.digest, f.admin, action)
        expect(
          (
            await q(
              'SELECT local_user_id,last_login_at,profile FROM user_external_identities WHERE local_user_id=ANY($1::text[]) ORDER BY local_user_id',
              [f.users],
            )
          ).rows,
        ).toEqual(telemetry)
        expect(
          ((await f.stable()).todo as { items: unknown[] }[]).map(
            (t) => t.items.length,
          ),
        ).toEqual([5, 4])
      },
    )

    it('two real competing apply transactions have exactly one winner', async () => {
      const f = await fixture(),
        p = await previewDirectoryHandover(f.pair, f.admin)
      const holder = await pool!.connect()
      await holder.query('BEGIN')
      const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0]
        .pid
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `directory:source-sync-freeze:${[f.source, f.target].sort()[0]}`,
      ])
      const competing = Promise.allSettled([
        applyDirectoryHandover(f.pair, p.digest, f.admin),
        applyDirectoryHandover(f.pair, p.digest, f.admin),
      ])
      try {
        let waiting = false
        for (let i = 0; i < 100; i++) {
          const n = (
            await q(
              `SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))`,
              [pid],
            )
          ).rows[0].n
          if (n === 2) {
            waiting = true
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        expect(waiting).toBe(true)
      } finally {
        await holder.query('ROLLBACK')
        holder.release()
      }
      const outcomes = await competing
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
      expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1)
    })
  },
)

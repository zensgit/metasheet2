import {
  readHandoverSnapshot as snapshot,
  type Row,
  type Client,
  type Pair,
  type Snapshot,
} from './handover-snapshot-v1'
import {
  canonical,
  digest,
  compactHandoverJournal,
  type HandoverJournalV2,
} from './handover-journal-v2'
import { transaction } from '../db/pg'
import { acquireSourceSyncFreezeLock } from './source-sync-freeze-lock'
import { lockUsersForAccessGraphWrite } from './access-graph-mutex'

export class DirectoryHandoverConflict extends Error {
  readonly code = 'DIRECTORY_HANDOVER_CONFLICT'
}

function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new DirectoryHandoverConflict(message)
}

async function assertOperator(c: Client, actorId: string): Promise<void> {
  const r = await c.query(
    `SELECT u.id FROM users u WHERE u.id = $1 AND u.is_active = true
    AND (u.is_admin = true OR EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role_id = 'admin'))`,
    [actorId],
  )
  requireCondition(
    r.rows.length === 1,
    'An active platform administrator is required',
  )
}

async function lockPair(c: Client, p: Pair, actorId: string): Promise<void> {
  requireCondition(
    p.sourceIntegrationId !== p.targetIntegrationId,
    'Distinct integrations are required',
  )
  // Same order as sync: freeze key before local apply. Both ends prevent a late target sync.
  for (const id of [p.sourceIntegrationId, p.targetIntegrationId].sort())
    await acquireSourceSyncFreezeLock(c, id)
  // Existing permission writers do not all use the user mutex. This rare operator transaction
  // refuses concurrent authority writes rather than certifying a stale permission snapshot.
  await c.query(`LOCK TABLE users, user_roles, user_permissions, role_permissions, roles,
    user_orgs, user_external_identities, user_external_auth_grants, directory_account_links, directory_account_departments,
    delegated_role_admin_scopes, delegated_role_scope_template_departments, directory_department_bindings,
    elearning_admin_scopes, elearning_stats_daily, elearning_export_jobs, org_directory_routing_policy IN SHARE MODE NOWAIT`)
  const users = await c.query(
    `SELECT DISTINCT l.local_user_id FROM directory_account_links l
    JOIN directory_accounts a ON a.id = l.directory_account_id
    WHERE a.integration_id = ANY($1::uuid[]) AND l.local_user_id IS NOT NULL ORDER BY l.local_user_id`,
    [[p.sourceIntegrationId, p.targetIntegrationId]],
  )
  const userIds = [
    ...users.rows.map((r) => String(r.local_user_id)),
    actorId,
  ].sort()
  await c.query(
    'SELECT id FROM users WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE NOWAIT',
    [userIds],
  )
  await lockUsersForAccessGraphWrite(c, userIds)
  await c.query(
    'SELECT id FROM directory_integrations WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
    [[p.sourceIntegrationId, p.targetIntegrationId]],
  )
  await c.query(
    'SELECT id FROM directory_accounts WHERE integration_id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
    [[p.sourceIntegrationId, p.targetIntegrationId]],
  )
  await c.query(
    'SELECT id FROM directory_departments WHERE integration_id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
    [[p.sourceIntegrationId, p.targetIntegrationId]],
  )
}

async function preflight(c: Client, p: Pair, s: Snapshot): Promise<void> {
  const rows = (
    await c.query(
      'SELECT * FROM directory_integrations WHERE id = ANY($1::uuid[]) ORDER BY id',
      [[p.sourceIntegrationId, p.targetIntegrationId]],
    )
  ).rows
  const source = rows.find((r) => r.id === p.sourceIntegrationId)
  const target = rows.find((r) => r.id === p.targetIntegrationId)
  requireCondition(source && target, 'Integration not found')
  requireCondition(
    source.provider === 'dingtalk' &&
      target.provider === 'dingtalk' &&
      source.org_id === target.org_id &&
      source.corp_id &&
      source.corp_id === target.corp_id,
    'Same organization and DingTalk enterprise required',
  )
  for (const row of rows) {
    const config = row.config as Row
    requireCondition(
      row.status === 'active' && row.sync_enabled === false,
      'Both integrations must be active with automatic sync off',
    )
    requireCondition(
      config.admissionMode !== 'auto_for_scoped_departments' &&
        (!config.memberGroupSyncMode ||
          config.memberGroupSyncMode === 'disabled'),
      'Automatic governance must be off',
    )
  }
  const config = target.config as Row
  const proof = config.identityVerification as Row | undefined
  requireCondition(
    proof?.source === 'admin_console' &&
      proof.corpId === target.corp_id &&
      proof.appCorpId === target.corp_id &&
      proof.appKey === config.appKey &&
      typeof proof.checkedBy === 'string' &&
      proof.checkedBy.trim() &&
      typeof proof.checkedAt === 'string' &&
      Number.isFinite(Date.parse(proof.checkedAt)),
    'Target application ownership must have current administrator verification',
  )
  const blocking = await c.query(
    `SELECT 1 FROM directory_sync_runs WHERE integration_id = ANY($1::uuid[]) AND status = 'running'
    UNION ALL SELECT 1 FROM provider_org_transfers WHERE (source_integration_id = ANY($1::uuid[]) OR target_integration_id = ANY($1::uuid[])) AND status NOT IN ('applied','cancelled')
    UNION ALL SELECT 1 FROM directory_handovers WHERE state <> 'rolled_back' AND (source_integration_id = ANY($1::uuid[]) OR target_integration_id = ANY($1::uuid[])) LIMIT 1`,
    [[p.sourceIntegrationId, p.targetIntegrationId]],
  )
  requireCondition(
    blocking.rows.length === 0,
    'A sync or transfer is already active',
  )
  requireCondition(
    !s.cards.some((r) => (r.instance as Row | null)?.status === 'pending'),
    'In-flight approval cards must be resolved separately',
  )
  const sourceAccounts = s.accounts.filter(
    (a) => a.integration_id === source.id,
  )
  requireCondition(
    sourceAccounts.length > 0 &&
      s.accounts.length <= 1000 &&
      s.departments.length <= 1000,
    'Handover requires a bounded nonempty source',
  )
  requireCondition(
    s.accounts.every(
      (a) => a.provider === 'dingtalk' && a.corp_id === source.corp_id,
    ),
    'Account enterprise drift detected',
  )
  requireCondition(
    sourceAccounts.every(
      (a) =>
        !s.accounts.some(
          (t) =>
            t.integration_id === target.id &&
            t.external_user_id === a.external_user_id,
        ),
    ),
    'Target account conflicts with source',
  )
  requireCondition(
    s.departmentBindings.length === 0 && s.dependencies.length === 0,
    'Department authorization or routing dependencies require a separate plan',
  )
  const effects = await c.query(
    `SELECT 1 FROM directory_deprovision_effects WHERE local_user_id = ANY($1::text[])
    AND status NOT IN ('superseded','reversed','compensated') LIMIT 1`,
    [s.links.filter((l) => l.local_user_id).map((l) => l.local_user_id)],
  )
  requireCondition(
    effects.rows.length === 0,
    'Deprovision evidence requires a separate plan',
  )
}

export async function previewDirectoryHandover(p: Pair, actorId: string) {
  return transaction(async (c) => {
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await assertOperator(c, actorId)
    const s = await snapshot(c, p)
    await preflight(c, p, s)
    return {
      digest: digest(s),
      accounts: s.accounts.filter(
        (a) => a.integration_id === p.sourceIntegrationId,
      ).length,
      linkedUsers: s.links.filter(
        (l) =>
          l.link_status === 'linked' &&
          l.local_user_id &&
          s.accounts.some(
            (a) =>
              a.id === l.directory_account_id &&
              a.integration_id === p.sourceIntegrationId,
          ),
      ).length,
    }
  })
}

export async function applyDirectoryHandover(
  p: Pair,
  expectedDigest: string,
  actorId: string,
) {
  return transaction(async (c) => {
    await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    await c.query("SET LOCAL lock_timeout='5s'")
    await c.query("SET LOCAL statement_timeout='30s'")
    await lockPair(c, p, actorId)
    await assertOperator(c, actorId)
    const before = await snapshot(c, p)
    await preflight(c, p, before)
    requireCondition(expectedDigest === digest(before), 'Preview is stale')
    const map = new Map<string, string>()
    for (const d of before.departments.filter(
      (d) => d.integration_id === p.sourceIntegrationId,
    )) {
      const existing = before.departments.find(
        (t) =>
          t.integration_id === p.targetIntegrationId &&
          t.external_department_id === d.external_department_id,
      )
      if (existing) {
        requireCondition(
          [
            'provider',
            'name',
            'external_parent_department_id',
            'full_path',
            'order_index',
            'is_active',
            'raw',
          ].every((key) => canonical(existing[key]) === canonical(d[key])),
          'Target department conflict',
        )
        map.set(String(d.id), String(existing.id))
      } else {
        const result = await c.query(
          `INSERT INTO directory_departments
          (integration_id,provider,external_department_id,external_parent_department_id,name,full_path,order_index,is_active,raw)
          SELECT $2,provider,external_department_id,external_parent_department_id,name,full_path,order_index,is_active,raw FROM directory_departments WHERE id=$1 RETURNING id`,
          [d.id, p.targetIntegrationId],
        )
        map.set(String(d.id), String(result.rows[0].id))
      }
    }
    const accountIds = before.accounts
      .filter((a) => a.integration_id === p.sourceIntegrationId)
      .map((a) => a.id)
    for (const m of before.memberships.filter((m) =>
      accountIds.includes(m.directory_account_id),
    )) {
      requireCondition(
        map.has(String(m.directory_department_id)),
        'Source department membership is inconsistent',
      )
      await c.query(
        'UPDATE directory_account_departments SET directory_department_id=$3 WHERE directory_account_id=$1 AND directory_department_id=$2',
        [
          m.directory_account_id,
          m.directory_department_id,
          map.get(String(m.directory_department_id)),
        ],
      )
    }
    // Move the original stable account rows. No duplicate identity, unlink, grant or user write.
    await c.query(
      'UPDATE directory_accounts SET integration_id=$2,updated_at=now() WHERE id=ANY($1::uuid[])',
      [accountIds, p.targetIntegrationId],
    )
    // A new tuple version fences old REPEATABLE READ card writers. The card trigger takes
    // FOR SHARE on these rows and must serialize-fail instead of reading a pre-handover journal.
    await c.query(
      'UPDATE directory_integrations SET updated_at=updated_at WHERE id=ANY($1::uuid[])',
      [[p.sourceIntegrationId, p.targetIntegrationId]],
    )
    const after = await snapshot(c, p)
    requireCondition(
      digest(before.authority) === digest(after.authority) &&
        digest(before.links) === digest(after.links),
      'Authority changed during handover',
    )
    const result = await c.query(
      `INSERT INTO directory_handovers
      (source_integration_id,target_integration_id,state,before_state,after_digest,created_by,updated_by)
      VALUES($1,$2,'applied',$3::jsonb,$4,$5,$5) RETURNING id`,
      [
        p.sourceIntegrationId,
        p.targetIntegrationId,
        JSON.stringify(
          compactHandoverJournal(
            before,
            p.sourceIntegrationId,
            p.targetIntegrationId,
          ),
        ),
        digest(after),
        actorId,
      ],
    )
    return {
      id: String(result.rows[0].id),
      digest: digest(after),
      accounts: accountIds.length,
    }
  })
}

export async function finishDirectoryHandover(
  id: string,
  expectedDigest: string,
  actorId: string,
  action: 'rollback' | 'finalize',
) {
  return transaction(async (c) => {
    await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    await c.query("SET LOCAL lock_timeout='5s'")
    await c.query("SET LOCAL statement_timeout='30s'")
    const found = await c.query(
      'SELECT * FROM directory_handovers WHERE id=$1',
      [id],
    )
    requireCondition(found.rows.length === 1, 'Handover not found')
    const p = {
      sourceIntegrationId: String(found.rows[0].source_integration_id),
      targetIntegrationId: String(found.rows[0].target_integration_id),
    }
    await lockPair(c, p, actorId)
    await assertOperator(c, actorId)
    const journal = (
      await c.query(
        'SELECT * FROM directory_handovers WHERE id=$1 FOR UPDATE',
        [id],
      )
    ).rows[0]
    requireCondition(
      journal.state === 'applied',
      'Handover is not awaiting verification',
    )
    const current = await snapshot(c, p)
    requireCondition(
      digest(current) === expectedDigest &&
        expectedDigest === journal.after_digest,
      'State changed; automatic rollback/finalize refused',
    )
    if (action === 'rollback') {
      const before = journal.before_state as HandoverJournalV2
      requireCondition(
        before?.version === 2,
        'Handover journal upgrade is required',
      )
      const sourceIds = before.accounts.map((a) => a.id)
      await c.query(
        `UPDATE directory_accounts a SET integration_id=$2,updated_at=r.updated_at
         FROM jsonb_to_recordset($1::jsonb) AS r(id uuid, updated_at timestamptz)
         WHERE a.id=r.id AND a.integration_id=$3`,
        [
          JSON.stringify(before.accounts),
          p.sourceIntegrationId,
          p.targetIntegrationId,
        ],
      )
      // Apply only changes the membership FK. Reverse it in place, preserving every
      // other column. The pair (integration_id, external_department_id) is unique,
      // and the full after-digest above pins both ends of this mapping.
      await c.query(
        `UPDATE directory_account_departments m SET directory_department_id=src.id
         FROM directory_departments dst JOIN directory_departments src
           ON src.external_department_id=dst.external_department_id
         WHERE m.directory_account_id=ANY($1::uuid[]) AND dst.id=m.directory_department_id
           AND dst.integration_id=$2 AND src.integration_id=$3`,
        [sourceIds, p.targetIntegrationId, p.sourceIntegrationId],
      )
      const created = current.departments
        .filter(
          (d) =>
            d.integration_id === p.targetIntegrationId &&
            !before.targetDepartmentIds.includes(String(d.id)),
        )
        .map((d) => d.id)
      if (created.length) {
        // Pair snapshots exclude third-party accounts. Never cascade-delete a
        // membership owned by another integration when removing cloned departments.
        const attached = await c.query(
          'SELECT 1 FROM directory_account_departments WHERE directory_department_id=ANY($1::uuid[]) LIMIT 1',
          [created],
        )
        requireCondition(
          !attached.rows.length,
          'A created department is still in use',
        )
        await c.query(
          'DELETE FROM directory_departments WHERE id=ANY($1::uuid[])',
          [created],
        )
      }
      requireCondition(
        digest(await snapshot(c, p)) === before.beforeDigest,
        'Rollback could not restore the approved snapshot',
      )
    }
    await c.query(
      "UPDATE directory_handovers SET state=$2,before_state='{}'::jsonb,updated_by=$3,updated_at=now() WHERE id=$1",
      [id, action === 'rollback' ? 'rolled_back' : 'finalized', actorId],
    )
    return { id, state: action === 'rollback' ? 'rolled_back' : 'finalized' }
  })
}

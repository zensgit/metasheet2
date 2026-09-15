/**
 * DingTalk todo mirror — the ledger MIGRATION contract, the `todoOperatorUnionId` resolver, and the
 * integration-form carry-through that keeps an owner-set operator unionId alive.
 *
 * (design docs/development/takeover-beiliao-20260821/dingtalk-todo-mirror-b-design-20260916.md §3/§6/§8)
 *
 * The `directory_integrations` UPDATE in `updateDirectoryIntegration` REBUILDS the whole config JSON
 * from a fixed key list, so any key with no FE field is silently wiped on the next unrelated save —
 * the reason `approvalCardLinkSecret` / `approvalCardPublicAppUrl` are carried through explicitly.
 * `todoOperatorUnionId` has no FE field either (the owner sets it directly), so it needs the same
 * carry-through, pinned here: drop it and every mirrored todo fails `todo_operator_union_id_missing`
 * the first time somebody edits the integration.
 */
import * as path from 'path'
import { promises as fs } from 'fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as migration from '../../src/db/migrations/zzzz20260916120000_create_dingtalk_todo_mirrors'
import {
  DINGTALK_TODO_MIRRORS_TABLE as TABLE_IN_MIGRATION,
  DINGTALK_TODO_MIRROR_STATUSES,
} from '../../src/db/migrations/zzzz20260916120000_create_dingtalk_todo_mirrors'
import { DINGTALK_TODO_MIRRORS_TABLE as TABLE_IN_SERVICE } from '../../src/services/dingtalk-todo-mirror-service'
import {
  DINGTALK_TODO_OPERATOR_UNION_ID_CONFIG_KEY,
  resolveDingTalkTodoOperatorUnionId,
} from '../../src/integrations/dingtalk/todo-operator-config'
import { updateDirectoryIntegration } from '../../src/directory/directory-sync'
import { normalizeStoredSecretValue } from '../../src/security/encrypted-secrets'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))

vi.mock('../../src/db/pg', () => ({
  query: queryMock,
  transaction: vi.fn(),
}))

const MIGRATION_PATH = path.join(
  __dirname,
  '../../src/db/migrations/zzzz20260916120000_create_dingtalk_todo_mirrors.ts',
)

describe('zzzz20260916120000_create_dingtalk_todo_mirrors', () => {
  it('exports reversible up/down functions taking a single db argument', () => {
    expect(typeof migration.up).toBe('function')
    expect(typeof migration.down).toBe('function')
    expect(migration.up.length).toBe(1)
    expect(migration.down.length).toBe(1)
  })

  it('the table name constant is the SAME one the service writes (no drift between the two)', () => {
    expect(TABLE_IN_MIGRATION).toBe('dingtalk_todo_mirrors')
    expect(TABLE_IN_SERVICE).toBe(TABLE_IN_MIGRATION)
  })

  it('creates THE idempotency index UNIQUE (org_id, source_key) plus the worker/consumer scans', async () => {
    const content = await fs.readFile(MIGRATION_PATH, 'utf-8')
    // the one index the "a redelivery never duplicates a todo" contract rests on
    expect(content).toContain("createIndexIfNotExists(db, 'uq_dingtalk_todo_mirrors_source_key', DINGTALK_TODO_MIRRORS_TABLE, ['org_id', 'source_key'], { unique: true })")
    expect(content).toContain("'idx_dingtalk_todo_mirrors_claim', DINGTALK_TODO_MIRRORS_TABLE, ['status', 'next_attempt_at']")
    expect(content).toContain("'idx_dingtalk_todo_mirrors_reclaim', DINGTALK_TODO_MIRRORS_TABLE, ['status', 'claim_expires_at']")
    expect(content).toContain("'idx_dingtalk_todo_mirrors_instance', DINGTALK_TODO_MIRRORS_TABLE, ['instance_id', 'status']")
  })

  it('org_id is NOT NULL with NO default (a default would file another tenant under a guess)', async () => {
    const content = await fs.readFile(MIGRATION_PATH, 'utf-8')
    expect(content).toContain('org_id TEXT NOT NULL,')
    expect(content).not.toMatch(/org_id TEXT NOT NULL DEFAULT/)
  })

  it('the status CHECK covers exactly the state machine of design §5', async () => {
    const content = await fs.readFile(MIGRATION_PATH, 'utf-8')
    expect(content).toContain("CHECK (status IN ('pending', 'sending', 'created', 'completing', 'completed', 'superseded', 'failed', 'skipped', 'outcome_unknown'))")
    expect([...DINGTALK_TODO_MIRROR_STATUSES]).toEqual([
      'pending', 'sending', 'created', 'completing', 'completed', 'superseded', 'failed', 'skipped', 'outcome_unknown',
    ])
    expect(content).toContain("CHECK (complete_reason IS NULL OR complete_reason IN ('next_node', 'approved', 'rejected', 'revoked', 'cancelled'))")
  })

  it('down() drops the indexes and the table with IF EXISTS', async () => {
    const content = await fs.readFile(MIGRATION_PATH, 'utf-8')
    expect(content).toContain('DROP INDEX IF EXISTS uq_dingtalk_todo_mirrors_source_key')
    expect(content).toContain('DROP TABLE IF EXISTS dingtalk_todo_mirrors')
  })
})

describe('resolveDingTalkTodoOperatorUnionId', () => {
  it('reads the plaintext key off the ONE integration, scoped by org AND active status', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const query = async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params })
      return { rows: [{ config: { [DINGTALK_TODO_OPERATOR_UNION_ID_CONFIG_KEY]: ' fake-operator-union ' } }] }
    }
    const value = await resolveDingTalkTodoOperatorUnionId('11111111-1111-4111-8111-111111111111', 'org-1', query)
    expect(value).toBe('fake-operator-union')
    expect(calls[0].sql).toContain('AND org_id = $2')
    expect(calls[0].sql).toContain("AND status = 'active'")
    expect(calls[0].params).toEqual(['11111111-1111-4111-8111-111111111111', 'org-1', 'dingtalk'])
  })

  it('NEVER falls back to another integration and NEVER to an env override', async () => {
    const query = async () => ({ rows: [] })
    expect(await resolveDingTalkTodoOperatorUnionId('11111111-1111-4111-8111-111111111111', 'org-1', query)).toBe('')
    expect(await resolveDingTalkTodoOperatorUnionId('', 'org-1', query)).toBe('')
    expect(await resolveDingTalkTodoOperatorUnionId('id', '', query)).toBe('')
  })

  it('fails closed on a stringified config, a missing key and a query error', async () => {
    expect(await resolveDingTalkTodoOperatorUnionId('id', 'org-1', async () => ({ rows: [{ config: JSON.stringify({ todoOperatorUnionId: 'fake-u' }) }] }))).toBe('fake-u')
    expect(await resolveDingTalkTodoOperatorUnionId('id', 'org-1', async () => ({ rows: [{ config: {} }] }))).toBe('')
    expect(await resolveDingTalkTodoOperatorUnionId('id', 'org-1', async () => { throw new Error('db down') })).toBe('')
  })
})

describe('directory integration save — todoOperatorUnionId carry-through', () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  function integrationRow(config: Record<string, unknown> = {}) {
    return {
      id: 'dir-1',
      org_id: 'default',
      provider: 'dingtalk',
      name: 'DingTalk CN',
      status: 'active',
      corp_id: 'dingcorp',
      config: {
        appKey: 'ding-app-key',
        appSecret: normalizeStoredSecretValue('unit-secret'),
        rootDepartmentId: '1',
        pageSize: 50,
        admissionMode: 'manual_only',
        admissionDepartmentIds: [],
        excludeDepartmentIds: [],
        memberGroupSyncMode: 'disabled',
        memberGroupDepartmentIds: [],
        memberGroupDefaultRoleIds: [],
        memberGroupDefaultNamespaces: [],
        ...config,
      },
      sync_enabled: true,
      schedule_cron: null,
      schedule_timezone: null,
      default_deprovision_policy: 'mark_inactive',
      last_sync_at: null,
      last_success_at: null,
      last_error: null,
      created_at: '2026-09-16T00:00:00.000Z',
      updated_at: '2026-09-16T00:00:00.000Z',
    }
  }

  it('an unrelated integration-form save PRESERVES an owner-set todoOperatorUnionId', async () => {
    let persisted: Record<string, unknown> | null = null
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('UPDATE directory_integrations')) {
        persisted = JSON.parse(String(params[4]))
        return { rows: [integrationRow(persisted as Record<string, unknown>)] }
      }
      return { rows: [integrationRow({ todoOperatorUnionId: 'fake-operator-union' })] }
    })

    await updateDirectoryIntegration('dir-1', {
      name: 'DingTalk CN renamed',
      corpId: 'dingcorp',
      appKey: 'ding-app-key',
      rootDepartmentId: '1',
    } as never)

    expect(persisted).not.toBeNull()
    expect((persisted as unknown as Record<string, unknown>).todoOperatorUnionId).toBe('fake-operator-union')
  })

  it('an integration that never had one persists null (the key is never invented)', async () => {
    let persisted: Record<string, unknown> | null = null
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('UPDATE directory_integrations')) {
        persisted = JSON.parse(String(params[4]))
        return { rows: [integrationRow(persisted as Record<string, unknown>)] }
      }
      return { rows: [integrationRow()] }
    })

    await updateDirectoryIntegration('dir-1', {
      name: 'DingTalk CN',
      corpId: 'dingcorp',
      appKey: 'ding-app-key',
      rootDepartmentId: '1',
    } as never)

    expect((persisted as unknown as Record<string, unknown>).todoOperatorUnionId).toBeNull()
  })

  it('the generic form CANNOT set it (carry-through only — the write surface is not widened)', async () => {
    let persisted: Record<string, unknown> | null = null
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('UPDATE directory_integrations')) {
        persisted = JSON.parse(String(params[4]))
        return { rows: [integrationRow(persisted as Record<string, unknown>)] }
      }
      return { rows: [integrationRow()] }
    })

    await updateDirectoryIntegration('dir-1', {
      name: 'DingTalk CN',
      corpId: 'dingcorp',
      appKey: 'ding-app-key',
      rootDepartmentId: '1',
      todoOperatorUnionId: 'injected-by-a-caller',
    } as never)

    expect((persisted as unknown as Record<string, unknown>).todoOperatorUnionId).toBeNull()
  })
})

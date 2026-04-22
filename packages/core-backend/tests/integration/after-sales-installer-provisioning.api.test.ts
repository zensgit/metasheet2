/**
 * Integration test: after-sales installer C-min contract with
 * multitable/provisioning.ts.
 *
 * Purpose
 * -------
 * M1 of the multitable-service-extraction roadmap (§5.2) requires that the
 * after-sales installer's C-min path for `installedAsset` land through the
 * backend provisioning seam (ensureLegacyBase / ensureSheet / ensureFields).
 *
 * The existing end-to-end integration test (after-sales-plugin.install.test.ts)
 * covers the full blueprint (7 installedAsset fields + all other objects). That
 * test is deliberately kept unchanged because the 5 extra installedAsset fields
 * beyond the C-min floor (model / location / installedAt / warrantyUntil /
 * status) are real business fields that belong to C-full, not placeholder
 * scaffolding.
 *
 * What this test adds is the narrow seam-level contract check the roadmap
 * §5.2 acceptance criteria specifically calls out:
 *
 *   "新增 1-2 个 integration tests 验证 provisioning helper 与真实 DB 契约"
 *
 * We exercise the production provisioning helpers directly against a real
 * Postgres database and assert that the installedAsset C-min minimum field
 * set (assetCode required + serialNo optional) is persisted through the
 * seam - no plugin-side meta_* SQL access required. This is the contract
 * the after-sales installer relies on when it calls
 * `context.api.multitable.provisioning.ensureObject` in production.
 *
 * Scope (strict M1 C-min)
 * -----------------------
 * - Only installedAsset sheet + 2 fields are exercised here.
 * - Views, records, attachments, automations, notifications are out of scope.
 * - Other after-sales objects (ticket, customer, serviceRecord, etc.) are
 *   covered by the existing end-to-end test.
 */

import { createRequire } from 'module'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_BASE_ID,
  ensureFields,
  ensureLegacyBase,
  ensureObject,
  ensureSheet,
  getObjectFieldId,
  getObjectSheetId,
  type MultitableProvisioningQueryFn,
} from '../../src/multitable/provisioning'

const TENANT_ID = 'tenant_m1_installer_it'
const APP_ID = 'after-sales'
const PROJECT_ID = `${TENANT_ID}:${APP_ID}`
const OBJECT_ID = 'installedAsset'
const SHEET_ID = getObjectSheetId(PROJECT_ID, OBJECT_ID)
const ASSET_CODE_FIELD_ID = getObjectFieldId(PROJECT_ID, OBJECT_ID, 'assetCode')
const SERIAL_NO_FIELD_ID = getObjectFieldId(PROJECT_ID, OBJECT_ID, 'serialNo')
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const require = createRequire(import.meta.url)

function createRealQuery(pool: Pool): MultitableProvisioningQueryFn {
  return async (sql, params) => {
    const result = await pool.query(sql, params as unknown[] | undefined)
    return {
      rows: Array.isArray(result.rows) ? result.rows : [],
      rowCount: typeof result.rowCount === 'number' ? result.rowCount : undefined,
    }
  }
}

/**
 * Provision exactly the multitable tables that the provisioning seam touches.
 * We do not invoke the full migration stack here because this suite only needs
 * meta_bases / meta_sheets / meta_fields, and the full migration stack depends
 * on a dozen unrelated tables (approvals, kanban_configs, etc.) that would
 * widen the test surface beyond the M1 scope. The schema definitions mirror
 * zzz20251231_create_meta_schema.ts and zzzz20260318110000_add_multitable_bases_and_permissions.ts.
 */
async function ensureMultitableSeamSchema(pool: Pool): Promise<void> {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meta_bases (
      id text PRIMARY KEY,
      name text NOT NULL,
      icon text,
      color text,
      owner_id text,
      workspace_id text,
      created_at timestamptz DEFAULT now() NOT NULL,
      updated_at timestamptz DEFAULT now() NOT NULL,
      deleted_at timestamptz
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meta_sheets (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      base_id text REFERENCES meta_bases(id) ON DELETE SET NULL,
      name text NOT NULL,
      description text,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      deleted_at timestamptz
    )
  `)
  // Some earlier test runs may have created meta_sheets without base_id; add it idempotently.
  await pool.query(`
    ALTER TABLE meta_sheets ADD COLUMN IF NOT EXISTS base_id text
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meta_fields (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      sheet_id text NOT NULL REFERENCES meta_sheets(id) ON DELETE CASCADE,
      name text NOT NULL,
      type text NOT NULL,
      property jsonb DEFAULT '{}'::jsonb,
      "order" integer NOT NULL DEFAULT 0,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    )
  `)
  // Ledger table the installer writes to on successful install.
  // Mirrors zzzz20260407140000_create_plugin_after_sales_template_installs.ts.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS plugin_after_sales_template_installs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id text NOT NULL,
      app_id text NOT NULL,
      project_id text NOT NULL,
      template_id text NOT NULL,
      template_version text NOT NULL,
      mode text NOT NULL CHECK (mode IN ('enable', 'reinstall')),
      status text NOT NULL CHECK (status IN ('installed', 'partial', 'failed')),
      created_objects_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_views_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      warnings_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      display_name text NOT NULL DEFAULT '',
      config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      last_install_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_after_sales_template_installs_tenant_app
    ON plugin_after_sales_template_installs(tenant_id, app_id)
  `)
}

describeIfDatabase('after-sales installer C-min contract against real multitable seam', () => {
  let pool: Pool | undefined
  let schemaReady = false

  async function cleanupArtifacts() {
    if (!pool || !schemaReady) return
    await pool.query('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID])
    await pool.query('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID])
  }

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL?.trim()
    pool = new Pool({ connectionString: databaseUrl })
    await ensureMultitableSeamSchema(pool)
    schemaReady = true
    await cleanupArtifacts()
  })

  afterAll(async () => {
    if (pool) {
      await cleanupArtifacts()
      await pool.end()
    }
  })

  beforeEach(async () => {
    await cleanupArtifacts()
  })

  it('provisions installedAsset sheet via ensureLegacyBase + ensureSheet + ensureFields (C-min direct seam)', async () => {
    if (!pool) throw new Error('pool not initialised')
    const query = createRealQuery(pool)

    const baseId = await ensureLegacyBase(query)
    expect(baseId).toBe(DEFAULT_BASE_ID)

    const sheet = await ensureSheet({
      query,
      baseId,
      sheetId: SHEET_ID,
      name: 'Installed Asset',
      description: null,
    })
    expect(sheet).toMatchObject({
      id: SHEET_ID,
      baseId,
      name: 'Installed Asset',
    })

    const fields = await ensureFields({
      query,
      sheetId: SHEET_ID,
      fields: [
        {
          id: ASSET_CODE_FIELD_ID,
          name: 'Asset Code',
          type: 'string',
        },
        {
          id: SERIAL_NO_FIELD_ID,
          name: 'Serial No',
          type: 'string',
        },
      ],
    })
    expect(fields).toHaveLength(2)
    expect(fields.map((f) => ({ id: f.id, name: f.name, type: f.type }))).toEqual([
      { id: ASSET_CODE_FIELD_ID, name: 'Asset Code', type: 'string' },
      { id: SERIAL_NO_FIELD_ID, name: 'Serial No', type: 'string' },
    ])

    const sheetRow = await pool.query<{ id: string; name: string; base_id: string }>(
      `SELECT id, name, base_id FROM meta_sheets WHERE id = $1`,
      [SHEET_ID],
    )
    expect(sheetRow.rows).toEqual([
      { id: SHEET_ID, name: 'Installed Asset', base_id: DEFAULT_BASE_ID },
    ])

    const fieldRows = await pool.query<{ id: string; name: string; type: string }>(
      `SELECT id, name, type
       FROM meta_fields
       WHERE sheet_id = $1
       ORDER BY "order" ASC, id ASC`,
      [SHEET_ID],
    )
    const rowById = new Map(fieldRows.rows.map((r) => [r.id, r]))
    expect(rowById.get(ASSET_CODE_FIELD_ID)).toEqual({
      id: ASSET_CODE_FIELD_ID,
      name: 'Asset Code',
      type: 'string',
    })
    expect(rowById.get(SERIAL_NO_FIELD_ID)).toEqual({
      id: SERIAL_NO_FIELD_ID,
      name: 'Serial No',
      type: 'string',
    })
    expect(fieldRows.rows).toHaveLength(2)
  })

  it('provisions installedAsset via ensureObject with the C-min minimum descriptor', async () => {
    if (!pool) throw new Error('pool not initialised')
    const query = createRealQuery(pool)

    const result = await ensureObject({
      query,
      projectId: PROJECT_ID,
      descriptor: {
        id: OBJECT_ID,
        name: 'Installed Asset',
        fields: [
          {
            id: 'assetCode',
            name: 'Asset Code',
            type: 'string',
          },
          {
            id: 'serialNo',
            name: 'Serial No',
            type: 'string',
          },
        ],
      },
    })

    expect(result.baseId).toBe(DEFAULT_BASE_ID)
    expect(result.sheet.id).toBe(SHEET_ID)
    expect(result.sheet.name).toBe('Installed Asset')
    expect(result.fields.map((f) => f.name)).toEqual(['Asset Code', 'Serial No'])

    const sheetRow = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM meta_sheets WHERE id = $1`,
      [SHEET_ID],
    )
    expect(sheetRow.rows).toEqual([{ id: SHEET_ID, name: 'Installed Asset' }])

    const fieldRows = await pool.query<{ name: string; type: string }>(
      `SELECT name, type
       FROM meta_fields
       WHERE sheet_id = $1
       ORDER BY "order" ASC, id ASC`,
      [SHEET_ID],
    )
    expect(fieldRows.rows).toEqual([
      { name: 'Asset Code', type: 'string' },
      { name: 'Serial No', type: 'string' },
    ])
  })

  it('routes the after-sales installer runInstall through the multitable provisioning seam for installedAsset C-min', async () => {
    if (!pool) throw new Error('pool not initialised')
    const query = createRealQuery(pool)

    // Plugin consumes the production seam exclusively via
    // context.api.multitable.provisioning. This test calls the installer's
    // runInstall with a minimal context that exposes only that seam, proving
    // the plugin does not reach into meta_* directly.
    const ensureObjectCalls: Array<{ projectId: string; descriptor: unknown }> = []
    const provisioning = {
      ensureObject: async (input: {
        projectId: string
        descriptor: { id: string; name: string; fields?: unknown[] }
      }) => {
        ensureObjectCalls.push({ projectId: input.projectId, descriptor: input.descriptor })
        return ensureObject({
          query,
          projectId: input.projectId,
          descriptor: input.descriptor as Parameters<typeof ensureObject>[0]['descriptor'],
        })
      },
    }

    const fakeDatabase = {
      async query(sql: string, params: unknown[] = []) {
        const result = await pool!.query(sql, params)
        return result.rows
      },
    }

    const blueprint = {
      id: 'after-sales-default',
      version: '0.1.0',
      appId: APP_ID,
      objects: [
        {
          id: OBJECT_ID,
          name: 'Installed Asset',
          backing: 'multitable' as const,
          fields: [
            { id: 'assetCode', name: 'Asset Code', type: 'string' as const, required: true },
            { id: 'serialNo', name: 'Serial No', type: 'string' as const, required: false },
          ],
        },
      ],
    }

    // Ensure ledger is clean for this specific (tenant, app)
    await pool.query(
      `DELETE FROM plugin_after_sales_template_installs WHERE tenant_id = $1 AND app_id = $2`,
      [TENANT_ID, APP_ID],
    )

    const installer = require('../../../../plugins/plugin-after-sales/lib/installer.cjs') as {
      runInstall: (input: unknown) => Promise<{
        projectId: string
        status: string
        createdObjects: string[]
      }>
    }

    try {
      const result = await installer.runInstall({
        context: {
          api: {
            database: fakeDatabase,
            multitable: { provisioning },
          },
        },
        tenantId: TENANT_ID,
        blueprint,
        mode: 'enable',
      })

      expect(result.status).toBe('installed')
      expect(result.projectId).toBe(PROJECT_ID)
      expect(result.createdObjects).toEqual([OBJECT_ID])
      expect(ensureObjectCalls).toHaveLength(1)
      expect(ensureObjectCalls[0]?.projectId).toBe(PROJECT_ID)

      const fieldRows = await pool.query<{ name: string; type: string }>(
        `SELECT name, type
         FROM meta_fields
         WHERE sheet_id = $1
         ORDER BY "order" ASC, id ASC`,
        [SHEET_ID],
      )
      expect(fieldRows.rows).toEqual([
        { name: 'Asset Code', type: 'string' },
        { name: 'Serial No', type: 'string' },
      ])
    } finally {
      await pool.query(
        `DELETE FROM plugin_after_sales_template_installs WHERE tenant_id = $1 AND app_id = $2`,
        [TENANT_ID, APP_ID],
      )
    }
  })
})

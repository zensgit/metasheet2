/**
 * Unit pins for src/multitable/managed-field-delete-guard.ts — the field-level twin of the
 * sheet-delete refusal. The route-level cells (409 / zero-write / authz-first / positive control)
 * live in multitable-manage-schema-permission-matrix.test.ts; this file pins the module contract:
 *   - ONE truth source: the predicate is the sheet-level `isPluginManagedSheet` read of
 *     `plugin_multitable_object_registry`, keyed by sheet id, never a second SELECT of its own;
 *   - lookup errors PROPAGATE (no swallow-and-answer-managed);
 *   - the 409 body is coded and values-free.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  MANAGED_FIELD_DELETE_REFUSED_CODE,
  MANAGED_FIELD_DELETE_REFUSED_MESSAGE,
  managedFieldDeleteRefusalBody,
  resolveManagedFieldDeleteRefusal,
} from '../../src/multitable/managed-field-delete-guard'
import { SHEET_PLUGIN_MANAGED_MESSAGE } from '../../src/multitable/sheet-delete-guard'

const SHEET = 'sheet_a5cd0f8c1e2b3d4e5f60718'

describe('managed-field-delete-guard', () => {
  it('answers YES exactly when the registry holds a row for the field\'s SHEET — one SELECT, keyed by sheet id', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      expect(normalized).toBe('SELECT 1 FROM plugin_multitable_object_registry WHERE sheet_id = $1 LIMIT 1')
      return { rows: params?.[0] === SHEET ? [{ '?column?': 1 }] : [] }
    })
    await expect(resolveManagedFieldDeleteRefusal(query, SHEET)).resolves.toBe(true)
    await expect(resolveManagedFieldDeleteRefusal(query, 'sheet_ordinary')).resolves.toBe(false)
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls.map((c) => c[1])).toEqual([[SHEET], ['sheet_ordinary']])
  })

  it('lets a registry lookup error propagate — it never answers "managed" (or "not managed") on failure', async () => {
    const boom = new Error('relation "plugin_multitable_object_registry" does not exist')
    const query = vi.fn(async () => {
      throw boom
    })
    await expect(resolveManagedFieldDeleteRefusal(query, SHEET)).rejects.toBe(boom)
  })

  it('refusal body is coded, ok:false, and values-free (no plugin / project / object / sheet / field)', () => {
    const body = managedFieldDeleteRefusalBody()
    expect(body).toEqual({
      ok: false,
      error: { code: MANAGED_FIELD_DELETE_REFUSED_CODE, message: MANAGED_FIELD_DELETE_REFUSED_MESSAGE },
    })
    expect(MANAGED_FIELD_DELETE_REFUSED_CODE).toBe('MANAGED_FIELD_DELETE_REFUSED')
    // the message is a constant: it cannot carry a value because it takes no input
    expect(managedFieldDeleteRefusalBody()).toEqual(body)
    expect(MANAGED_FIELD_DELETE_REFUSED_MESSAGE).not.toMatch(/\$\{|fld_|sheet_|tenant_|plugin-integration-core|after-sales/)
    // it says what the sheet-level message says, at the column level: owned by a plugin, use the plugin's flow
    expect(MANAGED_FIELD_DELETE_REFUSED_MESSAGE).toMatch(/owned by a plugin/)
    expect(MANAGED_FIELD_DELETE_REFUSED_MESSAGE).toMatch(/plugin's own flow/)
    expect(SHEET_PLUGIN_MANAGED_MESSAGE).toMatch(/owned by a plugin/)
  })
})

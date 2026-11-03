/**
 * Copy-sheet CS-14 / §6 (S8): a snapshot copied from a plugin-managed sheet is refused to EVERY plugin in
 * EVERY scope mode, off the server-written `meta_sheets.copied_from_kind` column.
 *
 *   P1 `copied_from_kind = 'plugin-managed'` → MultitableSheetScopeError, owner label 'copied-snapshot',
 *      regardless of MULTITABLE_PLUGIN_SHEET_SCOPE_MODE (observe AND enforce), for any plugin name.
 *   P2 `'user'` (a snapshot of an ordinary sheet) and NULL (not a copy) pass — they fall through to the
 *      registry / mode decision exactly as before.
 *   P3 provenance column not migrated (SQLSTATE 42703, Chinese-locale prose) → pass (no copy can exist);
 *      any other error propagates (fail-closed).
 *   P4 the statement shape is pinned: a plain column read, not a column-tolerant `to_jsonb` read.
 *   P5 WIRING: `src/index.ts`'s `assertSheetScope` host hook calls the helper BEFORE `assertPluginOwnsSheet`
 *      (source-tree proof — the hook is a closure inside the server class and is not unit-constructible).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  COPIED_FROM_KIND_SQL,
  COPIED_SNAPSHOT_SCOPE_OWNER,
  assertSheetNotCopiedFromPluginManaged,
  isCopiedFromKind,
} from '../../src/multitable/copied-sheet-plugin-scope'
import { MultitableSheetScopeError } from '../../src/multitable/plugin-scope'

function queryAnswering(kind: unknown) {
  return vi.fn(async (sql: string, params: unknown[] = []) => {
    expect(sql).toBe(COPIED_FROM_KIND_SQL)
    expect(params).toEqual(['sheet_x'])
    return { rows: kind === undefined ? [] : [{ copied_from_kind: kind }] }
  })
}

describe('copied-sheet plugin scope (CS-14)', () => {
  const originalMode = process.env.MULTITABLE_PLUGIN_SHEET_SCOPE_MODE
  afterEach(() => {
    if (originalMode === undefined) delete process.env.MULTITABLE_PLUGIN_SHEET_SCOPE_MODE
    else process.env.MULTITABLE_PLUGIN_SHEET_SCOPE_MODE = originalMode
  })

  it('P1: plugin-managed snapshot → MultitableSheetScopeError in observe AND enforce, for any plugin', async () => {
    for (const mode of ['observe', 'enforce', undefined]) {
      if (mode === undefined) delete process.env.MULTITABLE_PLUGIN_SHEET_SCOPE_MODE
      else process.env.MULTITABLE_PLUGIN_SHEET_SCOPE_MODE = mode
      for (const pluginName of ['plugin-integration-core', 'plugin-attendance', 'some-other-plugin']) {
        const query = queryAnswering('plugin-managed')
        const err = await assertSheetNotCopiedFromPluginManaged(query, { pluginName, sheetId: 'sheet_x' }).catch((e) => e)
        expect(err).toBeInstanceOf(MultitableSheetScopeError)
        expect((err as MultitableSheetScopeError).code).toBe('MULTITABLE_SHEET_SCOPE_FORBIDDEN')
        expect((err as Error).message).toContain(COPIED_SNAPSHOT_SCOPE_OWNER)
        expect(query).toHaveBeenCalledTimes(1)
      }
    }
  })

  it('P2: a user-sheet snapshot, a non-copy (NULL) and an unknown sheet all pass through', async () => {
    for (const kind of ['user', null, undefined]) {
      await expect(assertSheetNotCopiedFromPluginManaged(queryAnswering(kind), { pluginName: 'p', sheetId: 'sheet_x' }))
        .resolves.toBeUndefined()
    }
  })

  it('P3: provenance column not migrated (42703, Chinese prose) passes; any other error propagates', async () => {
    const missingColumn = vi.fn(async () => {
      const err = new Error('字段 "copied_from_kind" 不存在') as Error & { code?: string }
      err.code = '42703'
      throw err
    })
    await expect(assertSheetNotCopiedFromPluginManaged(missingColumn, { pluginName: 'p', sheetId: 'sheet_x' }))
      .resolves.toBeUndefined()

    const broken = vi.fn(async () => {
      const err = new Error('connection refused') as Error & { code?: string }
      err.code = 'ECONNREFUSED'
      throw err
    })
    await expect(assertSheetNotCopiedFromPluginManaged(broken, { pluginName: 'p', sheetId: 'sheet_x' }))
      .rejects.toMatchObject({ code: 'ECONNREFUSED' })
    // A prose-only "missing column" without the SQLSTATE is NOT the migration signal (fail-closed).
    const proseOnly = vi.fn(async () => { throw new Error('column "copied_from_kind" does not exist') })
    await expect(assertSheetNotCopiedFromPluginManaged(proseOnly, { pluginName: 'p', sheetId: 'sheet_x' }))
      .rejects.toThrow(/does not exist/)
  })

  it('P4: statement shape + kind vocabulary', () => {
    expect(COPIED_FROM_KIND_SQL).toBe('SELECT copied_from_kind FROM meta_sheets WHERE id = $1')
    expect(isCopiedFromKind('user')).toBe(true)
    expect(isCopiedFromKind('plugin-managed')).toBe(true)
    expect(isCopiedFromKind(null)).toBe(false)
    expect(isCopiedFromKind('managed')).toBe(false)
  })

  it('P5: index.ts assertSheetScope host hook calls the helper before the registry/mode decision', () => {
    const source = readFileSync(join(__dirname, '../../src/index.ts'), 'utf8').replace(/\r\n?/g, '\n')
    expect(source).toMatch(/import \{ assertSheetNotCopiedFromPluginManaged \} from '\.\/multitable\/copied-sheet-plugin-scope'/)
    const hookStart = source.indexOf('assertSheetScope: async ({ sheetId, pluginName }) => {')
    expect(hookStart).toBeGreaterThan(0)
    const hookBody = source.slice(hookStart, source.indexOf('return { registered: ownsSheet }', hookStart))
    const denyAt = hookBody.indexOf('await assertSheetNotCopiedFromPluginManaged(txQuery, { pluginName, sheetId })')
    const registryAt = hookBody.indexOf('await assertPluginOwnsSheet(txQuery, {')
    expect(denyAt).toBeGreaterThan(0)
    expect(registryAt).toBeGreaterThan(denyAt)
    // Not gated on the mode: the deny sits outside (before) the `resolvePluginSheetScopeMode()` branch.
    const modeAt = hookBody.indexOf('resolvePluginSheetScopeMode()')
    expect(modeAt).toBeGreaterThan(denyAt)
  })
})

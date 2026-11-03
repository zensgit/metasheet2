/**
 * 字段类型转换 —— 门 ③ ④ ⑤ 的唯一判定 `judgeFieldRetypeConvertGates`，按函数本身钉住。
 * 设计锁：docs/development/multitable-field-retype-first-batch-adr-20260926.md §2「门」、增补 B1、增补 C。
 *
 * 为什么要有这一份：门 ⑤ 里显式的 `canRead` 判定，路由级测试钉不住。路由传进来的回调是真的
 * `hasFullTableReadAccess`，它自 #6147 起自己也先查 `canRead`——把判定函数里的那一行删掉，路由级的
 * 「只有改结构权 ⇒ 403」照样是绿的，因为真回调替它拒了。这里把回调换成恒真的桩，让那一行独自承担结果。
 */
import { describe, expect, test, vi } from 'vitest'

import {
  FIELD_RETYPE_FULL_TABLE_READ_REQUIRED_CODE,
  judgeFieldRetypeConvertGates,
  type FieldRetypeConvertGateCapabilities,
} from '../../src/multitable/field-retype-convert-gates'
import type { SheetLiveness } from '../../src/multitable/sheet-liveness'

const ALL: FieldRetypeConvertGateCapabilities = { canManageFields: true, canRead: true }

function judge(overrides: {
  capabilities?: Partial<FieldRetypeConvertGateCapabilities> | Record<string, unknown>
  sheetLiveness?: SheetLiveness
  fullRead?: boolean
} = {}) {
  const hasFullTableReadAccess = vi.fn(async () => overrides.fullRead ?? true)
  const verdict = judgeFieldRetypeConvertGates({
    capabilities: { ...ALL, ...(overrides.capabilities ?? {}) } as FieldRetypeConvertGateCapabilities,
    sheetLiveness: overrides.sheetLiveness ?? 'live',
    hasFullTableReadAccess,
  })
  return { verdict, hasFullTableReadAccess }
}

describe('judgeFieldRetypeConvertGates — gates ③ ④ ⑤, one judgment', () => {
  test('every gate passes ⇒ null, and the full-table read was asked exactly once', async () => {
    const { verdict, hasFullTableReadAccess } = judge()
    expect(await verdict).toBeNull()
    expect(hasFullTableReadAccess).toHaveBeenCalledTimes(1)
  })

  test('⑤ checks canRead ITSELF: schema authority without read is refused even when the callback says yes — and the callback is never asked', async () => {
    const { verdict, hasFullTableReadAccess } = judge({ capabilities: { canRead: false }, fullRead: true })
    expect(await verdict).toEqual({ gate: 5, kind: 'full_table_read_required' })
    expect(hasFullTableReadAccess).not.toHaveBeenCalled()
  })

  test('⑤ canRead must be exactly true: undefined, null, a truthy string and 1 are refused, callback stubbed true', async () => {
    for (const canRead of [undefined, null, 'true', 1, {}, []]) {
      const { verdict, hasFullTableReadAccess } = judge({ capabilities: { canRead }, fullRead: true })
      expect([canRead, await verdict]).toEqual([canRead, { gate: 5, kind: 'full_table_read_required' }])
      expect(hasFullTableReadAccess).not.toHaveBeenCalled()
    }
  })

  test('⑤ canRead alone is not enough: the full-table read must also hold', async () => {
    const { verdict, hasFullTableReadAccess } = judge({ fullRead: false })
    expect(await verdict).toEqual({ gate: 5, kind: 'full_table_read_required' })
    expect(hasFullTableReadAccess).toHaveBeenCalledTimes(1)
  })

  test('the two ways of failing ⑤ answer identically — the refusal does not say which one', async () => {
    const noRead = await judge({ capabilities: { canRead: false }, fullRead: true }).verdict
    const masked = await judge({ fullRead: false }).verdict
    expect(noRead).toEqual(masked)
    expect(FIELD_RETYPE_FULL_TABLE_READ_REQUIRED_CODE).toBe('FULL_TABLE_READ_REQUIRED')
  })

  test('③ no schema authority ⇒ forbidden; it must be exactly true; nothing else is looked at', async () => {
    for (const canManageFields of [false, undefined, null, 'true', 1]) {
      const { verdict, hasFullTableReadAccess } = judge({ capabilities: { canManageFields }, sheetLiveness: 'deleted' })
      expect([canManageFields, await verdict]).toEqual([canManageFields, { gate: 3, kind: 'forbidden' }])
      expect(hasFullTableReadAccess).not.toHaveBeenCalled()
    }
  })

  test('④ a sheet that is not live ⇒ not_live with its liveness; the full-table read is not asked on a dead sheet', async () => {
    for (const sheetLiveness of ['deleted', 'absent'] as const) {
      const { verdict, hasFullTableReadAccess } = judge({ sheetLiveness: sheetLiveness as SheetLiveness })
      expect(await verdict).toEqual({ gate: 4, kind: 'not_live', sheetLiveness })
      expect(hasFullTableReadAccess).not.toHaveBeenCalled()
    }
  })

  test('order ③ → ④ → ⑤: the first gate that fails answers', async () => {
    // nothing holds: ③ answers, not ④ or ⑤
    expect(await judge({ capabilities: { canManageFields: false, canRead: false }, sheetLiveness: 'deleted', fullRead: false }).verdict)
      .toEqual({ gate: 3, kind: 'forbidden' })
    // ③ holds: ④ answers before ⑤ — a caller with schema authority learns the sheet is gone, not that it cannot read
    expect(await judge({ capabilities: { canRead: false }, sheetLiveness: 'deleted', fullRead: false }).verdict)
      .toEqual({ gate: 4, kind: 'not_live', sheetLiveness: 'deleted' })
  })

  test('a callback that throws is not swallowed: the judgment rejects, it never turns into a pass', async () => {
    const verdict = judgeFieldRetypeConvertGates({
      capabilities: ALL,
      sheetLiveness: 'live',
      hasFullTableReadAccess: async () => { throw new Error('lookup failed') },
    })
    await expect(verdict).rejects.toThrow('lookup failed')
  })
})

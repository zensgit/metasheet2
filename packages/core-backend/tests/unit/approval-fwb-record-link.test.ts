/** record-link + FWB-2 — submit/execute rechecks (pure goldens, required lane). Fail-closed everywhere. */
import { describe, expect, test, vi } from 'vitest'

import {
  probeRecordLinkSubmitAuthConstantShape,
  recheckBoundRecordAtExecute,
  RECORD_LINK_SUBMIT_AUTH_STEPS,
  sortRecordLinkSubmitCandidates,
  validateRecordLinkAtSubmit,
  type RecordLinkChecks,
  type RecordLinkSubmitAuthDeps,
} from '../../src/multitable/approval-fwb-record-link'
// RecordLinkSubmitAuthDeps used by P1-3 two-link transcript parity

const trx = { query: async () => ({ rows: [], rowCount: 0 }) }
const checks = (over: Partial<Record<keyof RecordLinkChecks, boolean | 'throw'>> = {}): RecordLinkChecks => {
  const mk = (k: keyof RecordLinkChecks, dflt: boolean) => async () => {
    const v = over[k]
    if (v === 'throw') throw new Error('backend down')
    return v ?? dflt
  }
  return {
    fillerCanReadRecord: mk('fillerCanReadRecord', true),
    recordExists: mk('recordExists', true),
    recordIsLocked: mk('recordIsLocked', false),
    configurerCanWriteRecord: mk('configurerCanWriteRecord', true),
  }
}

describe('record-link + FWB-2 rechecks', () => {
  test('submit: unreadable AND nonexistent produce the SAME code (no existence oracle); errors fail closed', async () => {
    expect(await validateRecordLinkAtSubmit(checks(), 'u', 's', 'r')).toEqual({ ok: true })
    expect(await validateRecordLinkAtSubmit(checks({ fillerCanReadRecord: false }), 'u', 's', 'r')).toEqual({ ok: false, code: 'link_not_readable' })
    expect(await validateRecordLinkAtSubmit(checks({ fillerCanReadRecord: 'throw' }), 'u', 's', 'r')).toEqual({ ok: false, code: 'link_not_readable' })
  })

  test('execute: exists→locked→writable in order, each fail-closed (an ERRORED lock check counts as LOCKED)', async () => {
    expect(await recheckBoundRecordAtExecute(trx, checks(), 'u', 's', 'r')).toEqual({ ok: true })
    expect(await recheckBoundRecordAtExecute(trx, checks({ recordExists: false }), 'u', 's', 'r')).toEqual({ ok: false, code: 'record_missing' })
    expect(await recheckBoundRecordAtExecute(trx, checks({ recordIsLocked: true }), 'u', 's', 'r')).toEqual({ ok: false, code: 'record_locked' })
    expect(await recheckBoundRecordAtExecute(trx, checks({ recordIsLocked: 'throw' }), 'u', 's', 'r')).toEqual({ ok: false, code: 'record_locked' })
    expect(await recheckBoundRecordAtExecute(trx, checks({ configurerCanWriteRecord: false }), 'u', 's', 'r')).toEqual({ ok: false, code: 'record_not_writable' })
    expect(await recheckBoundRecordAtExecute(trx, checks({ recordExists: 'throw' }), 'u', 's', 'r')).toEqual({ ok: false, code: 'record_missing' })
  })
})

describe('probeRecordLinkSubmitAuthConstantShape — ordered transcript parity (P2-1)', () => {
  type GateOver = {
    membership?: boolean
    baseReadable?: boolean
    sheetReadable?: boolean
    denied?: boolean
    exists?: boolean
  }

  function deps(over: GateOver = {}): RecordLinkSubmitAuthDeps {
    return {
      sheetBelongsToBase: vi.fn(async () => over.membership ?? true),
      baseReadable: vi.fn(async () => over.baseReadable ?? true),
      resolveSheetCapabilities: vi.fn(async () => ({
        isAdminRole: false,
        capabilities: { canRead: over.sheetReadable ?? true },
      })),
      isRecordReadDeniedStrict: vi.fn(async () => over.denied === true),
      recordExistsOnSheet: vi.fn(async () => over.exists ?? true),
    }
  }

  test('missing / mismatch / unreadable / denied share ordered helper transcript (not only public body)', async () => {
    const cases: Array<{ label: string; over: GateOver }> = [
      { label: 'missing', over: { exists: false } },
      { label: 'mismatch', over: { membership: false } },
      { label: 'unreadable-base', over: { baseReadable: false } },
      { label: 'unreadable-sheet', over: { sheetReadable: false } },
      { label: 'denied', over: { denied: true, exists: true } },
    ]
    const transcripts: string[][] = []
    for (const c of cases) {
      const d = deps(c.over)
      d.lockAuthorityRows = vi.fn(async () => {})
      const transcript: string[] = []
      const ok = await probeRecordLinkSubmitAuthConstantShape(
        d,
        { userId: 'u', baseId: 'b', sheetId: 's', recordId: `rec-${c.label}` },
        transcript,
      )
      expect(ok, c.label).toBe(false)
      transcripts.push(transcript)
      expect(transcript, c.label).toEqual([...RECORD_LINK_SUBMIT_AUTH_STEPS])
      expect(d.lockAuthorityRows, c.label).toHaveBeenCalled()
    }
    for (let i = 1; i < transcripts.length; i += 1) {
      expect(transcripts[i]).toEqual(transcripts[0])
    }
  })

  test('readable path returns true and still emits the full step transcript', async () => {
    const d = deps({})
    d.lockAuthorityRows = vi.fn(async () => {})
    const transcript: string[] = []
    await expect(
      probeRecordLinkSubmitAuthConstantShape(
        d,
        { userId: 'u', baseId: 'b', sheetId: 's', recordId: 'rec-ok' },
        transcript,
      ),
    ).resolves.toBe(true)
    expect(transcript).toEqual([...RECORD_LINK_SUBMIT_AUTH_STEPS])
  })

  test('P1-3 two-link: equal depth transcripts when A readable/unreadable and B fails', async () => {
    // Both links always run the full step list — failure on B does not shorten A's pipeline.
    const makeDeps = (over: GateOver): RecordLinkSubmitAuthDeps => {
      const d = deps(over)
      d.lockAuthorityRows = vi.fn(async () => {})
      return d
    }
    const runPair = async (aOver: GateOver, bOver: GateOver) => {
      const tA: string[] = []
      const tB: string[] = []
      const okA = await probeRecordLinkSubmitAuthConstantShape(
        makeDeps(aOver),
        { userId: 'u', baseId: 'b', sheetId: 's', recordId: 'rec-a' },
        tA,
      )
      const okB = await probeRecordLinkSubmitAuthConstantShape(
        makeDeps(bOver),
        { userId: 'u', baseId: 'b', sheetId: 's', recordId: 'rec-b' },
        tB,
      )
      return { okA, okB, tA, tB }
    }
    const deniedB = await runPair({}, { exists: false })
    expect(deniedB.okA).toBe(true)
    expect(deniedB.okB).toBe(false)
    expect(deniedB.tA).toEqual(deniedB.tB)
    expect(deniedB.tA).toEqual([...RECORD_LINK_SUBMIT_AUTH_STEPS])

    const bothDenied = await runPair({ exists: false }, { membership: false })
    expect(bothDenied.okA).toBe(false)
    expect(bothDenied.okB).toBe(false)
    expect(bothDenied.tA).toEqual(bothDenied.tB)
    expect(bothDenied.tA.length).toBe(RECORD_LINK_SUBMIT_AUTH_STEPS.length)
  })

  test('sortRecordLinkSubmitCandidates: opposite field orders converge to one lock order', () => {
    const schemaOrderAB = [
      { fieldId: 'linkB', baseId: 'base-b', sheetId: 'sheet-b', recordId: 'rec-b' },
      { fieldId: 'linkA', baseId: 'base-a', sheetId: 'sheet-a', recordId: 'rec-a' },
    ]
    const schemaOrderBA = [
      { fieldId: 'linkA', baseId: 'base-a', sheetId: 'sheet-a', recordId: 'rec-a' },
      { fieldId: 'linkB', baseId: 'base-b', sheetId: 'sheet-b', recordId: 'rec-b' },
    ]
    const sortedAB = sortRecordLinkSubmitCandidates(schemaOrderAB)
    const sortedBA = sortRecordLinkSubmitCandidates(schemaOrderBA)
    expect(sortedAB.map((c) => c.baseId)).toEqual(['base-a', 'base-b'])
    expect(sortedBA.map((c) => c.baseId)).toEqual(['base-a', 'base-b'])
    expect(sortedAB.map((c) => `${c.baseId}/${c.sheetId}/${c.recordId}/${c.fieldId}`))
      .toEqual(sortedBA.map((c) => `${c.baseId}/${c.sheetId}/${c.recordId}/${c.fieldId}`))
  })

  test('probe step order: locks before sheet_membership (membership under lock)', async () => {
    const order: string[] = []
    const d: RecordLinkSubmitAuthDeps = {
      sheetBelongsToBase: vi.fn(async () => {
        order.push('sheet_membership')
        return true
      }),
      lockAuthorityRows: vi.fn(async () => {
        order.push('lock_authority')
      }),
      lockRowAuth: vi.fn(async () => {
        order.push('lock_row_auth')
      }),
      baseReadable: vi.fn(async () => {
        order.push('base_readable')
        return true
      }),
      resolveSheetCapabilities: vi.fn(async () => {
        order.push('sheet_capabilities')
        return { isAdminRole: false, capabilities: { canRead: true } }
      }),
      isRecordReadDeniedStrict: vi.fn(async () => {
        order.push('row_deny_strict')
        return false
      }),
      recordExistsOnSheet: vi.fn(async () => {
        order.push('record_exists')
        return true
      }),
    }
    await probeRecordLinkSubmitAuthConstantShape(
      d,
      { userId: 'u', baseId: 'b', sheetId: 's', recordId: 'r' },
    )
    expect(order).toEqual([
      'lock_authority',
      'lock_row_auth',
      'sheet_membership',
      'record_exists',
      'base_readable',
      'sheet_capabilities',
      'row_deny_strict',
    ])
    // Membership after authority lock — not a pre-lock snapshot.
    expect(order.indexOf('sheet_membership')).toBeGreaterThan(order.indexOf('lock_authority'))
  })
})

/**
 * Child process for the head-only inertness suite: what the coordination context module does in a
 * fresh process that never loaded a test setup file (the setup files force `'throw'`).
 *
 * 1. Inside an active (stand-in) coordination context, a main-pool access is noted the way the
 *    production pool hook notes one. In the production default mode it is counted, not refused.
 * 2. `setSettlementCoordinationNestingModeV1` returns the mode it replaces; called once, it returns the
 *    mode the module's own initializer set.
 *
 * Prints one line: `MODE_PROBE <counted|threw:<code>> <count> <initial mode>`.
 */
import {
  noteSettlementCoordinationMainPoolAccessV1,
  runInSettlementCoordinationContextV1,
  setSettlementCoordinationNestingModeV1,
  settlementCoordinationNestedMainPoolAccessesV1,
} from '../../src/attendance/coordination/settlement-coordination-context'

async function main(): Promise<void> {
  let note = 'counted'
  try {
    await runInSettlementCoordinationContextV1(
      {
        connection: {},
        orgLexical: 'default',
        classZeroHeld: false,
        entryLabel: 'test.mode-child',
        isLive: () => true,
        covers: () => false,
      },
      async () => {
        noteSettlementCoordinationMainPoolAccessV1('pool:main')
      },
    )
  } catch (error) {
    note = `threw:${String((error as { code?: unknown } | null)?.code ?? 'unknown')}`
  }
  const counted = settlementCoordinationNestedMainPoolAccessesV1()
  const initial = setSettlementCoordinationNestingModeV1('count')
  process.stdout.write(`MODE_PROBE ${note} ${counted} ${initial}\n`)
}

void main()

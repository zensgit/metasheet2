/**
 * D-2 — PRODUCTION-WIRING guard for the OD-7 transaction contract (+ the §1.5 nesting rule and the
 * runtime transactionality precondition). Durable structural guard, in the idiom of
 * `multitable-record-lock-guard.guard.test.ts`.
 *
 * ## Why this file exists (independent review of #4168, P2-1)
 *
 * The D-2 flag-on delete REORDERS its writes: capture → `DELETE FROM meta_links` → delete revision →
 * trash INSERT → `DELETE FROM meta_records`. That ordering is safe ONLY inside a transaction. If a
 * caller runs it without one, a failure at the trash INSERT leaves the record ALIVE, both link
 * directions PERMANENTLY GONE, and a delete revision claiming the record is dead — irrecoverable, and
 * precisely the half-state D-1's delete-then-emit ordering was designed to avoid.
 *
 * The lock's OD-7 asserted this was "CI-guarded by G3". **It was not.** G3 does not drive the production
 * wiring — it RE-IMPLEMENTS it (the goldens wrap the call in their own `poolManager.get().transaction`
 * and supply their own `transaction` dep). The reviewer proved the gap with two production-source
 * mutations that left ALL 39 goldens green:
 *
 *   PROBE-1  `src/index.ts` — unwrap the SDK `deleteRecord`'s `poolManager.get().transaction(...)`
 *   PROBE-2  `src/multitable/automation-service.ts` — stop supplying `deps.transaction`
 *
 * Defence is now two-layered, and BOTH layers are required (the lock's OD-7 errata says so explicitly):
 *
 *   LAYER 1 — runtime, fail-closed: `assertTransactionalQuery` (side-door-delete-trash.ts) makes the
 *             reordered path REFUSE to run outside a transaction. It cannot be refactored away silently.
 *             Unit-tested below against fake query fns (no DB needed).
 *   LAYER 2 — this file: the real entry points must actually SUPPLY a transaction. PROBE-1 is covered
 *             structurally (the plugin SDK factory lives inside `MetaSheetServer.createCoreAPI()`, and
 *             constructing the server boots the whole container/plugin stack — it cannot be driven
 *             in-process, so we assert on the production source itself). PROBE-2 is ALSO covered by a
 *             real-DB golden that drives `new AutomationService(...).exec` end-to-end (G15 in
 *             `multitable-d2-sidedoor-delete-recoverability-realdb.test.ts`) — belt and braces.
 *
 * ⇒ Acceptance: PROBE-1 reds `plugin SDK deleteRecord is wrapped…` below; PROBE-2 reds
 *   `AutomationService supplies deps.transaction` below (and G15).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

import {
  assertTransactionalQuery,
  isSideDoorTombstoneCaptureEnabled,
  MultitableSideDoorDeleteNonTransactionalError,
} from '../../src/multitable/side-door-delete-trash'

const SRC = join(__dirname, '../../src')
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')

/** A fake query fn that reports the given transaction ids for successive `txid_current()` calls. */
function fakeQuery(xids: Array<string | undefined>) {
  let i = 0
  return async () => ({ rows: [{ xid: xids[i++] }] })
}

describe('D-2 — OD-7 production-wiring guard (durable structural guard)', () => {
  describe('LAYER 2 — the real entry points must SUPPLY a transaction', () => {
    /**
     * PROBE-1 IS NOT GUARDED HERE — DELIBERATELY. A structural test used to live at this spot asserting
     * that `index.ts`'s SDK `deleteRecord` contains a `poolManager.get().transaction(` within a fixed
     * 1200-char window. It was DEFEATED in re-review: the window's "next sibling key" claim was false, and
     * it passed only because `deleteRecord` happens to be the LAST key in the `records` object today. Add
     * any transactional sibling after it (e.g. `restoreRecord` — the very next thing this recoverability
     * line would add) and the guard went green with the destructive SDK path in NO transaction at all.
     *
     * PROBE-1 is now guarded BEHAVIORALLY, where it cannot be fooled by source layout:
     * `multitable-d2-sidedoor-delete-recoverability-realdb.test.ts` → **G18**, which drives the ACTUAL
     * `MetaSheetServer.createCoreAPI()` SDK factory end-to-end. It reds under PROBE-1 *and* under DEFEAT-1.
     */

    /**
     * CHEAP EXTRA, not the evidence. The real guard for PROBE-2 is behavioral: G15 drives
     * `new AutomationService(...).exec` (production's own deps) end-to-end and reds when the dep is
     * dropped. This assertion is a fast, precise tripwire on the exact production string — no positional
     * window, so it cannot be defeated the way the old PROBE-1 guard was.
     */
    test('AutomationService supplies deps.transaction to its AutomationExecutor (PROBE-2, cheap tripwire)', () => {
      const src = read('multitable/automation-service.ts')
      expect(
        /transaction:\s*async\s*\(handler\)\s*=>\s*poolManager\.get\(\)\.transaction\(/.test(src),
        'PROBE-2: AutomationService no longer supplies deps.transaction. AutomationExecutor.withTransaction ' +
          'SILENTLY falls back to a bare, non-transactional queryFn — so the D-2 delete_record path would run ' +
          'without a transaction and destroy links irrecoverably on a mid-sequence failure.',
      ).toBe(true)
    })

    /**
     * FROZEN allowlist of every file constructing an AutomationExecutor. A NEW construction site fails
     * this test until its transaction disposition is stated — the same "you must declare it" discipline
     * the record-lock guard applies to meta_records mutation sites.
     */
    test('every AutomationExecutor construction has a declared transaction disposition', () => {
      const ALLOWLIST: Record<string, string> = {
        'multitable/automation-service.ts':
          'TRANSACTIONAL — supplies deps.transaction (poolManager.get().transaction), asserted above and driven end-to-end by G15.',
        'routes/multitable-button.ts':
          'SAFE — one construction passes an ALREADY-IN-TRANSACTION query as queryFn (so withTransaction\'s fallback is still inside a txn); the other supplies deps.transaction. Neither can dispatch delete_record anyway: BUTTON_ACTION_POLICY does not whitelist it.',
      }
      // Enumerate for real, from source — a new construction site anywhere under src/ must show up here.
      const { execSync } = require('node:child_process') as typeof import('node:child_process')
      const hits = execSync(`grep -rl "new AutomationExecutor(" "${SRC}" || true`, { encoding: 'utf8' })
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((abs) => abs.slice(SRC.length + 1))
        .sort()

      const undeclared = hits.filter((rel) => ALLOWLIST[rel] === undefined)
      expect(
        undeclared,
        `New AutomationExecutor construction site(s) with no declared transaction disposition: ${undeclared.join(', ')}. ` +
          `AutomationExecutor.withTransaction silently falls back to a NON-transactional queryFn when deps.transaction ` +
          `is absent. If this executor can dispatch delete_record with the D-2 flag on, it MUST supply deps.transaction ` +
          `(or pass an already-in-txn queryFn). Add it to the allowlist with its disposition.`,
      ).toEqual([])

      const stale = Object.keys(ALLOWLIST).filter((rel) => !hits.includes(rel))
      expect(stale, `Allowlist entries that no longer construct an AutomationExecutor: ${stale.join(', ')}`).toEqual([])
    })
  })

  describe('LAYER 1 — the runtime precondition itself (fail-closed, no DB needed)', () => {
    test('same transaction id on both probes ⇒ transactional ⇒ passes', async () => {
      await expect(assertTransactionalQuery(fakeQuery(['4242', '4242']) as never, 'plugin')).resolves.toBeUndefined()
    })

    test('DIFFERENT transaction ids ⇒ NOT in a transaction ⇒ the delete is REFUSED (typed)', async () => {
      // This is exactly what a non-transactional caller looks like: each statement is its own implicit
      // transaction (possibly on a different pooled connection), so the ids differ.
      await expect(
        assertTransactionalQuery(fakeQuery(['4242', '4243']) as never, 'plugin'),
      ).rejects.toBeInstanceOf(MultitableSideDoorDeleteNonTransactionalError)
    })

    test('a malformed/absent txid ⇒ fail-closed (refuse), never assume transactional', async () => {
      await expect(
        assertTransactionalQuery(fakeQuery([undefined, undefined]) as never, 'automation'),
      ).rejects.toBeInstanceOf(MultitableSideDoorDeleteNonTransactionalError)
    })

    test('the error names the lane it refused', async () => {
      await expect(assertTransactionalQuery(fakeQuery(['1', '2']) as never, 'automation')).rejects.toThrow(
        /automation delete/,
      )
    })
  })

  describe('§1.5 — the capture NESTING rule (the one rule the module calls its single source of truth)', () => {
    const on = 'true'
    test('BOTH flags on ⇒ side-door capture enabled', () => {
      expect(
        isSideDoorTombstoneCaptureEnabled({
          MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED: on,
          MULTITABLE_TOMBSTONE_CAPTURE_ENABLED: on,
        } as NodeJS.ProcessEnv),
      ).toBe(true)
    })

    test('CAPTURE on but SIDE_DOOR off ⇒ DISABLED (byte-identity: capture-on alone must change nothing)', () => {
      expect(
        isSideDoorTombstoneCaptureEnabled({ MULTITABLE_TOMBSTONE_CAPTURE_ENABLED: on } as NodeJS.ProcessEnv),
      ).toBe(false)
    })

    test('SIDE_DOOR on but CAPTURE off ⇒ DISABLED (trash + anchor, but no tombstones)', () => {
      expect(
        isSideDoorTombstoneCaptureEnabled({ MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED: on } as NodeJS.ProcessEnv),
      ).toBe(false)
    })

    test('neither ⇒ DISABLED', () => {
      expect(isSideDoorTombstoneCaptureEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    })
  })
})
